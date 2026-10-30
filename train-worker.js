/* TKD-Net train-worker.js (owner: Moneyman)
 * Classic Web Worker. Loads nn.js, store.js, data.js and trains continuously in small slices
 * (~8 ms of work, then setTimeout(0)) so messages (pause/predict/...) are handled promptly.
 * Protocol: see CONTRACT.md.
 *   in : start, pause, resume, reset, predict, export
 *   out: ready, status, progress, eval, saved, prediction, weights, error
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

  var HISTORY_PROGRESS = 500, HISTORY_EVALS = 2000, SAVE_EVERY = 200, PROGRESS_EVERY = 10, EVAL_SEED = 12345;

  var S = {
    phase: 'idle',        // idle | loading | ready | error
    running: false,
    wantPause: false,
    pendingReset: false,
    opts: null,
    net: null,
    rng: null,
    lr: 0.003,
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
    sliceMs: 8
  };

  function post(msg) { try { self.postMessage(msg); } catch (e) { /* page gone */ } }
  function status(state, message) { var m = { type: 'status', state: state }; if (message) m.message = message; post(m); }
  function fatal(message) { S.running = false; S.phase = 'error'; post({ type: 'error', message: message }); status('error', message); }

  function num(v, lo, hi, def, isInt) {
    v = Number(v);
    if (!isFinite(v)) return def;
    if (isInt) v = Math.round(v);
    return Math.min(hi, Math.max(lo, v));
  }

  function mixSeed(a, b) { return (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x632BE5AB, 0x85EBCA77) ^ 0x27D4EB2F) >>> 0; }

  function checkBatch(b, n) {
    var F = TKD.FRAMES * TKD.FEATURES;
    if (!b || !(b.x instanceof Float32Array) || !(b.y instanceof Float32Array)) return 'generateBatch must return Float32Array x and y';
    var bn = b.n == null ? n : b.n;
    if (bn !== n) return 'generateBatch returned n=' + b.n + ', expected ' + n;
    if (b.x.length !== n * F) return 'x length ' + b.x.length + ' != n*FRAMES*FEATURES (' + (n * F) + ')';
    if (b.y.length !== n * TKD.NCLASSES) return 'y length ' + b.y.length + ' != n*NCLASSES (' + (n * TKD.NCLASSES) + ')';
    for (var i = 0; i < b.x.length; i++) if (!isFinite(b.x[i])) return 'x contains a non-finite value at ' + i;
    for (var r = 0; r < n; r++) {
      var s = 0, ones = 0;
      for (var c = 0; c < TKD.NCLASSES; c++) { var v = b.y[r * TKD.NCLASSES + c]; s += v; if (v === 1) ones++; else if (v !== 0) return 'y row ' + r + ' is not one-hot'; }
      if (ones !== 1) return 'y row ' + r + ' is not one-hot';
    }
    return null;
  }

  function newNet(seed) { return new TKD.Net({ seed: seed, hidden: 64, filters: 32 }); }

  function emptyHistory() { return { progress: [], evals: [] }; }
  function validHistory(h) { return h && h.progress && h.progress.length !== undefined && h.evals && h.evals.length !== undefined; }

  function resetCounters() {
    S.epochSteps = 0; S.lossEMA = null; S.accEMA = null;
    S.spsT = now(); S.spsSamples = 0; S.samplesPerSec = 0;
    S.nanStreak = 0; S.lrLowered = false; S.lr = S.opts.lr;
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
      lr: num(o.lr, 1e-6, 0.1, 0.003, false),
      evalEvery: num(o.evalEvery, 1, 100000, 25, true),
      evalSize: num(o.evalSize, 9, 5000, 450, true),
      fresh: !!o.fresh
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
      S.history = validHistory(h) ? h : emptyHistory();
      resetCounters();
      trainRng();
      var eb = TKD.generateBatch(S.opts.evalSize, TKD.makeRng(EVAL_SEED), { split: 'test' });
      var p = checkBatch(eb, S.opts.evalSize);
      if (p) throw new Error('data.js breaks the contract (test split): ' + p);
      S.evalSet = { x: eb.x, y: eb.y, n: S.opts.evalSize };
      S.phase = 'ready';
      post({ type: 'ready', restored: restored, steps: S.step, sessions: S.sessions });
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
    if (initialEval) doEval();
    S.spsT = now(); S.spsSamples = 0;
    schedule();
  }

  function schedule() {
    if (S.timer !== null) return;
    var g = S.gen;
    S.timer = setTimeout(function () { S.timer = null; if (g === S.gen) slice(); }, 0);
  }

  function slice() {
    if (!S.running) return;
    var t0 = now();
    try {
      do { stepOnce(); } while (S.running && now() - t0 < S.sliceMs);
    } catch (e) { fatal('training failed: ' + errMsg(e)); return; }
    if (S.running) schedule();
  }

  function stepOnce() {
    var bs = S.opts.batchSize;
    var b = TKD.generateBatch(bs, S.rng, { split: 'train' }); // fresh data every step
    var r = S.net.trainBatch(b.x, b.y, bs, S.lr);
    if (!isFinite(r.loss)) { handleNaN(); return; }
    S.nanStreak = 0;
    S.step++; S.epochSteps++; S.spsSamples += bs;
    var a = S.lossEMA === null ? 1 : 0.05;
    S.lossEMA = S.lossEMA === null ? r.loss : S.lossEMA + a * (r.loss - S.lossEMA);
    S.accEMA = S.accEMA === null ? r.acc : S.accEMA + a * (r.acc - S.accEMA);
    if (S.step % PROGRESS_EVERY === 0) {
      var t = now(), dt = (t - S.spsT) / 1000;
      if (dt > 0) S.samplesPerSec = Math.round(S.spsSamples / dt);
      S.spsT = t; S.spsSamples = 0;
      var pm = { type: 'progress', step: S.step, epochSteps: S.epochSteps, loss: r.loss, acc: r.acc,
        lossEMA: S.lossEMA, accEMA: S.accEMA, samplesPerSec: S.samplesPerSec };
      post(pm);
      S.history.progress.push({ step: S.step, loss: r.loss, acc: r.acc, lossEMA: S.lossEMA, accEMA: S.accEMA });
      if (S.history.progress.length > HISTORY_PROGRESS) S.history.progress.splice(0, S.history.progress.length - HISTORY_PROGRESS);
    }
    if (S.step % S.opts.evalEvery === 0) doEval();
    if (S.step % SAVE_EVERY === 0) save();
  }

  function handleNaN() {
    S.nanStreak++;
    if (S.nanStreak >= 5) { fatal('loss is NaN repeatedly at step ' + S.step + '; training stopped'); return; }
    if (S.lastGood) { try { S.net.setWeights(S.lastGood); } catch (e) { S.net = newNet(99 + S.step); } }
    else S.net = newNet(99 + S.step);
    S.net.resetOptimizer();
    var msg = 'loss became NaN at step ' + S.step + ': restored last good weights and reset the optimiser';
    if (!S.lrLowered) { S.lr = S.lr * 0.3; S.lrLowered = true; msg += ', learning rate lowered to ' + S.lr.toPrecision(2); }
    status('training', msg);
  }

  function doEval() {
    if (!S.net || !S.evalSet) return;
    var r = S.net.evaluate(S.evalSet.x, S.evalSet.y, S.evalSet.n);
    if (isFinite(r.loss)) S.lastGood = S.net.getWeights();
    post({ type: 'eval', step: S.step, loss: r.loss, acc: r.acc, perClass: r.perClass, confusion: r.confusion });
    var ev = S.history.evals;
    ev.push({ step: S.step, acc: r.acc, loss: r.loss });
    if (ev.length > HISTORY_EVALS) { // thin the older half so storage stays small but the whole curve remains
      var keep = [];
      for (var i = 0; i < ev.length; i++) if (i % 2 === 0 || i >= ev.length - HISTORY_EVALS / 2) keep.push(ev[i]);
      S.history.evals = keep;
    }
  }

  function save() {
    if (!S.net || !store.available) return S.saveChain;
    var w = S.net.getWeights(), step = S.step;
    var hist = { progress: S.history.progress.slice(), evals: S.history.evals.slice() };
    S.saveChain = S.saveChain.then(function () {
      return store.saveWeights(w, step);
    }).then(function (res) {
      if (res) post({ type: 'saved', step: res.step, bytes: res.bytes, at: res.at });
      return store.saveHistory(hist);
    }).catch(function () { return null; });
    return S.saveChain;
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
    S.resets++;
    S.wantPause = false;
    S.saveChain = S.saveChain.then(function () { return store.clear(); });
    S.net = newNet(1 + S.resets * 7919);
    S.step = 0; S.lastGood = null;
    S.history = emptyHistory();
    resetCounters();
    trainRng();
    post({ type: 'ready', restored: false, steps: 0, sessions: S.sessions });
    begin(true);
  }

  function reset() {
    if (S.phase === 'loading') { S.pendingReset = true; return; }
    if (S.phase !== 'ready') return;
    doReset();
  }

  function predict(m) {
    var id = m.id;
    var L = TKD.FRAMES * TKD.FEATURES;
    var uniform = []; for (var i = 0; i < (TKD.NCLASSES || 9); i++) uniform.push(1 / (TKD.NCLASSES || 9));
    if (!S.net || S.phase !== 'ready') { post({ type: 'prediction', id: id, probs: uniform, top: -1, ready: false }); return; }
    var x = m.x;
    if (!x || x.length !== L) { post({ type: 'prediction', id: id, probs: uniform, top: -1, ready: true, error: 'x must have FRAMES*FEATURES = ' + L + ' values' }); return; }
    if (!(x instanceof Float32Array)) x = new Float32Array(x);
    for (i = 0; i < L; i++) if (!isFinite(x[i])) { post({ type: 'prediction', id: id, probs: uniform, top: -1, ready: true, error: 'x contains non-finite values' }); return; }
    var p = S.net.predict(x), probs = [], top = 0;
    for (i = 0; i < p.length; i++) { probs.push(p[i]); if (p[i] > p[top]) top = i; }
    post({ type: 'prediction', id: id, probs: probs, top: top, ready: true });
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
        default: break;
      }
    } catch (err) { fatal(m.type + ' failed: ' + errMsg(err)); }
  };

  // test hook (harmless in the browser)
  self.__tkdWorkerState = S;
})();
