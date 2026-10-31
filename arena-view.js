/* TKD-Net Arena view (Kai). Classic script, no dependencies; Three.js + rig3d.js are loaded lazily after first paint.
   Talks ONLY to arena-worker.js through the messages in ARENA-CONTRACT.md v1. ?demo = scripted dummy match for layout
   testing (clearly labelled, no learning, no Elo). ?demo=sim also loads arena-sim.js and runs scripted bots in the page. */
(function () {
  'use strict';
  var TKD = window.TKD = window.TKD || {};
  var POSES = {"ready-stance":[[0,-1.375,0.18],[0.06,-1.455,0.12],[-0.06,-1.455,0.12],[0.12,-1.415,0.0],[-0.12,-1.415,0.0],[0.28,-1.0,0.0],[-0.28,-1.0,0.0],[0.32,-0.562,-0.312],[-0.32,-0.562,0.312],[0.26,-0.25,-0.188],[-0.26,-0.25,0.188],[0.17,0.0,0.0],[-0.17,0.0,0.0],[0.2,0.688,-0.219],[-0.2,0.688,0.219],[0.22,1.438,-0.312],[-0.22,1.438,0.375]],"front-kick":[[0,-1.375,0.18],[0.06,-1.455,0.12],[-0.06,-1.455,0.12],[0.12,-1.415,0.0],[-0.12,-1.415,0.0],[0.28,-1.0,0.0],[-0.28,-1.0,0.0],[0.32,-0.438,-0.375],[-0.32,-0.438,0.375],[0.26,-0.688,-0.312],[-0.26,-0.688,0.375],[0.17,0.0,0.0],[-0.17,0.0,0.0],[0.2,0.688,-0.219],[-0.2,0.0,0.5],[0.22,1.438,-0.312],[-0.22,-0.312,1.125]],"roundhouse-kick":[[0,-1.312,-0.195],[0.06,-1.393,-0.255],[-0.06,-1.393,-0.255],[0.12,-1.353,-0.375],[-0.12,-1.353,-0.375],[0.28,-0.938,-0.25],[-0.28,-0.938,-0.25],[0.32,-0.688,-0.562],[-0.32,-0.562,0.312],[0.26,-1.0,-0.625],[-0.26,-0.25,0.188],[0.17,0.0,-0.125],[-0.17,0.0,-0.125],[0.2,0.688,-0.219],[-0.2,-0.312,0.625],[0.22,1.438,-0.312],[-0.22,-0.562,1.312]],"side-kick":[[0,-0.938,-0.633],[0.06,-1.018,-0.693],[-0.06,-1.018,-0.693],[0.12,-0.978,-0.812],[-0.12,-0.978,-0.812],[0.28,-0.688,-0.562],[-0.28,-0.688,-0.562],[0.32,-0.375,-0.75],[-0.32,-0.562,0.312],[0.26,-0.625,-0.625],[-0.26,-0.25,0.188],[0.17,0.062,-0.188],[-0.17,0.062,-0.188],[0.2,0.75,-0.25],[-0.2,0.0,0.562],[0.22,1.438,-0.25],[-0.22,-0.062,1.375]],"punch":[[0,-1.375,0.18],[0.06,-1.455,0.12],[-0.06,-1.455,0.12],[0.12,-1.415,0.0],[-0.12,-1.415,0.0],[0.28,-1.0,0.0],[-0.28,-1.0,0.0],[0.32,-0.438,-0.312],[-0.32,-0.688,0.688],[0.26,-0.188,-0.125],[-0.26,-0.688,1.312],[0.17,0.0,0.0],[-0.17,0.0,0.0],[0.2,0.75,-0.375],[-0.2,0.75,0.375],[0.22,1.438,-0.625],[-0.22,1.438,0.625]],"high-block":[[0,-1.375,0.18],[0.06,-1.455,0.12],[-0.06,-1.455,0.12],[0.12,-1.415,0.0],[-0.12,-1.415,0.0],[0.28,-1.0,0.0],[-0.28,-1.0,0.0],[0.32,-0.688,-0.188],[-0.32,-0.625,0.25],[0.26,-1.0,0.188],[-0.26,-0.938,0.375],[0.17,0.0,0.0],[-0.17,0.0,0.0],[0.2,0.75,-0.312],[-0.2,0.75,0.312],[0.22,1.438,-0.5],[-0.22,1.438,0.5]],"low-block":[[0,-1.375,0.18],[0.06,-1.455,0.12],[-0.06,-1.455,0.12],[0.12,-1.415,0.0],[-0.12,-1.415,0.0],[0.28,-1.0,0.0],[-0.28,-1.0,0.0],[0.32,-0.312,-0.438],[-0.32,-0.438,0.312],[0.26,0.312,-0.625],[-0.26,-0.125,0.188],[0.17,0.0,0.0],[-0.17,0.0,0.0],[0.2,0.75,-0.375],[-0.2,0.75,0.375],[0.22,1.438,-0.625],[-0.22,1.438,0.625]],"hit":[[0,-1.312,-0.32],[0.06,-1.393,-0.38],[-0.06,-1.393,-0.38],[0.12,-1.353,-0.5],[-0.12,-1.353,-0.5],[0.28,-0.938,-0.375],[-0.28,-0.938,-0.375],[0.32,-0.625,-0.625],[-0.32,-0.688,-0.062],[0.26,-1.0,-0.688],[-0.26,-1.0,0.062],[0.17,0.0,-0.125],[-0.17,0.0,-0.125],[0.2,0.688,-0.188],[-0.2,0.75,0.188],[0.22,1.438,-0.25],[-0.22,1.438,0.375]],"back-kick":[[0,-0.875,0.93],[0.06,-0.955,0.87],[-0.06,-0.955,0.87],[0.12,-0.915,0.75],[-0.12,-0.915,0.75],[0.28,-0.625,0.5],[-0.28,-0.625,0.5],[0.32,-0.312,0.688],[-0.32,-0.312,0.312],[0.26,-0.125,0.5],[-0.26,-0.125,0.25],[0.17,0.062,0.062],[-0.17,0.062,0.062],[0.2,0.75,0.156],[-0.2,0.062,-0.438],[0.22,1.438,0.188],[-0.22,0.0,-1.25]],"axe-kick":[[0,-1.312,0.055],[0.06,-1.393,-0.005],[-0.06,-1.393,-0.005],[0.12,-1.353,-0.125],[-0.12,-1.353,-0.125],[0.28,-0.938,-0.062],[-0.28,-0.938,-0.062],[0.32,-0.812,-0.438],[-0.32,-0.562,0.312],[0.26,-0.562,-0.438],[-0.26,-0.25,0.188],[0.17,0.0,0.0],[-0.17,0.0,0.0],[0.2,0.688,-0.219],[-0.2,-0.688,0.312],[0.22,1.438,-0.312],[-0.22,-1.5,0.5]]};
  var WORKER_URL = (document.querySelector('meta[name="tkd-arena-worker"]') || {}).content || 'arena/arena-worker.js';

  // ===================== contract adapter =====================
  var handlers = {};
  var B = {
    worker: null, mode: 'none', ackEpoch: null, resetPending: false, resetTimer: null,
    on: function (t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    emit: function (m) { var l = handlers[m.type] || []; for (var i = 0; i < l.length; i++) { try { l[i](m); } catch (e) { if (window.console) console.warn('[arena-ui]', m.type, e); } } },
    send: function (m) { if (B.worker) B.worker.postMessage(m); },
    accept: function (m) { // drop stale messages after reset (epoch), acks: resetDone / ready
      if (!m || typeof m.type !== 'string') return false;
      var ack = m.type === 'resetDone' || m.type === 'ready';
      if (isFinite(m.epoch)) {
        if (ack && (B.ackEpoch == null || m.epoch >= B.ackEpoch)) { B.ackEpoch = +m.epoch; B.clearPending(); return true; }
        if (B.ackEpoch != null && m.epoch < B.ackEpoch) return false;
      } else if (ack) { B.clearPending(); return true; }
      if (B.resetPending && m.type !== 'error') return false;
      return true;
    },
    clearPending: function () { B.resetPending = false; if (B.resetTimer) { clearTimeout(B.resetTimer); B.resetTimer = null; } },
    reset: function () { B.resetPending = true; if (B.resetTimer) clearTimeout(B.resetTimer); B.resetTimer = setTimeout(B.clearPending, 3000); B.send({ type: 'reset' }); },
    connect: function () {
      var q = location.search;
      if (/[?&]demo\b/.test(q)) { B.mode = 'demo'; B.worker = makeDemo(/[?&]demo=sim\b/.test(q)); }
      else if (typeof Worker === 'undefined') { B.emit({ type: 'error', message: 'This browser cannot run Web Workers, so the arena cannot run here.' }); return false; }
      else {
        try { B.worker = new Worker(WORKER_URL); B.mode = 'worker'; }
        catch (e) { B.emit({ type: 'error', message: 'Could not start ' + WORKER_URL + ': ' + e.message }); return false; }
        B.worker.onerror = function (e) { B.emit({ type: 'error', message: (e && e.message) || ('The arena worker (' + WORKER_URL + ') did not load.') }); if (e && e.preventDefault) e.preventDefault(); };
      }
      B.worker.onmessage = function (e) { if (B.accept(e.data)) B.emit(e.data); };
      return true;
    }
  };

  // ---- demo: a scripted dummy match (layout testing only; never sends learn/elo) ----
  function makeDemo(useSim) {
    var self = { onmessage: null }, timer = null, paused = false, speed = 1, round = 0, sim = null, bots = null, t = 0, wins = [0, 0, 0], obs = null, epoch = 0;
    function post(m) { m.epoch = epoch; setTimeout(function () { self.onmessage && self.onmessage({ data: m }); }, 0); }
    var A = TKD.Arena;
    function realSim() { return useSim && A && A.createSim && A.scripted; }
    function newRound() {
      round++; t = 0;
      if (realSim()) { if (!sim) { sim = A.createSim({ seed: 7, roundSeconds: 60 }); bots = [A.scripted(1, 3), A.scripted(2, 5)]; } obs = sim.reset().obs; }
      else dummy.reset();
    }
    var dummy = (function () {
      var f, ev, phaseT;
      var acts = ['front_kick', 'roundhouse', 'side_kick', 'punch', 'guard', 'block'];
      var slug = { front_kick: 'front-kick', roundhouse: 'roundhouse-kick', side_kick: 'side-kick', punch: 'punch', guard: 'high-block', block: 'low-block', idle: 'ready-stance', hitstun: 'ready-stance' };
      function F(x, yaw) { return { x: x, y: 0, z: 0, yaw: yaw, action: 'idle', pose: 'ready-stance', phase: 'none', phaseProgress: 0, health: 100, stamina: 1, points: 0, hits: 0 }; }
      return {
        reset: function () { f = [F(-1.6, 0), F(1.6, Math.PI)]; ev = []; phaseT = [0, 0]; },
        step: function (dt) {
          ev = []; var ang = t * 0.25, r = 1.1 + 0.35 * Math.sin(t * 0.7);
          f[0].x = -Math.cos(ang) * r; f[0].z = -Math.sin(ang) * r; f[1].x = Math.cos(ang) * r; f[1].z = Math.sin(ang) * r;
          f[0].yaw = Math.atan2(f[1].z - f[0].z, f[1].x - f[0].x); f[1].yaw = f[0].yaw + Math.PI;
          for (var i = 0; i < 2; i++) {
            var g = f[i]; phaseT[i] += dt;
            var cyc = (t + i * 1.3) % 2.6, k = Math.floor((t + i * 1.3) / 2.6) % acts.length, a = cyc < 1.2 ? acts[(k + i * 2) % acts.length] : 'idle';
            g.action = a; g.pose = slug[a];
            if (a === 'idle') { g.phase = 'none'; g.phaseProgress = 0; g.stamina = Math.min(1, g.stamina + dt * 0.05); }
            else { var p = cyc / 1.2; g.phaseProgress = p; g.phase = p < 0.35 ? 'startup' : p < 0.6 ? 'active' : 'recovery'; g.stamina = Math.max(0.1, g.stamina - dt * 0.04);
              if (a !== 'guard' && a !== 'block' && Math.abs(p - 0.45) < dt / 1.2 / 2) { var d = 6; f[1 - i].health = Math.max(5, f[1 - i].health - d); g.points += 1; g.hits++; ev.push({ type: Math.random() < 0.2 ? 'counter' : 'hit', by: i, tech: a, damage: d, points: 1 }); } }
          }
        },
        state: function () { return { t: +t.toFixed(2), round: round, roundSeconds: 60, timeLeft: +(60 - t).toFixed(2), mat: { size: 8, bodyRadius: 0.3 }, fighters: f.map(function (g) { var o = {}; for (var k in g) o[k] = g[k]; return o; }), score: [f[0].points, f[1].points], wins: wins.slice(), done: t >= 60, winner: -1, events: ev.slice() }; }
      };
    })();
    function tick() {
      if (paused) return;
      var steps = speed === 'fast' ? 12 : speed === 2 ? 2 : 1, st, done = false, winner = 0;
      for (var s = 0; s < steps && !done; s++) {
        t += 0.1;
        if (realSim()) {
          var acts = [bots[0](obs[0], sim.actionMask ? sim.actionMask(0) : null), bots[1](obs[1], sim.actionMask ? sim.actionMask(1) : null)];
          var r = sim.step(acts[0], acts[1]); obs = r.obs; done = r.done; winner = r.info.winner;
        } else { dummy.step(0.1); done = t >= 60; if (done) { var st0 = dummy.state(); winner = st0.score[0] > st0.score[1] ? 1 : st0.score[1] > st0.score[0] ? 2 : 0; } }
      }
      st = realSim() ? sim.state() : dummy.state();
      post({ type: 'frame', round: round, t: st.t, state: st });
      if (done) {
        wins[winner === 1 ? 0 : winner === 2 ? 1 : 2]++;
        post({ type: 'round', round: round, live: true, winner: winner, hits: [st.fighters[0].hits || 0, st.fighters[1].hits || 0], damage: [0, 0], reward: [0, 0], steps: 600 });
        post({ type: 'stats', roundsPerSec: 0, stepsPerSec: steps * 10, practiceRounds: 0, liveRounds: round, wins: wins.slice() });
        newRound();
      }
    }
    self.postMessage = function (m) {
      if (m.type === 'start') {
        newRound();
        post({ type: 'ready', restored: false, rounds: 0, sessions: 1, obsDim: 0, numActions: 0, actions: [], params: [0, 0], layers: [] });
        post({ type: 'status', state: 'running', practice: false, speed: speed, message: 'Demo: scripted dummy match, no learning' });
        timer = setInterval(tick, 100);
      } else if (m.type === 'pause') { paused = true; post({ type: 'status', state: 'paused', practice: false, speed: speed }); }
      else if (m.type === 'resume') { paused = false; post({ type: 'status', state: 'running', practice: false, speed: speed, message: 'Demo: scripted dummy match, no learning' }); }
      else if (m.type === 'speed') { speed = m.speed; post({ type: 'status', state: paused ? 'paused' : 'running', practice: false, speed: speed, message: 'Demo: scripted dummy match, no learning' }); }
      else if (m.type === 'reset') { epoch++; round = 0; wins = [0, 0, 0]; sim = null; post({ type: 'resetDone' }); newRound(); post({ type: 'ready', restored: false, rounds: 0, sessions: 1, actions: [], params: [0, 0], layers: [] }); }
    };
    self.terminate = function () { clearInterval(timer); };
    return self;
  }

  // ===================== page state =====================
  function $(id) { return document.getElementById(id); }
  var reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var S = { state: 'loading', speed: 1, userPaused: false, prev: null, cur: null, tPrev: 0, tCur: 0, interval: 100, lastStep: -1,
    elo: [], actions: [], rounds: 0, wins: [0, 0, 0], lastEnd: null, sparks: [] };

  // ---------- status / controls ----------
  var STATE_TEXT = { loading: 'Loading…', running: 'Fighting now', paused: 'Paused', error: 'Error' };
  function setStatus(st, msg) {
    S.state = st; $('status').setAttribute('data-state', st); $('statusText').textContent = STATE_TEXT[st] || st;
    if (msg) $('stageMsg').textContent = msg;
    $('stageMsg').hidden = !(st === 'error' || st === 'loading' || (msg && B.mode === 'demo' && false));
    var pb = $('btnPause'); pb.disabled = !(st === 'running' || st === 'paused'); pb.textContent = st === 'paused' ? 'Resume' : 'Pause';
    $('btnReset').disabled = st === 'loading' || st === 'error';
  }
  $('btnPause').addEventListener('click', function () { if (S.state === 'paused') { S.userPaused = false; B.send({ type: 'resume' }); } else { S.userPaused = true; B.send({ type: 'pause' }); } });
  function setSpeed(sp) { S.speed = sp; $('sp1').setAttribute('aria-pressed', sp === 1 ? 'true' : 'false'); $('spFast').setAttribute('aria-pressed', sp === 'fast' ? 'true' : 'false'); B.send({ type: 'speed', speed: sp }); }
  $('sp1').addEventListener('click', function () { setSpeed(1); });
  $('spFast').addEventListener('click', function () { setSpeed('fast'); });
  $('practice').addEventListener('change', function (e) { B.send({ type: 'practice', on: !!e.target.checked }); });
  $('btnReset').addEventListener('click', function () {
    if (!confirm('Reset the arena? Both fighters forget everything they learned, and the Elo history is cleared.')) return;
    S.elo = []; S.prev = S.cur = null; S.lastStep = -1; S.wins = [0, 0, 0]; S.sparks.length = 0; eloDirty = true; $('eloGain').textContent = 'waiting for the worker\'s benchmark'; $('eloNow').textContent = '';
    B.reset();
  });
  // ---------- save on leave (contract: `flush` -> worker replies `saved {rounds, bytes, at}`) ----------
  // Hidden tab, pagehide and beforeunload each send `flush` (de-duplicated within 400 ms, since they often fire together).
  // In-page links that leave the arena send `flush`, wait for the next `saved` (max FLUSH_WAIT_MS) and then navigate.
  var FLUSH_WAIT_MS = 1500, lastFlush = 0, savedWaiters = [], navigating = false;
  function flushNow(force) {
    if (B.mode !== 'worker' || !B.worker) return false;
    var t = Date.now(); if (!force && t - lastFlush < 400) return false;
    lastFlush = t; B.send({ type: 'flush' }); return true;
  }
  function flushAndWait(ms) { // resolves true on the next accepted `saved`, false on timeout / no worker
    return new Promise(function (resolve) {
      if (B.mode !== 'worker' || !B.worker) { resolve(false); return; }
      var done = false, w = function (ok) { if (done) return; done = true; clearTimeout(timer); var i = savedWaiters.indexOf(w); if (i >= 0) savedWaiters.splice(i, 1); resolve(ok); };
      var timer = setTimeout(function () { w(false); }, ms || FLUSH_WAIT_MS);
      savedWaiters.push(w); flushNow(true);
    });
  }
  function leave() { flushNow(false); }
  window.addEventListener('pagehide', leave);
  window.addEventListener('beforeunload', leave);
  window.addEventListener('pageshow', function (e) { if (e.persisted) { navigating = false; document.documentElement.removeAttribute('data-leaving'); } });
  document.addEventListener('visibilitychange', function () { if (document.hidden) leave(); else { lastT = 0; kick(); } });
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    var href = a.href, here = location.href.split('#')[0];
    if (!href || /^(javascript|mailto|tel):/i.test(href) || href.split('#')[0] === here) return; // same-page anchor: nothing to save
    if (B.mode !== 'worker' || !B.worker) return;
    e.preventDefault();
    if (navigating) return;
    navigating = true; document.documentElement.setAttribute('data-leaving', '');
    var sv = $('sSaved'); if (sv) sv.textContent = 'saving…';
    flushAndWait(FLUSH_WAIT_MS).then(function () { location.href = href; });
  }, true);

  // ---------- worker messages ----------
  B.on('ready', function (m) {
    if (B.mode === 'demo') $('demoBanner').hidden = false;
    S.actions = m.actions || []; S.rounds = m.rounds || 0;
    if (m.params) $('sParams').textContent = [].concat(m.params).map(fmtInt).join(' / ');
    $('sRounds').textContent = fmtInt(S.rounds);
    $('practice').disabled = B.mode === 'demo';
  });
  B.on('resetDone', function () { S.elo = []; eloDirty = true; });
  B.on('status', function (m) {
    var st = m.state === 'running' ? 'running' : m.state;
    setStatus(st, m.message);
    if (m.speed != null) { S.speed = m.speed === 'fast' ? 'fast' : +m.speed || 1; $('sp1').setAttribute('aria-pressed', S.speed === 1 ? 'true' : 'false'); $('spFast').setAttribute('aria-pressed', S.speed === 'fast' ? 'true' : 'false'); }
    if (typeof m.practice === 'boolean' && B.mode !== 'demo') $('practice').checked = m.practice;
    kick();
  });
  B.on('error', function (m) { setStatus('error', m.message || 'Arena error'); $('stageMsg').hidden = false; });
  B.on('frame', function (m) {
    var st = m.state; if (!st || !st.fighters || st.fighters.length < 2) return;
    var now = performance.now();
    if (S.cur) { S.prev = S.cur; S.tPrev = S.tCur; S.interval = Math.max(30, Math.min(250, S.interval * 0.8 + (now - S.tCur) * 0.2)); }
    S.cur = st; S.tCur = now; if (!S.prev) { S.prev = st; S.tPrev = now; }
    if (S.state === 'loading') setStatus('running');
    $('stageMsg').hidden = true;
    var stepKey = st.step != null ? st.step : st.t;
    if (stepKey !== S.lastStep) { S.lastStep = stepKey; if (st.events && st.events.length) st.events.forEach(onEvent); }
    if (st.done) S.lastEnd = st.endReason || null;
    hud(st, m.state.actions); kick();
  });
  B.on('round', function (m) {
    S.rounds = Math.max(S.rounds + 1, m.round || 0); $('sRounds').textContent = fmtInt(S.rounds);
    if (!m.live) return;
    var w = m.winner, txt = w === 1 ? 'Blue wins' : w === 2 ? 'Gold wins' : 'Draw';
    var why = S.lastEnd ? ({ ko: 'knockout', time: 'on points at time', points: 'on points' }[S.lastEnd] || String(S.lastEnd)) : '';
    showBanner(txt, 'Round ' + (m.round || '') + (why ? ' · ' + why : '') + (m.hits ? ' · hits ' + m.hits[0] + '–' + m.hits[1] : ''), w);
  });
  B.on('stats', function (m) {
    if (isFinite(m.roundsPerSec)) $('sRps').textContent = (+m.roundsPerSec).toFixed(2);
    if (isFinite(m.stepsPerSec)) $('sSps').textContent = fmtInt(m.stepsPerSec);
    if (isFinite(m.practiceRounds)) $('sPractice').textContent = fmtInt(m.practiceRounds);
    if (m.wins && m.wins.length >= 2) { S.wins = m.wins.slice(); $('aWins').textContent = m.wins[0]; $('bWins').textContent = m.wins[1]; $('draws').textContent = m.wins[2] || 0; }
  });
  B.on('learn', function (m) {
    var p = m.fighter === 1 ? 'lB' : 'lA';
    $(p + '0').textContent = fmtInt(m.updates); $(p + '1').textContent = fx(m.entropy, 3); $(p + '2').textContent = fx(m.approxKl, 4); $(p + '3').textContent = fx(m.clipFrac, 2);
  });
  B.on('elo', function (m) {
    if (!isFinite(m.a) || !isFinite(m.b)) return;
    S.elo.push({ rounds: +m.rounds || S.elo.length, a: +m.a, b: +m.b, at: +m.at || Date.now() }); if (S.elo.length > 1000) S.elo.shift();
    eloDirty = true; kick();
    $('eloNow').textContent = 'now: Blue ' + Math.round(m.a) + ' · Gold ' + Math.round(m.b);
    if (S.elo.length >= 2) {
      var f = S.elo[0], l = S.elo[S.elo.length - 1], hrs = (l.at - f.at) / 3600000;
      $('eloGain').textContent = hrs > 1 / 60 ? 'gain per hour of training: Blue ' + sgn((l.a - f.a) / hrs) + ' · Gold ' + sgn((l.b - f.b) / hrs) : 'measuring…';
    }
  });
  B.on('saved', function (m) { var ws = savedWaiters.slice(); for (var i = 0; i < ws.length; i++) ws[i](true); });
  B.on('saved', function (m) { $('sSaved').textContent = (m.ok === false ? 'failed' : new Date(m.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); });
  function fmtInt(n) { if (n == null || !isFinite(n)) return '–'; n = Math.round(n); return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
  function fx(v, d) { return v == null || !isFinite(v) ? '–' : (+v).toFixed(d); }
  function sgn(v) { v = Math.round(v); return (v > 0 ? '+' : '') + v; }

  // ---------- HUD ----------
  function hud(st, actions) {
    var f = st.fighters;
    // state() has no maxHealth field; fighters start each round at full health, so use the highest value seen (sim uses 300).
    S.maxHp = Math.max(S.maxHp || 0, +f[0].health || 0, +f[1].health || 0); var maxH = st.maxHealth || S.maxHp || 100;
    ['a', 'b'].forEach(function (p, i) {
      var g = f[i], h = Math.max(0, Math.min(1, (+g.health || 0) / maxH)), s = Math.max(0, Math.min(1, +g.stamina || 0));
      $(p + 'Hp').style.transform = 'scaleX(' + h.toFixed(3) + ')'; $(p + 'HpN').textContent = Math.round(g.health);
      $(p + 'St').style.transform = 'scaleX(' + s.toFixed(3) + ')'; $(p + 'StN').textContent = Math.round(s * 100);
      $(p + 'Act').textContent = String((actions && actions[i]) || g.action || '–').replace(/_/g, ' ');
      $(p + 'Pts').textContent = st.score ? st.score[i] : (g.points || 0);
    });
    var left = st.timeLeft != null ? st.timeLeft : (st.roundSeconds || 60) - (st.t || 0);
    $('timer').textContent = Math.max(0, left).toFixed(1); $('timer').classList.toggle('low', left <= 10);
    $('roundNo').textContent = st.round != null ? st.round : '–';
    if (st.wins) { $('aWins').textContent = st.wins[0]; $('bWins').textContent = st.wins[1]; $('draws').textContent = st.wins[2] || 0; }
  }
  var bannerTimer = null;
  function showBanner(title, sub, w) {
    var b = $('banner'); b.innerHTML = ''; var h = document.createElement('b'); h.textContent = title; var s = document.createElement('span'); s.textContent = sub; b.appendChild(h); b.appendChild(s);
    b.setAttribute('data-w', w); b.hidden = false; b.classList.remove('out'); clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { b.classList.add('out'); bannerTimer = setTimeout(function () { b.hidden = true; }, 500); }, 2600);
  }

  // ---------- events -> sparks (subtle, no flashes) ----------
  function onEvent(e) {
    if (reduced || !e || (e.type !== 'hit' && e.type !== 'counter' && e.type !== 'guarded')) return;
    var st = S.cur, d = st && st.fighters[1 - e.by]; if (!d) return;
    var n = e.type === 'counter' ? 22 : e.type === 'hit' ? 14 : 8, col = e.type === 'guarded' ? [0.85, 0.85, 0.9] : [1, 0.78, 0.35];
    for (var i = 0; i < n; i++) { var a = Math.random() * 6.283, u = Math.random() * 2 - 1, sp = 1.2 + Math.random() * 1.8;
      S.sparks.push({ x: d.x, y: 1.15 + Math.random() * 0.2, z: d.z, vx: Math.cos(a) * Math.sqrt(1 - u * u) * sp, vy: u * sp + 0.8, vz: Math.sin(a) * Math.sqrt(1 - u * u) * sp, life: 0.45 + Math.random() * 0.2, age: 0, c: col }); }
    if (S.sparks.length > 160) S.sparks.splice(0, S.sparks.length - 160);
  }
  function stepSparks(dt) { for (var i = S.sparks.length - 1; i >= 0; i--) { var p = S.sparks[i]; p.age += dt; if (p.age >= p.life) { S.sparks.splice(i, 1); continue; } p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vy -= 6 * dt; } }

  // ---------- interpolation ----------
  function lerp(a, b, k) { return a + (b - a) * k; }
  function lerpAng(a, b, k) { var d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * k; }
  function view(now) { // interpolated fighter positions
    if (!S.cur) return null;
    var k = Math.max(0, Math.min(1, (now - S.tCur) / S.interval)), P = S.prev.fighters, C = S.cur.fighters;
    if (S.prev.round !== S.cur.round) k = 1;
    return C.map(function (c, i) { var p = P[i] || c; return { x: lerp(+p.x, +c.x, k), z: lerp(+p.z || 0, +c.z || 0, k), yaw: lerpAng(+p.yaw || 0, +c.yaw || 0, k), f: c }; });
  }

  // ---------- pose targets (from the art keyframes; Waffle's TKD.poses3d clips win when present) ----------
  var walkT = 0;
  function clipFrame(clip, u) { var n = clip.frameCount || Math.floor(clip.frames.length / 51), idx = Math.max(0, Math.min(n - 1, Math.round(u * (n - 1)))), o = idx * 51, out = []; for (var j = 0; j < 17; j++) out.push([clip.frames[o + j * 3], clip.frames[o + j * 3 + 1], clip.frames[o + j * 3 + 2]]); return out; }
  function poseTarget(f) {
    var slug = f.action === 'hitstun' ? 'hit' : (f.pose || 'ready-stance'), locked = f.phase && f.phase !== 'none';
    var u = locked ? Math.max(0, Math.min(1, +f.phaseProgress || 0)) : 0;     // scrub the technique with phaseProgress
    if (!locked && (slug === 'high-block' || slug === 'low-block')) u = 0.45;  // held guard
    var clip = TKD.poses3d && TKD.poses3d[slug], out;
    if (clip && clip.frames) out = clipFrame(clip, u);
    else { // fallback: art keyframes, ready -> peak -> ready over the technique
      var k = slug === 'hit' ? 0.9 : Math.sin(Math.PI * Math.min(1, u * 1.0)); if (!locked && slug !== 'hit') k = (slug === 'high-block' || slug === 'low-block') ? 0.85 : 0;
      var R = POSES['ready-stance'], T = POSES[slug] || R;
      out = R.map(function (r, j) { var t = T[j]; return [lerp(r[0], t[0], k), lerp(r[1], t[1], k), lerp(r[2], t[2], k)]; });
    }
    if (f.motion && f.motion !== 'idle' && !locked) { // simple gait from `motion` (y is down in pose space)
      var a = Math.max(0, Math.sin(walkT * 9)) * 0.22, b = Math.max(0, -Math.sin(walkT * 9)) * 0.22;
      out[13][1] -= a; out[15][1] -= a * 1.3; out[14][1] -= b; out[16][1] -= b * 1.3;
    }
    return out;
  }
  function blendPose(cur, tgt, a) { if (!cur) return tgt.map(function (j) { return j.slice(); }); for (var j = 0; j < 17; j++) for (var c = 0; c < 3; c++) cur[j][c] += (tgt[j][c] - cur[j][c]) * a; return cur; }

  // ===================== 2D renderer (fallback; also used until 3D loads) =====================
  var cv = $('stage2d'), ctx = cv.getContext('2d'), COLORS = ['#4f7cf0', '#d4a24a'];
  function size2d() { var r = cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d)); }
  function draw2d(now) {
    var d = cv.width / Math.max(1, cv.getBoundingClientRect().width), W = cv.width / d, H = cv.height / d;
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, W, H);
    var st = S.cur, size = (st && st.mat && st.mat.size) || 8, sc = Math.min(W, H) * 0.86 / size, cx = W / 2, cy = H / 2;
    ctx.fillStyle = '#16202a'; ctx.fillRect(cx - size / 2 * sc, cy - size / 2 * sc, size * sc, size * sc);
    ctx.strokeStyle = '#d4a24a'; ctx.lineWidth = 2; ctx.strokeRect(cx - size / 2 * sc, cy - size / 2 * sc, size * sc, size * sc);
    ctx.strokeStyle = 'rgba(243,234,216,.15)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, 1.0 * sc, 0, 6.283); ctx.stroke();
    ctx.fillStyle = '#c8102e'; ctx.fillRect(cx - 5, cy - 5, 10, 10);
    var v = view(now); if (!v) return;
    var br = (st.mat && st.mat.bodyRadius) || 0.3;
    v.forEach(function (g, i) {
      var x = cx + g.x * sc, y = cy + g.z * sc, f = g.f;
      if (f.phase === 'active' && f.action !== 'guard' && f.action !== 'block') { ctx.fillStyle = i ? 'rgba(212,162,74,.18)' : 'rgba(79,124,240,.18)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 1.2 * sc, g.yaw - 0.4, g.yaw + 0.4); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = COLORS[i]; ctx.beginPath(); ctx.arc(x, y, br * sc, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#f3ead8'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(g.yaw) * br * sc * 1.5, y + Math.sin(g.yaw) * br * sc * 1.5); ctx.stroke();
      if (f.guarding || f.blocking) { ctx.strokeStyle = 'rgba(243,234,216,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, br * sc * 1.35, g.yaw - 0.9, g.yaw + 0.9); ctx.stroke(); }
      ctx.fillStyle = '#f3ead8'; ctx.font = '600 12px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(f.action || '').replace(/_/g, ' '), x, y - br * sc - 8);
    });
    S.sparks.forEach(function (p) { var a = 1 - p.age / p.life; ctx.fillStyle = 'rgba(' + Math.round(p.c[0] * 255) + ',' + Math.round(p.c[1] * 255) + ',' + Math.round(p.c[2] * 255) + ',' + a.toFixed(2) + ')'; ctx.fillRect(cx + p.x * sc - 1.5, cy + p.z * sc - 1.5, 3, 3); });
  }

  // ===================== 3D renderer (lazy) =====================
  var R3 = null;
  function init3D() {
    var THREE = window.THREE, stage = $('stage');
    var renderer = new THREE.WebGLRenderer({ antialias: !PHONE, powerPreference: 'low-power', failIfMajorPerformanceCaveat: !allowSW });
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1)); renderer.setClearColor(0x0a0908, 1);
    var canvas = renderer.domElement; canvas.className = 'stage3d'; canvas.setAttribute('aria-hidden', 'true'); stage.insertBefore(canvas, stage.firstChild);
    var scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x0a0908, 14, 34);
    var cam = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
    scene.add(new THREE.HemisphereLight(0xfff1e0, 0x140d08, 0.95));
    var key = new THREE.DirectionalLight(0xffd7a8, 0.85); key.position.set(4, 9, 5); scene.add(key);
    var rim = new THREE.DirectionalLight(0x8fa8ff, 0.35); rim.position.set(-6, 5, -6); scene.add(rim);
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: 0.95 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; scene.add(floor);
    var matGroup = new THREE.Group(); scene.add(matGroup); var matSize = 0;
    function buildMat(size) {
      if (size === matSize) return; matSize = size; while (matGroup.children.length) { var o = matGroup.children.pop(); o.geometry.dispose(); o.material.dispose(); }
      var m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: 0x1a2632, roughness: 0.85 })); m.rotation.x = -Math.PI / 2; matGroup.add(m);
      var h = size / 2, pts = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(function (p) { return new THREE.Vector3(p[0], 0.01, p[1]); });
      matGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd4a24a })));
      var ring = new THREE.Mesh(new THREE.RingGeometry(0.98, 1.02, 64), new THREE.MeshBasicMaterial({ color: 0x3a4652 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012; matGroup.add(ring);
      var seal = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), new THREE.MeshBasicMaterial({ color: 0xc8102e })); seal.rotation.x = -Math.PI / 2; seal.rotation.z = 0.07; seal.position.y = 0.013; matGroup.add(seal);
    }
    var SCALE = 0.58, HIP = 1.44 * SCALE;
    var fighters = [{ body: 0xdfe6ff, legs: 0x3b6cf0 }, { body: 0xfff0d8, legs: 0xd4a24a }].map(function (c) {
      var outer = new THREE.Group(), rig = new TKD3D.Rig(THREE, { body: c.body, legs: c.legs, radius: 0.08 });
      rig.group.scale.setScalar(SCALE); rig.group.position.y = HIP; outer.add(rig.group);
      var sh = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })); sh.rotation.x = -Math.PI / 2; sh.position.y = 0.015; outer.add(sh);
      var ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.42, 32), new THREE.MeshBasicMaterial({ color: c.legs, transparent: true, opacity: 0.85, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.017; outer.add(ring);
      scene.add(outer); return { outer: outer, rig: rig, pose: null };
    });
    var sparkGeo = new THREE.BufferGeometry(), sparkPos = new Float32Array(160 * 3), sparkCol = new Float32Array(160 * 3);
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3)); sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
    var sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); scene.add(sparks);
    var camMode = 'broadcast', orbit = { az: 0.6, el: 0.55, dist: 10 }, camPos = new THREE.Vector3(0, 4, 9), camLook = new THREE.Vector3(), drag = null;
    function size() { var w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); canvas.style.width = '100%'; canvas.style.height = '100%'; cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); }
    canvas.addEventListener('pointerdown', function (e) { if (camMode !== 'orbit') return; drag = { x: e.clientX, y: e.clientY, az: orbit.az, el: orbit.el }; });
    window.addEventListener('pointermove', function (e) { if (!drag) return; orbit.az = drag.az - (e.clientX - drag.x) * 0.008; orbit.el = Math.max(0.15, Math.min(1.25, drag.el + (e.clientY - drag.y) * 0.005)); kick(); });
    window.addEventListener('pointerup', function () { drag = null; });
    canvas.addEventListener('wheel', function (e) { if (camMode !== 'orbit') return; e.preventDefault(); orbit.dist = Math.max(4, Math.min(18, orbit.dist * (e.deltaY > 0 ? 1.08 : 0.92))); kick(); }, { passive: false });
    if (window.ResizeObserver) new ResizeObserver(size).observe(stage); else window.addEventListener('resize', size);
    size();
    return {
      canvas: canvas,
      dispose: function () { renderer.dispose(); canvas.remove(); },
      setCam: function (m) { camMode = m; canvas.style.touchAction = m === 'orbit' ? 'none' : 'pan-y'; },
      draw: function (now, dt) {
        var st = S.cur; buildMat((st && st.mat && st.mat.size) || 8);
        var v = view(now), mid = new THREE.Vector3();
        if (v) v.forEach(function (g, i) {
          var F = fighters[i]; F.outer.position.set(g.x, 0, g.z); F.outer.rotation.y = Math.PI / 2 - g.yaw;
          F.pose = blendPose(F.pose, poseTarget(g.f), reduced ? 1 : 1 - Math.exp(-dt * 16));
          F.rig.setPose(F.pose, true);
          mid.x += g.x / 2; mid.z += g.z / 2;
        });
        // camera
        var tgtPos = new THREE.Vector3(), tgtLook = new THREE.Vector3(mid.x, 0.9, mid.z);
        if (camMode === 'broadcast' && v) {
          var dx = v[1].x - v[0].x, dz = v[1].z - v[0].z, sep = Math.hypot(dx, dz) || 1, nx = -dz / sep, nz = dx / sep;
          if ((camPos.x - mid.x) * nx + (camPos.z - mid.z) * nz < 0) { nx = -nx; nz = -nz; } // stay on the same side
          var dist = Math.max(4.2, Math.min(9, sep * 1.2 + 3.4)) / Math.min(1, cam.aspect * 0.9);
          tgtPos.set(mid.x + nx * dist, 1.9 + dist * 0.18, mid.z + nz * dist);
        } else { tgtPos.set(Math.sin(orbit.az) * Math.cos(orbit.el) * orbit.dist, Math.sin(orbit.el) * orbit.dist, Math.cos(orbit.az) * Math.cos(orbit.el) * orbit.dist); tgtLook.set(0, 0.6, 0); }
        var a = reduced ? 1 : 1 - Math.exp(-dt * 2.5); camPos.lerp(tgtPos, a); camLook.lerp(tgtLook, a);
        cam.position.copy(camPos); cam.lookAt(camLook);
        // sparks
        var n = Math.min(160, S.sparks.length);
        for (var i = 0; i < 160; i++) { var p = S.sparks[i], o = i * 3; if (i < n) { var f = 1 - p.age / p.life; sparkPos[o] = p.x; sparkPos[o + 1] = p.y; sparkPos[o + 2] = p.z; sparkCol[o] = p.c[0] * f; sparkCol[o + 1] = p.c[1] * f; sparkCol[o + 2] = p.c[2] * f; } else { sparkCol[o] = sparkCol[o + 1] = sparkCol[o + 2] = 0; } }
        sparkGeo.attributes.position.needsUpdate = true; sparkGeo.attributes.color.needsUpdate = true; sparkGeo.setDrawRange(0, n);
        renderer.render(scene, cam);
      }
    };
  }
  // 3D perf guard: no software WebGL by default (SwiftShader/llvmpipe ties up the page); opt-in button; fps cap; frame probe.
  var PHONE = (function () { var ua = navigator.userAgent || '', coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches); return /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua) || (coarse && Math.min(screen.width || 9999, screen.height || 9999) < 700); })();
  var FRAME_MS = PHONE ? 50 : 33, allowSW = false;
  function gpuInfo() {
    try {
      var c = document.createElement('canvas'), o = { failIfMajorPerformanceCaveat: true }, caveat = false;
      var gl = c.getContext('webgl2', o) || c.getContext('webgl', o);
      if (!gl) { var c2 = document.createElement('canvas'); gl = c2.getContext('webgl2') || c2.getContext('webgl'); caveat = !!gl; }
      if (!gl) return { gl: false };
      var ext = gl.getExtension('WEBGL_debug_renderer_info'), r = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '');
      var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      return { gl: true, fast: !caveat && !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(r), renderer: r };
    } catch (e) { return { gl: false }; }
  }
  function toast(msg) {
    var t = document.createElement('div'); t.setAttribute('role', 'status'); t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:50;max-width:min(92vw,520px);padding:10px 14px;border-radius:10px;background:#211b16;border:1px solid #2f2620;color:#f3ead8;font-size:.85rem;box-shadow:0 8px 30px rgba(0,0,0,.6)';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 6500);
  }
  var btn3d = null;
  function enableBtn(label, title) {
    if (!btn3d) { btn3d = document.createElement('button'); btn3d.type = 'button'; btn3d.className = 'btn'; btn3d.id = 'btn3d'; $('btnCam').parentNode.insertBefore(btn3d, $('btnCam')); btn3d.addEventListener('click', function () { allowSW = allowSW || btn3d.dataset.sw === '1'; btn3d.hidden = true; fetch3D(); }); }
    btn3d.textContent = label; btn3d.title = title || ''; btn3d.hidden = false;
  }
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = function () { rej(new Error(src)); }; document.head.appendChild(s); }); }
  var camBound = false;
  function load3D() {
    if (/[?&]no3d\b/.test(location.search)) return;
    var g = gpuInfo(); if (!g.gl) return;
    if (!g.fast && !/[?&]3d\b/.test(location.search)) {
      enableBtn('Enable 3D', 'Software graphics detected' + (g.renderer ? ' (' + g.renderer + ')' : '') + ': 3D may be slow here'); btn3d.dataset.sw = '1';
      if (window.console) console.info('[arena-ui] 2D by default: software WebGL', g.renderer || '(caveat)'); return;
    }
    if (!g.fast) allowSW = true;
    fetch3D();
  }
  function fetch3D() {
    var pm = document.querySelector('meta[name="tkd-poses3d"]'), psrc = pm && pm.content;
    (window.THREE && window.TKD3D && TKD3D.Rig ? Promise.resolve() : loadScript('assets/vendor/three.min.js').then(function () { return loadScript('assets/rig3d.js'); }))
      .then(function () { if (psrc && !TKD.poses3d) return loadScript(psrc).catch(function () {}); })
      .then(function () {
        try { R3 = init3D(); } catch (e) { R3 = null; toast('3D is not available here, so the arena is shown in 2D.'); return; }
        $('stage').classList.add('is3d');
        var btn = $('btnCam'); btn.hidden = false; var mode = 'broadcast'; R3.setCam(mode); btn.textContent = 'Camera: ' + mode;
        if (!camBound) { camBound = true; btn.addEventListener('click', function () { if (!R3) return; mode = mode === 'broadcast' ? 'orbit' : 'broadcast'; R3.setCam(mode); btn.textContent = 'Camera: ' + mode; }); }
        kick(); probe3D();
      }).catch(function (e) { R3 = null; if (window.console) console.info('[arena-ui] staying in 2D:', e.message); });
  }
  function drop3D(msg) {
    if (!R3) return; R3.dispose(); R3 = null; $('stage').classList.remove('is3d'); $('btnCam').hidden = true;
    size2d(); kick(); enableBtn('3D view', ''); if (msg) toast(msg);
  }
  // ~2 s frame-time probe after 3D starts: average frame > 50 ms -> 2D + toast
  function probe3D() {
    var n = 0, sum = 0, last = 0, t0 = 0;
    requestAnimationFrame(function f(t) {
      if (!R3) return;
      if (!t0) t0 = t; else { sum += t - last; n++; }
      last = t;
      if (t - t0 < 2000 || document.hidden) { requestAnimationFrame(f); return; }
      if (n && sum / n > 50) drop3D('3D was too slow on this device (' + Math.round(sum / n) + ' ms per frame), so the arena is shown in 2D. Tap "3D view" to try again.');
    });
  }

  // ===================== Elo chart (worker numbers only) =====================
  var ec = $('eloChart'), ectx = ec.getContext('2d'), eloDirty = true;
  function drawElo() {
    eloDirty = false;
    var r = ec.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); ec.width = Math.max(1, Math.round(r.width * d)); ec.height = Math.max(1, Math.round(r.height * d));
    var W = r.width, H = r.height; ectx.setTransform(d, 0, 0, d, 0, 0); ectx.clearRect(0, 0, W, H);
    ectx.font = '11px ui-monospace,Menlo,monospace'; ectx.fillStyle = '#9a8b75';
    if (S.elo.length < 1) { ectx.textAlign = 'center'; ectx.fillText(B.mode === 'demo' ? 'demo mode: no Elo (comes only from the worker)' : 'waiting for the first benchmark (~25 rounds)', W / 2, H / 2); return; }
    var E = S.elo, x0 = E[0].rounds, x1 = E[E.length - 1].rounds, lo = Infinity, hi = -Infinity;
    E.forEach(function (e) { lo = Math.min(lo, e.a, e.b); hi = Math.max(hi, e.a, e.b); });
    if (x1 <= x0) x1 = x0 + 1; var pad = Math.max(20, (hi - lo) * 0.1); lo -= pad; hi += pad;
    var L = 44, Rr = 8, T = 8, Bt = 22, pw = W - L - Rr, ph = H - T - Bt;
    function X(v) { return L + (v - x0) / (x1 - x0) * pw; } function Y(v) { return T + ph - (v - lo) / (hi - lo) * ph; }
    ectx.strokeStyle = '#2f2620'; ectx.textAlign = 'right'; ectx.textBaseline = 'middle';
    for (var i = 0; i <= 3; i++) { var gv = lo + (hi - lo) * i / 3, gy = Y(gv); ectx.beginPath(); ectx.moveTo(L, Math.round(gy) + .5); ectx.lineTo(W - Rr, Math.round(gy) + .5); ectx.stroke(); ectx.fillText(Math.round(gv), L - 6, gy); }
    ectx.textAlign = 'center'; ectx.textBaseline = 'top'; ectx.fillText(fmtInt(x0) + ' rounds', L + 30, H - Bt + 6); ectx.fillText(fmtInt(x1), W - Rr - 14, H - Bt + 6);
    [['a', '#4f7cf0'], ['b', '#d4a24a']].forEach(function (s) { ectx.strokeStyle = s[1]; ectx.lineWidth = 2; ectx.beginPath(); E.forEach(function (e, j) { var px = X(e.rounds), py = Y(e[s[0]]); if (j) ectx.lineTo(px, py); else ectx.moveTo(px, py); }); ectx.stroke(); if (E.length === 1) { ectx.fillStyle = s[1]; ectx.beginPath(); ectx.arc(X(E[0].rounds), Y(E[0][s[0]]), 3, 0, 6.283); ectx.fill(); } });
  }
  if (window.ResizeObserver) new ResizeObserver(function () { eloDirty = true; size2d(); kick(); }).observe(ec);

  // ===================== frame loop (<= 30 fps, idle when nothing moves) =====================
  var raf = 0, lastT = 0;
  function moving() { return !document.hidden && (S.state === 'running' || S.sparks.length > 0); }
  function frame(t) {
    raf = 0; if (document.hidden) return;
    if (moving() && lastT && t - lastT < FRAME_MS - 1) { raf = requestAnimationFrame(frame); return; }
    var dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0.016; lastT = t;
    stepSparks(dt); walkT += dt;
    if (R3) R3.draw(t, dt); else draw2d(t);
    if (eloDirty) drawElo();
    if (moving()) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }

  // ===================== boot =====================
  setStatus('loading'); size2d(); kick();
  function boot() {
    if (B.connect()) B.send({ type: 'start', speed: 1, practice: true, fresh: false });
    else $('stageMsg').hidden = false;
  }
  if (/[?&]demo=sim\b/.test(location.search)) loadScript('arena-sim.js').then(boot, boot); else boot();
  window.addEventListener('load', function () { var go = function () { load3D(); }; if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 1200); });
  window.TKDArena = { bridge: B, state: S, flushAndWait: flushAndWait };
})();
