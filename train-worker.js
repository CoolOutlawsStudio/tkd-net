/* TKD-Net train-worker.js v2 (owner: Moneyman)
 * Classic Web Worker. Loads nn.js, store.js, data.js (data.js BEFORE any net is built, so its TKD.NCLASSES /
 * FRAMES / FEATURES win) and trains continuously in small slices (~8 ms of work, then setTimeout(0)) so messages
 * (pause/predict/...) are handled promptly. The held-out eval is also done in chunks across slices.
 * v2: warmup+cosine LR schedule over the global step (TKD.lrSchedule), training-only augmentation (TKD.augment),
 * extra optional fields on ready/status/progress: params, modelBytes, modelName, lr, stepsPerSec, msPerStep, augment.
 * Protocol: see CONTRACT.md.
 *   in : start, pause, resume, reset, predict, export, flush (v2), viz (v2)
 *   out: ready, status, progress, eval, saved, prediction, weights, error, resetDone (v2), viz (v2)
 *   v2: every outgoing message carries `epoch` (number of resets so far in this worker) so the page can drop stale ones.
 */
/* global self, importScripts */
(function () {
  'use strict';
  var loadErrors = { nn: null, store: null, data: null };
  function errMsg(e) { return (e && e.message) ? e.message : String(e); }

  try { importScripts('nn.js'); } catch (e) { loadErrors.nn = 'nn.js failed to load: ' + errMsg(e); }
  var TKD = self.TKD = self.TKD || {};
  var ownRng = TKD.makeRng;
  try { importScripts('store.js'); } catch (e) { loadErrors.store = 'store.js failed to load: ' + errMsg(e); }
  try { importScripts('data.js'); } catch (e) { loadErrors.data = 'data.js failed to load: ' + errMsg(e); }
  if (ownRng && TKD.makeRng !== ownRng) TKD.makeRng = ownRng; // data.js must not redefine makeRng; nn.js wins
  if (!loadErrors.data && typeof TKD.generateBatch !== 'function') loadErrors.data = 'data.js loaded but TKD.generateBatch is missing';

  // No-op store if store.js failed: training continues without saving.
  if (!TKD.store) {
    var nul = function () { return Promise.resolve(null); };
    TKD.store = { available: false, open: nul, saveWeights: nul, loadWeights: nul, saveHistory: nul, loadHistory: nul,
      loadMeta: nul, incrementSessions: nul, clear: nul };
  }
  var store = TKD.store;

  var now = (self.performance && typeof self.performance.now === 'function')
    ? function () { return self.performance.now(); } : function () { return Date.now(); };

  var HISTORY_PROGRESS = 500, HISTORY_EVALS = 2000, SAVE_EVERY = 40, SAVE_MS = 5000, PROGRESS_EVERY = 10, EVAL_SEED = 12345;
  var DEFAULT_LR = 0.006; // v2 peak lr (benchmarked best on waffle-data-2.0; v1 used 0.003)
  var EVAL_CHUNK = 32, REWARM_STEPS = 20; // eval 32 held-out samples per slice; ramp lr over 20 steps after a restore

  var S = {
    phase: 'idle',        // idle | loading | ready | error
    running: false,
    wantPause: false,
    pendingReset: false,
    opts: null,
    net: null,
    rng: null,
    lr: 0.003,            // current (scheduled) learning rate
    lrScale: 1,           // lowered after a NaN
    restored: false,
    evalJob: null,        // in-progress chunked held-out evaluation
    trainMs: 0, trainSteps: 0, msPerStep: 0, stepsPerSec: 0,
    step: 0,
    epochSteps: 0,
    sessions: 1,
    resets: 0,
    evalSet: null,
    history: { progress: [], evals: [] },
    lossEMA: null, accEMA: null,
    spsT: 0, spsSamples: 0, samplesPerSec: 0,
    timer: null,
    gen: 0,
    lastGood: null,
    nanStreak: 0, lrLowered: false,
    saveChain: Promise.resolve(),
    saving: false, lastSaveT: 0, epoch: 0,
    vizQueue: [], vizTimer: null, lastVizT: -1e9, vizSnap: null, lastInput: null,
    sliceMs: 8
  };

  function post(msg) { if (msg.epoch === undefined) msg.epoch = S.epoch; try { self.postMessage(msg); } catch (e) { /* page gone */ } }
  // v2 optional model/perf fields, added to ready / status / progress (additive; v1 pages ignore them)
  function addInfo(m) {
    if (!S.net) return m;
    m.params = S.net.paramCount(); m.modelBytes = S.net.modelBytes(); m.modelName = TKD.MODEL_NAME || TKD.MODEL_VERSION;
    m.modelVersion = TKD.MODEL_VERSION; m.lr = S.lr; m.stepsPerSec = S.stepsPerSec; m.msPerStep = S.msPerStep;
    m.augment = !!(S.opts && S.opts.augment);
    return m;
  }
  function status(state, message) { var m = { type: 'status', state: state }; if (message) m.message = message; post(addInfo(m)); }
  function fatal(message) { S.running = false; S.phase = 'error'; post({ type: 'error', message: message }); status('error', message); }

  function num(v, lo, hi, def, isInt) {
    v = Number(v);
    if (!isFinite(v)) return def;
    if (isInt) v = Math.round(v);
    return Math.min(hi, Math.max(lo, v));
  }

  function mixSeed(a, b) { return (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x632BE5AB, 0x85EBCA77) ^ 0x27D4EB2F) >>> 0; }

  function checkBatch(b, n) {
    var dm = TKD.dims ? TKD.dims() : { T: TKD.FRAMES, F: TKD.FEATURES, O: TKD.NCLASSES }, F = dm.T * dm.F, NC = dm.O;
    if (!b || !(b.x instanceof Float32Array) || !(b.y instanceof Float32Array)) return 'generateBatch must return Float32Array x and y';
    var bn = b.n == null ? n : b.n;
    if (bn !== n) return 'generateBatch returned n=' + b.n + ', expected ' + n;
    if (b.x.length !== n * F) return 'x length ' + b.x.length + ' != n*FRAMES*FEATURES (' + (n * F) + ')';
    if (b.y.length !== n * NC) return 'y length ' + b.y.length + ' != n*NCLASSES (' + (n * NC) + ')';
    for (var i = 0; i < b.x.length; i++) if (!isFinite(b.x[i])) return 'x contains a non-finite value at ' + i;
    for (var r = 0; r < n; r++) {
      var s = 0, ones = 0;
      for (var c = 0; c < NC; c++) { var v = b.y[r * NC + c]; s += v; if (v === 1) ones++; else if (v !== 0) return 'y row ' + r + ' is not one-hot'; }
      if (ones !== 1) return 'y row ' + r + ' is not one-hot';
    }
    return null;
  }

  function newNet(seed) { return new TKD.Net({ seed: seed, channels: 32, hidden: 64, attnDim: 16 }); }

  function emptyHistory() { return { progress: [], evals: [] }; }
  function validHistory(h) { return h && h.progress && h.progress.length !== undefined && h.evals && h.evals.length !== undefined; }

  function resetCounters() {
    S.epochSteps = 0; S.lossEMA = null; S.accEMA = null;
    S.spsT = now(); S.spsSamples = 0; S.samplesPerSec = 0;
    S.nanStreak = 0; S.lrLowered = false; S.lrScale = 1; S.evalJob = null;
    S.trainMs = 0; S.trainSteps = 0; S.msPerStep = 0; S.stepsPerSec = 0;
    S.lr = currentLr();
  }

  // warmup + cosine over the GLOBAL step (continues across page opens, floor > 0), short re-warmup after a restore
  // because the Adam moments are not saved.
  function currentLr() {
    var base = S.opts.lr, lr = TKD.lrSchedule ? TKD.lrSchedule(S.step, base) : base;
    if (S.restored && S.epochSteps < REWARM_STEPS) lr *= (S.epochSteps + 1) / REWARM_STEPS;
    return lr * S.lrScale;
  }

  function trainRng() { S.rng = TKD.makeRng(mixSeed(S.sessions * 7919 + S.resets, S.step)); }

  // ---------- start ----------
  function start(o) {
    if (S.phase !== 'idle') { // already started: re-announce state
      status(S.phase === 'error' ? 'error' : (S.running ? 'training' : (S.phase === 'loading' ? 'loading' : 'paused')));
      return;
    }
    o = o || {};
    S.opts = {
      batchSize: num(o.batchSize, 1, 512, 64, true),
      lr: num(o.lr, 1e-6, 0.1, DEFAULT_LR, false),
      evalEvery: num(o.evalEvery, 1, 100000, 25, true),
      evalSize: num(o.evalSize, 9, 5000, 450, true),
      fresh: !!o.fresh,
      augment: o.augment !== false && typeof TKD.augment === 'function' // v2: on unless start {augment:false}
    };
    S.phase = 'loading';
    status('loading');
    if (loadErrors.nn) { fatal(loadErrors.nn); return; }
    if (loadErrors.data) { fatal(loadErrors.data); return; }
    var problem;
    try { problem = checkBatch(TKD.generateBatch(4, TKD.makeRng(1), { split: 'train' }), 4); } catch (e) { problem = 'generateBatch threw: ' + errMsg(e); }
    if (problem) { fatal('data.js breaks the contract: ' + problem); return; }

    var restored = false;
    store.open().then(function () {
      return store.incrementSessions();
    }).then(function (meta) {
      S.sessions = (meta && meta.sessions) || 1;
      return S.opts.fresh ? null : store.loadWeights();
    }).then(function (rec) {
      S.net = newNet(1);
      S.step = 0;
      if (rec && rec.weights) {
        try { S.net.setWeights(rec.weights); S.step = rec.step || 0; restored = true; }
        catch (e) { S.net = newNet(1); S.step = 0; }
      }
      return restored ? store.loadHistory() : null;
    }).then(function (h) {
      S.restored = restored;
      S.history = validHistory(h) ? h : emptyHistory();
      resetCounters();
      trainRng();
      var eb = TKD.generateBatch(S.opts.evalSize, TKD.makeRng(EVAL_SEED), { split: 'test' });
      var p = checkBatch(eb, S.opts.evalSize);
      if (p) throw new Error('data.js breaks the contract (test split): ' + p);
      S.evalSet = { x: eb.x, y: eb.y, n: S.opts.evalSize };
      S.phase = 'ready';
      post(addInfo({ type: 'ready', restored: restored, steps: S.step, sessions: S.sessions, layers: layersInfo() }));
      if (S.pendingReset) { S.pendingReset = false; doReset(); return; }
      if (S.wantPause) { S.running = false; doEval(); status('paused'); return; }
      begin(true);
    }).catch(function (e) { fatal('startup failed: ' + errMsg(e)); });
  }

  // initialEval: evaluate right away (first page open shows accuracy immediately, before any step)
  function begin(initialEval) {
    S.running = true;
    S.gen++;
    status('training', store.available ? undefined : 'IndexedDB unavailable: training without saving');
    if (initialEval) startEval();
    S.spsT = now(); S.spsSamples = 0;
    schedule();
  }

  function schedule() {
    if (S.timer !== null) { clearTimeout(S.timer); S.timer = null; } // drop a stale slice from before pause/reset
    var g = S.gen;
    S.timer = setTimeout(function () { S.timer = null; if (g === S.gen) slice(); }, 0);
  }

  function slice() {
    if (!S.running) return;
    var t0 = now();
    try {
      do { if (S.evalJob) evalChunk(); else stepOnce(); } while (S.running && now() - t0 < S.sliceMs);
    } catch (e) { fatal('training failed: ' + errMsg(e)); return; }
    if (S.running) schedule();
  }

  function stepOnce() {
    var bs = S.opts.batchSize;
    var ts = now();
    var b = TKD.generateBatch(bs, S.rng, { split: 'train' }); // fresh data every step
    if (S.opts.augment) TKD.augment(b.x, b.y, bs, S.rng); // training batches only, never the held-out set
    S.lr = currentLr();
    var r = S.net.trainBatch(b.x, b.y, bs, S.lr);
    S.trainMs += now() - ts; S.trainSteps++;
    if (!isFinite(r.loss)) { handleNaN(); return; }
    S.nanStreak = 0;
    S.step++; S.epochSteps++; S.spsSamples += bs;
    var a = S.lossEMA === null ? 1 : 0.05;
    S.lossEMA = S.lossEMA === null ? r.loss : S.lossEMA + a * (r.loss - S.lossEMA);
    S.accEMA = S.accEMA === null ? r.acc : S.accEMA + a * (r.acc - S.accEMA);
    if (S.step % PROGRESS_EVERY === 0) {
      var t = now(), dt = (t - S.spsT) / 1000;
      if (dt > 0) { S.samplesPerSec = Math.round(S.spsSamples / dt); S.stepsPerSec = Math.round(10 * S.spsSamples / bs / dt) / 10; }
      if (S.trainSteps) S.msPerStep = Math.round(100 * S.trainMs / S.trainSteps) / 100;
      S.spsT = t; S.spsSamples = 0; S.trainMs = 0; S.trainSteps = 0;
      var pm = { type: 'progress', step: S.step, epochSteps: S.epochSteps, loss: r.loss, acc: r.acc,
        lossEMA: S.lossEMA, accEMA: S.accEMA, samplesPerSec: S.samplesPerSec };
      post(addInfo(pm));
      S.history.progress.push({ step: S.step, loss: r.loss, acc: r.acc, lossEMA: S.lossEMA, accEMA: S.accEMA });
      if (S.history.progress.length > HISTORY_PROGRESS) S.history.progress.splice(0, S.history.progress.length - HISTORY_PROGRESS);
    }
    if (S.step % S.opts.evalEvery === 0) startEval();
    if (S.step % SAVE_EVERY === 0 || now() - S.lastSaveT >= SAVE_MS) maybeSave();
  }

  function handleNaN() {
    S.nanStreak++;
    if (S.nanStreak >= 5) { fatal('loss is NaN repeatedly at step ' + S.step + '; training stopped'); return; }
    if (S.lastGood) { try { S.net.setWeights(S.lastGood); } catch (e) { S.net = newNet(99 + S.step); } }
    else S.net = newNet(99 + S.step);
    S.net.resetOptimizer();
    var msg = 'loss became NaN at step ' + S.step + ': restored last good weights and reset the optimiser';
    if (!S.lrLowered) { S.lrScale *= 0.3; S.lrLowered = true; S.lr = currentLr(); msg += ', learning rate lowered to ' + S.lr.toPrecision(2); }
    status('training', msg);
  }

  // Chunked held-out evaluation: training waits until the job is done, so eval.step is exact and slices stay short.
  function startEval() {
    if (!S.net || !S.evalSet) return;
    var O = S.net.O, conf = [];
    for (var o = 0; o < O; o++) conf.push(new Array(O).fill(0));
    S.evalJob = { step: S.step, pos: 0, lossSum: 0, confusion: conf };
  }
  function evalChunk() {
    var J = S.evalJob, E = S.evalSet, O = S.net.O, L = S.net.T * S.net.F;
    var m = Math.min(EVAL_CHUNK, E.n - J.pos);
    var r = S.net.evaluate(E.x.subarray(J.pos * L, (J.pos + m) * L), E.y.subarray(J.pos * O, (J.pos + m) * O), m);
    J.lossSum += r.loss * m;
    for (var a = 0; a < O; a++) for (var b = 0; b < O; b++) J.confusion[a][b] += r.confusion[a][b];
    J.pos += m;
    if (J.pos >= E.n) { S.evalJob = null; finishEval(J); }
  }
  function finishEval(J) {
    var O = J.confusion.length, ok = 0, perClass = [];
    for (var a = 0; a < O; a++) {
      var tot = 0; for (var b = 0; b < O; b++) tot += J.confusion[a][b];
      ok += J.confusion[a][a]; perClass.push(tot ? J.confusion[a][a] / tot : 0);
    }
    var n = S.evalSet.n;
    reportEval({ step: J.step, loss: J.lossSum / n, acc: ok / n, perClass: perClass, confusion: J.confusion });
  }
  // Synchronous version (used when not training, e.g. started paused)
  function doEval() {
    if (!S.net || !S.evalSet) return;
    S.evalJob = null;
    var r = S.net.evaluate(S.evalSet.x, S.evalSet.y, S.evalSet.n);
    r.step = S.step;
    reportEval(r);
  }
  function reportEval(r) {
    if (isFinite(r.loss)) S.lastGood = S.net.getWeights();
    post({ type: 'eval', step: r.step, loss: r.loss, acc: r.acc, perClass: r.perClass, confusion: r.confusion });
    var ev = S.history.evals;
    ev.push({ step: r.step, acc: r.acc, loss: r.loss });
    if (ev.length > HISTORY_EVALS) { // thin the older half so storage stays small but the whole curve remains
      var keep = [];
      for (var i = 0; i < ev.length; i++) if (i % 2 === 0 || i >= ev.length - HISTORY_EVALS / 2) keep.push(ev[i]);
      S.history.evals = keep;
    }
  }

  // Periodic save (every SAVE_EVERY steps or SAVE_MS of training, whichever first). Throttled: skipped while an
  // earlier save is still in flight, so IndexedDB writes never pile up. Snapshots are taken synchronously.
  function maybeSave() { if (!S.saving) save(); }
  function save(flush) {
    S.lastSaveT = now();
    if (!S.net || !store.available) {
      if (flush) post({ type: 'saved', step: S.step, bytes: 0, at: Date.now(), ok: false, flush: true });
      return S.saveChain;
    }
    var w = S.net.getWeights(), step = S.step, ep = S.epoch;
    var hist = { progress: S.history.progress.slice(), evals: S.history.evals.slice() };
    S.saving = true;
    S.saveChain = S.saveChain.then(function () {
      if (ep !== S.epoch) return null; // a reset happened since the snapshot: do not resurrect old weights
      return store.saveWeights(w, step);
    }).then(function (res) {
      var m = res ? { type: 'saved', step: res.step, bytes: res.bytes, at: res.at, ok: true }
        : { type: 'saved', step: step, bytes: 0, at: Date.now(), ok: false };
      if (flush) m.flush = true;
      m.epoch = ep;
      if ((res || flush) && ep === S.epoch) post(m); // a reset happened meanwhile: the page must not see a stale saved
      return res && ep === S.epoch ? store.saveHistory(hist) : null;
    }).catch(function () { return null; }).then(function () { S.saving = false; });
    return S.saveChain;
  }
  // flush: save right now (page sends it on pagehide / visibilitychange:hidden). Always replies `saved`.
  function flush() {
    if (S.phase !== 'ready' || !S.net) { post({ type: 'saved', step: S.step, bytes: 0, at: Date.now(), ok: false, flush: true }); return; }
    save(true);
  }

  function pause() {
    if (S.phase !== 'ready') { S.wantPause = true; return; }
    S.wantPause = true;
    if (S.running) { S.running = false; S.gen++; save(); }
    status('paused');
  }

  function resume() {
    S.wantPause = false;
    if (S.phase !== 'ready' || S.running) { if (S.running) status('training'); return; }
    begin();
  }

  function doReset() {
    S.running = false; S.gen++;
    S.resets++; S.epoch = S.resets;
    S.wantPause = false;
    S.saveChain = S.saveChain.then(function () { return store.clear(); });
    S.net = newNet(1 + S.resets * 7919);
    S.step = 0; S.lastGood = null; S.restored = false;
    S.history = emptyHistory();
    resetCounters();
    trainRng();
    post({ type: 'resetDone', epoch: S.epoch }); // everything with a lower epoch is stale
    S.vizSnap = null;
    post(addInfo({ type: 'ready', restored: false, steps: 0, sessions: S.sessions, layers: layersInfo() }));
    begin(true);
  }

  function reset() {
    if (S.phase === 'loading') { S.pendingReset = true; return; }
    if (S.phase !== 'ready') return;
    doReset();
  }

  function predict(m) {
    var id = m.id;
    var dm = TKD.dims ? TKD.dims() : { T: TKD.FRAMES || 16, F: TKD.FEATURES || 34, O: TKD.NCLASSES || 9 };
    var L = dm.T * dm.F;
    var uniform = []; for (var i = 0; i < dm.O; i++) uniform.push(1 / dm.O);
    if (!S.net || S.phase !== 'ready') { post({ type: 'prediction', id: id, probs: uniform, top: -1, ready: false }); return; }
    var x = m.x;
    if (!x || x.length !== L) { post({ type: 'prediction', id: id, probs: uniform, top: -1, ready: true, error: 'x must have FRAMES*FEATURES = ' + L + ' values' }); return; }
    if (!(x instanceof Float32Array)) x = new Float32Array(x);
    for (i = 0; i < L; i++) if (!isFinite(x[i])) { post({ type: 'prediction', id: id, probs: uniform, top: -1, ready: true, error: 'x contains non-finite values' }); return; }
    S.lastInput = x;
    var p = S.net.predict(x), probs = [], top = 0;
    for (i = 0; i < p.length; i++) { probs.push(p[i]); if (p[i] > p[top]) top = i; }
    post({ type: 'prediction', id: id, probs: probs, top: top, ready: true });
  }

  // ---------- viz (v2): forward-only layer snapshot for the page's network picture ----------
  // Runs from its own timer, i.e. BETWEEN training slices, at most once per VIZ_MS; requests in the gap are answered together.
  var VIZ_MS = 100;
  function layersInfo() {
    return S.net ? S.net.layerInfo().map(function (L) { return { name: L.name, shape: L.shape.slice(), params: L.params }; }) : [];
  }
  function viz(m) {
    if (!S.net || S.phase !== 'ready') { post({ type: 'viz', id: m.id, ready: false, layers: [], probs: [], top: -1 }); return; }
    S.vizQueue.push(m);
    if (S.vizTimer !== null) return;
    var wait = Math.max(0, VIZ_MS - (now() - S.lastVizT));
    S.vizTimer = setTimeout(doViz, wait);
  }
  function doViz() {
    S.vizTimer = null;
    var q = S.vizQueue; S.vizQueue = [];
    if (!q.length || !S.net) return;
    S.lastVizT = now();
    var L = S.net.T * S.net.F, last = q[q.length - 1], x = last.x, err;
    if (x && x.length === L) { if (!(x instanceof Float32Array)) x = new Float32Array(x); }
    else { if (x) err = 'x must have FRAMES*FEATURES = ' + L + ' values; used the default sample'; x = S.lastInput || S.evalSet.x.subarray(0, L); }
    for (var i = 0; i < x.length; i++) if (!isFinite(x[i])) { x = S.evalSet.x.subarray(0, L); err = 'x contains non-finite values; used the default sample'; break; }
    var r = S.net.visualize(x, S.vizSnap);
    S.vizSnap = r.snapshot;
    for (var k = 0; k < q.length; k++) {
      var msg = { type: 'viz', id: q[k].id, ready: true, step: S.step, layers: r.layers, probs: r.probs, top: r.top };
      if (err) msg.error = err;
      post(msg);
    }
  }

  function exportWeights() {
    post({ type: 'weights', weights: S.net ? S.net.getWeights() : null, step: S.step });
  }

  self.onmessage = function (e) {
    var m = e && e.data;
    if (!m || typeof m.type !== 'string') return;
    try {
      switch (m.type) {
        case 'start': start(m); break;
        case 'pause': pause(); break;
        case 'resume': resume(); break;
        case 'reset': reset(); break;
        case 'predict': predict(m); break;
        case 'export': exportWeights(); break;
        case 'flush': flush(); break;
        case 'viz': viz(m); break;
        default: break;
      }
    } catch (err) { fatal(m.type + ' failed: ' + errMsg(err)); }
  };

  // test hook (harmless in the browser)
  self.__tkdWorkerState = S;
})();
