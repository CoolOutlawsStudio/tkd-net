/* TKD-Net data.js v2 (owner: Waffle) - synthetic taekwondo pose-sequence generator, MoveNet-realistic.
 * CLASSIC script (no import/export). Works in a Web Worker (importScripts), in the page, and in Node.
 * Contract: TKD.generateBatch(n, rng, opts) -> { n, x: Float32Array(n*FRAMES*FEATURES), y: Float32Array(n*NCLASSES) }
 *   opts.split: 'train' (default) | 'test'  - test draws subjects/cameras/styles from DISJOINT parameter bands.
 *   opts.difficulty: 0..1 (default 0.6 for train, 0.8 for test). 0 = clean studio data, 1 = bad webcam + sloppy form.
 * Uses ONLY the passed rng (never Math.random). Does not define TKD.makeRng (nn.js owns it).
 *
 * Pipeline per sample: hand-written keyframes (joint angles) -> per-subject sloppiness/half-hearted/hesitation ->
 * smooth interpolation with time warp + speed up to 3x -> variable capture fps (8-20, zero-order-hold resample to 16
 * frames, stale duplicate frames) -> 3D forward kinematics on a randomised body -> camera yaw/tilt/roll, distance,
 * perspective, off-centre framing, shake -> MoveNet-style errors: pixel-space jitter (bigger when far / at wrists and
 * ankles, temporally correlated), self-occlusion behind the torso, far-limb occlusion bursts, random dropouts,
 * left/right flicker, keypoints out of frame (feet cropped) -> TKD.normalizeSequence (same function the webcam uses).
 * The 'ready' class also contains hard negatives: idle fidgeting, walking, bouncing in fighting stance, and
 * transitional recovery motion between techniques (none of these must be called a technique).
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};
  // constants: nn.js sets these first in the worker; only fill in when missing (identical values, contract names)
  if (!TKD.CLASSES) TKD.CLASSES = ['ready', 'front_kick', 'roundhouse', 'side_kick', 'back_kick', 'axe_kick', 'low_block', 'high_block', 'punch'];
  if (!TKD.FRAMES) TKD.FRAMES = 16;
  if (!TKD.JOINTS) TKD.JOINTS = 17;
  if (!TKD.FEATURES) TKD.FEATURES = 34;
  if (!TKD.NCLASSES) TKD.NCLASSES = 9;
  if (!TKD.NUM_CLASSES) TKD.NUM_CLASSES = TKD.NCLASSES; // alias
  var CLASSES = TKD.CLASSES, NC = TKD.NCLASSES, F = TKD.FRAMES, J = TKD.JOINTS, FEAT = TKD.FEATURES;
  var D2R = Math.PI / 180;
  var NOSE=0, LEYE=1, REYE=2, LEAR=3, REAR=4, LSH=5, RSH=6, LEL=7, REL=8, LWR=9, RWR=10, LHIP=11, RHIP=12, LKN=13, RKN=14, LAN=15, RAN=16;
  var SWAP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];
  var LIMBS = [[LSH, LEL, LWR], [RSH, REL, RWR], [LHIP, LKN, LAN], [RHIP, RKN, RAN]];
  var EXTREMITY = [1.2, 1.2, 1.2, 1.3, 1.3, 1, 1, 1.4, 1.4, 1.9, 1.9, 1.2, 1.2, 1.4, 1.4, 1.8, 1.8];
  var IMG_W = 640, IMG_H = 480; // virtual webcam frame

  /* ---------- pose model (degrees) ----------
   * Body frame: x = performer's LEFT, y = up, z = the way the performer faces.
   * yaw (+ = counter-clockwise from above), lean (+ = forward), roll (+ = tilt toward left).
   * Legs: f flexion (0 down, 90 forward, <0 back), a abduction, k knee bend. Arms: f flexion (0 down, 90 forward, 180 up),
   * a abduction (- = across the body), e elbow bend. */
  var KEYS = ['yaw','lean','roll','lf','la','lk','rf','ra','rk','laf','laa','lae','raf','raa','rae'], NK = KEYS.length;
  function P(o) { var p = {}; for (var i = 0; i < NK; i++) p[KEYS[i]] = o[KEYS[i]] || 0; return p; }
  function ext(base, o) { var p = {}, k; for (k in base) p[k] = base[k]; for (k in o) p[k] = o[k]; return P(p); }

  var GUARD = { lf: 0, la: 8, lk: 15, rf: -12, ra: 8, rk: 12, laf: 45, laa: 10, lae: 115, raf: 30, raa: 12, rae: 120 };
  var FRONT_STANCE = { lf: 28, la: 6, lk: 35, rf: -28, ra: 6, rk: 2 };
  var READY = { la: 10, lk: 4, ra: 10, rk: 4, laf: 18, laa: -18, lae: 45, raf: 18, raa: -18, rae: 45 };

  // Each technique: function(style) -> [[t, pose], ...], peak near t=0.5. style.h scales the peak (half-hearted < 1).
  var TECH = {
    front_kick: function (s) {
      return [[0, P(GUARD)], [0.3, ext(GUARD, { rf: 85 * s.ch, rk: 100, lean: -4 })], [0.5, ext(GUARD, { rf: 88 * s.h, rk: 5 + 30 * (1 - s.h), lean: -10 })],
              [0.7, ext(GUARD, { rf: 78 * s.ch, rk: 105, lean: -4 })], [1, ext(GUARD, { rf: 5, rk: 15 })]];
    },
    roundhouse: function (s) {
      return [[0, P(GUARD)], [0.3, ext(GUARD, { yaw: 35, rf: 75 * s.ch, ra: 35, rk: 120, roll: 5 })],
              [0.5, ext(GUARD, { yaw: 70 * s.h, rf: 50, ra: 62 * s.h, rk: 5 + 25 * (1 - s.h), roll: 18 * s.h })],
              [0.7, ext(GUARD, { yaw: 55, rf: 60, ra: 40, rk: 115, roll: 8 })], [1, ext(GUARD, { yaw: 15, rf: 0, rk: 15 })]];
    },
    side_kick: function (s) {
      return [[0, P(GUARD)], [0.3, ext(GUARD, { yaw: 80, rf: 60 * s.ch, ra: 50, rk: 130, roll: 8 })],
              [0.52, ext(GUARD, { yaw: 92, rf: 10, ra: 82 * s.h, rk: 4 + 25 * (1 - s.h), roll: 32 * s.h })],
              [0.72, ext(GUARD, { yaw: 88, rf: 55, ra: 50, rk: 125, roll: 10 })], [1, ext(GUARD, { yaw: 70, rf: 0, ra: 10, rk: 15 })]];
    },
    back_kick: function (s) {
      return [[0, P(GUARD)], [0.32, ext(GUARD, { yaw: -150, rf: -10, rk: 95 * s.ch, lean: 15 })],
              [0.55, ext(GUARD, { yaw: -175, rf: -82 * s.h, rk: 5 + 25 * (1 - s.h), lean: 40 * s.h })],
              [0.78, ext(GUARD, { yaw: -178, rf: -15, rk: 90, lean: 15 })], [1, ext(GUARD, { yaw: -180, rf: 0, rk: 15 })]];
    },
    axe_kick: function (s) {
      return [[0, P(GUARD)], [0.25, ext(GUARD, { rf: 80, ra: 30, rk: 10, lean: -5 })], [0.45, ext(GUARD, { rf: 150 * s.h, ra: 12, rk: 4, lean: -18 * s.h })],
              [0.65, ext(GUARD, { rf: 95 * s.h, ra: 0, rk: 2, lean: -8 })], [0.85, ext(GUARD, { rf: 15, rk: 10 })], [1, ext(GUARD, { rf: 0, rk: 15 })]];
    },
    low_block: function (s) {
      var st = FRONT_STANCE;
      return [[0, ext(st, { yaw: 10, raf: 70, raa: -60, rae: 140, laf: 40, laa: 0, lae: 10 })],
              [0.25, ext(st, { yaw: 5, raf: 60, raa: -40, rae: 115, laf: 35, lae: 30 })],
              [0.6, ext(st, { yaw: -20 * s.h, raf: 30, raa: 22 * s.h, rae: 5 + 20 * (1 - s.h), laf: -25, laa: 5, lae: 115 })],
              [1, ext(st, { yaw: -20 * s.h, raf: 30, raa: 22 * s.h, rae: 5, laf: -25, laa: 5, lae: 115 })]];
    },
    high_block: function (s) {
      var st = FRONT_STANCE;
      return [[0, ext(st, { yaw: 10, raf: 30, raa: -20, rae: 85, laf: 100, laa: 0, lae: 20 })],
              [0.3, ext(st, { yaw: 0, raf: 90, raa: -15, rae: 100, laf: 80, lae: 40 })],
              [0.6, ext(st, { yaw: -18 * s.h, raf: 150 * s.h + 5, raa: 10, rae: 75, laf: -25, laa: 5, lae: 115 })],
              [1, ext(st, { yaw: -18 * s.h, raf: 150 * s.h + 5, raa: 10, rae: 75, laf: -25, laa: 5, lae: 115 })]];
    },
    punch: function (s) {
      var st = FRONT_STANCE;
      return [[0, ext(st, { yaw: 12, raf: -25, raa: 5, rae: 115, laf: 88, laa: -5, lae: 5 })],
              [0.5, ext(st, { yaw: -15 * s.h, raf: 85 * s.h + 5, raa: -8, rae: 3 + 30 * (1 - s.h), laf: -25, laa: 5, lae: 115 })],
              [1, ext(st, { yaw: -15 * s.h, raf: 85 * s.h + 5, raa: -8, rae: 3, laf: -25, laa: 5, lae: 115 })]];
    }
  };
  // 'ready' variants (class 0). All must be learned as "not a technique".
  var READY_VARIANTS = {
    stance: function (s, rng) { // junbi, near still
      return [[0, P(READY)], [0.5, ext(READY, { lean: s.sway, laf: 18 + s.sway, raf: 18 - s.sway })], [1, P(READY)]];
    },
    fidget: function (s, rng) { // shifting weight, scratching, adjusting the belt / dobok
      var k = [[0, P(READY)]], n = 2 + Math.floor(rng() * 3);
      for (var i = 1; i <= n; i++) k.push([i / n, ext(READY, { yaw: (rng() - 0.5) * 30, lean: (rng() - 0.3) * 12, roll: (rng() - 0.5) * 8,
        lf: (rng() - 0.5) * 15, rf: (rng() - 0.5) * 15, lk: rng() * 15, rk: rng() * 15,
        laf: 10 + rng() * 70, lae: 20 + rng() * 110, laa: (rng() - 0.5) * 40, raf: 10 + rng() * 70, rae: 20 + rng() * 110, raa: (rng() - 0.5) * 40 })]);
      return k;
    },
    walk: function (s, rng) { // walking across or toward the camera (legs swing up to ~30 deg, arms counter-swing)
      var amp = 18 + rng() * 14, k = [], yaw = (rng() - 0.5) * 200;
      for (var i = 0; i <= 4; i++) { var ph = i % 2 ? 1 : -1;
        k.push([i / 4, P({ yaw: yaw, lean: 4, lf: amp * ph, lk: ph > 0 ? 25 : 8, la: 4, rf: -amp * ph, rk: ph < 0 ? 25 : 8, ra: 4,
          laf: -amp * 0.8 * ph, lae: 20, raf: amp * 0.8 * ph, rae: 20, laa: 6, raa: 6 })]); }
      return k;
    },
    bounce: function (s, rng) { // bouncing in fighting stance (guard up) without kicking: the start pose of every kick
      var k = [], n = 3 + Math.floor(rng() * 3), yaw = (rng() - 0.5) * 60;
      for (var i = 0; i <= n; i++) { var up = i % 2;
        k.push([i / n, ext(GUARD, { yaw: yaw + (rng() - 0.5) * 10, lk: up ? 8 : 30, rk: up ? 6 : 28, lf: up ? 0 : 12, rf: up ? -12 : -2,
          laf: 45 + (rng() - 0.5) * 15, raf: 30 + (rng() - 0.5) * 15 })]); }
      return k;
    },
    transition: function (s, rng) { // recovery: only the tail of a technique (leg coming down / arm retracting) -> guard/ready
      var names = Object.keys(TECH), t = TECH[names[Math.floor(rng() * names.length)]](s), last = t[t.length - 1][1];
      var mid = t[t.length - 2][1], end = rng() < 0.5 ? P(GUARD) : P(READY), blend = {};
      for (var i = 0; i < NK; i++) blend[KEYS[i]] = (mid[KEYS[i]] + last[KEYS[i]]) / 2;
      return [[0, P(blend)], [0.45, last], [1, end]];
    }
  };
  var READY_NEG = ['fidget', 'walk', 'bounce', 'transition'];

  function smooth(u) { return u * u * (3 - 2 * u); }
  function poseAt(keys, t, out) {
    var i, k;
    if (t <= keys[0][0]) { for (k = 0; k < NK; k++) out[KEYS[k]] = keys[0][1][KEYS[k]]; return out; }
    for (i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        var a = keys[i - 1], b = keys[i], u = smooth((t - a[0]) / (b[0] - a[0]));
        for (k = 0; k < NK; k++) { var n = KEYS[k]; out[n] = a[1][n] + (b[1][n] - a[1][n]) * u; }
        return out;
      }
    }
    var L = keys[keys.length - 1][1]; for (k = 0; k < NK; k++) out[KEYS[k]] = L[KEYS[k]]; return out;
  }

  function limbDir(f, a, side, o) { f *= D2R; a *= D2R; o[0] = side * Math.sin(a); o[1] = -Math.cos(a) * Math.cos(f); o[2] = Math.cos(a) * Math.sin(f); }
  var d1 = [0, 0, 0], d2 = [0, 0, 0];
  function skeleton3d(p, body, out) {
    var hw = body.hipW, sw = body.shW, T = body.torso, nk = body.neck;
    function set(j, x, y, z) { out[j * 3] = x; out[j * 3 + 1] = y; out[j * 3 + 2] = z; }
    set(LHIP, hw, 0, 0); set(RHIP, -hw, 0, 0); set(LSH, sw, T, 0); set(RSH, -sw, T, 0);
    set(NOSE, 0, T + nk, 0.1); set(LEYE, 0.05, T + nk + 0.06, 0.08); set(REYE, -0.05, T + nk + 0.06, 0.08);
    set(LEAR, 0.1, T + nk + 0.03, -0.03); set(REAR, -0.1, T + nk + 0.03, -0.03);
    function chain(r, m, e, side, f1, a1, f2, l1, l2) {
      limbDir(f1, a1, side, d1); limbDir(f2, a1, side, d2); r *= 3;
      var mx = out[r] + d1[0] * l1, my = out[r + 1] + d1[1] * l1, mz = out[r + 2] + d1[2] * l1;
      set(m, mx, my, mz); set(e, mx + d2[0] * l2, my + d2[1] * l2, mz + d2[2] * l2);
    }
    chain(LHIP, LKN, LAN, 1, p.lf, p.la, p.lf - p.lk, body.thigh, body.shin);
    chain(RHIP, RKN, RAN, -1, p.rf, p.ra, p.rf - p.rk, body.thigh, body.shin);
    chain(LSH, LEL, LWR, 1, p.laf, p.laa, p.laf + p.lae, body.upArm, body.foreArm);
    chain(RSH, REL, RWR, -1, p.raf, p.raa, p.raf + p.rae, body.upArm, body.foreArm);
  }
  function rotate(pts, roll, lean, yaw) {
    var cr = Math.cos(roll), sr = Math.sin(roll), cl = Math.cos(lean), sl = Math.sin(lean), cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (var j = 0; j < J; j++) {
      var x = pts[j * 3], y = pts[j * 3 + 1], z = pts[j * 3 + 2], t;
      t = x * cr + y * sr; y = -x * sr + y * cr; x = t;   // roll + : top toward +x (performer's left)
      t = y * cl - z * sl; z = y * sl + z * cl; y = t;    // lean + : shoulders forward (+z)
      t = x * cy + z * sy; z = -x * sy + z * cy; x = t;   // yaw
      pts[j * 3] = x; pts[j * 3 + 1] = y; pts[j * 3 + 2] = z;
    }
  }

  /* ---------- randomisation with disjoint train/test bands ----------
   * band(): [lo,hi] in 6 bins; train draws even bins, test odd bins -> no test subject shares a value with train. */
  function band(rng, lo, hi, test) { var b = Math.floor(rng() * 3) * 2 + (test ? 1 : 0), w = (hi - lo) / 6; return lo + (b + rng()) * w; }
  var gSpare = 0, gHave = false;
  function gauss(rng) {
    if (gHave) { gHave = false; return gSpare; }
    var u = rng() || 1e-9, v = rng(), r = Math.sqrt(-2 * Math.log(u));
    gSpare = r * Math.sin(2 * Math.PI * v); gHave = true; return r * Math.cos(2 * Math.PI * v);
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function makeSubject(rng, test) {
    var s = band(rng, 0.88, 1.14, test);
    return { torso: 1, hipW: band(rng, 0.13, 0.22, test), shW: band(rng, 0.17, 0.27, test), neck: band(rng, 0.25, 0.36, test),
      thigh: 0.88 * s * band(rng, 0.94, 1.06, test), shin: 0.84 * s * band(rng, 0.94, 1.06, test),
      upArm: 0.58 * s * band(rng, 0.94, 1.06, test), foreArm: 0.52 * s * band(rng, 0.94, 1.06, test) };
  }

  /* ---------- normalisation (shared by training data and the webcam) ---------- */
  var nsOrigins = new Float32Array(64 * 2), nsTorso = new Float32Array(64), nsTmp = new Float32Array(J * 3);
  function toFlat(fr, out) { // accepts flat [x,y,score]*17 or MoveNet keypoints [{x,y,score}]*17
    if (fr.length === J * 3 && typeof fr[0] === 'number') return fr;
    for (var j = 0; j < J; j++) { var k = fr[j] || {}; out[j * 3] = +k.x || 0; out[j * 3 + 1] = +k.y || 0; out[j * 3 + 2] = k.score == null ? 1 : +k.score; }
    return out;
  }
  /** Normalise one sequence to the contract frame.
   *  normalizeSequence(frames, minScore=0.3, out?)  or  normalizeSequence(frames, { minScore, mirror, out })
   *  frames: array of frames; each flat [x,y,score]*17 (image coords, y down) OR MoveNet keypoints [{x,y,score}]*17.
   *  - keypoints with score < minScore -> (0,0)
   *  - origin = mid-hip per frame (carried forward/back from the nearest frame where both hips were seen)
   *  - scale = MEDIAN torso length (mid-shoulder to mid-hip) over the window, clamped to [bboxH/5, bboxH/1.8] of the
   *    visible-keypoint box (guards against foreshortened torsos and flicker); falls back to bboxH/3.3 if no torso seen
   *  - mirror:true flips x and swaps left/right (use for a selfie-mirrored video if you mirror before pose detection)
   *  - output clipped to [-4, 4]. Returns Float32Array(frames.length*34). Empty/undetected -> all zeros. */
  function normalizeSequence(frames, a2, a3) {
    var o = (a2 && typeof a2 === 'object') ? a2 : { minScore: a2, out: a3 };
    var minScore = o.minScore == null ? 0.3 : o.minScore, mirror = !!o.mirror;
    var nF = frames.length, out = o.out || new Float32Array(nF * FEAT), i, j, fr;
    if (nF > nsTorso.length) { nsOrigins = new Float32Array(nF * 2); nsTorso = new Float32Array(nF); }
    var nT = 0, first = -1, ox = 0, oy = 0, minY = 1e9, maxY = -1e9, flats = [];
    for (i = 0; i < nF; i++) {
      fr = toFlat(frames[i], new Float32Array(J * 3)); flats.push(fr);
      for (j = 0; j < J; j++) if (fr[j * 3 + 2] >= minScore) { var yy = fr[j * 3 + 1]; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy; }
      var okH = fr[LHIP * 3 + 2] >= minScore && fr[RHIP * 3 + 2] >= minScore;
      if (okH) { ox = (fr[LHIP * 3] + fr[RHIP * 3]) / 2; oy = (fr[LHIP * 3 + 1] + fr[RHIP * 3 + 1]) / 2; if (first < 0) first = i; }
      nsOrigins[i * 2] = ox; nsOrigins[i * 2 + 1] = oy;
      if (okH && fr[LSH * 3 + 2] >= minScore && fr[RSH * 3 + 2] >= minScore) {
        var sx = (fr[LSH * 3] + fr[RSH * 3]) / 2 - ox, sy = (fr[LSH * 3 + 1] + fr[RSH * 3 + 1]) / 2 - oy;
        nsTorso[nT++] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    for (i = 0; i < first; i++) { nsOrigins[i * 2] = nsOrigins[first * 2]; nsOrigins[i * 2 + 1] = nsOrigins[first * 2 + 1]; }
    var bboxH = maxY > minY ? maxY - minY : 0, scale = 0;
    if (nT) { var arr = Array.prototype.slice.call(nsTorso, 0, nT).sort(function (a, b) { return a - b; }); scale = nT % 2 ? arr[(nT - 1) / 2] : (arr[nT / 2 - 1] + arr[nT / 2]) / 2; }
    else if (bboxH) scale = bboxH / 3.3;
    if (bboxH && scale) { var lo = bboxH / 5, hi = bboxH / 1.8; if (scale < lo) scale = lo; else if (scale > hi) scale = hi; }
    for (i = 0; i < nF; i++) {
      fr = flats[i];
      for (j = 0; j < J; j++) {
        var src = mirror ? SWAP[j] : j, q = i * FEAT + j * 2;
        if (!scale || first < 0 || fr[src * 3 + 2] < minScore) { out[q] = 0; out[q + 1] = 0; continue; }
        var vx = (fr[src * 3] - nsOrigins[i * 2]) / scale, vy = (fr[src * 3 + 1] - nsOrigins[i * 2 + 1]) / scale;
        if (mirror) vx = -vx;
        out[q] = vx > 4 ? 4 : vx < -4 ? -4 : vx; out[q + 1] = vy > 4 ? 4 : vy < -4 ? -4 : vy;
      }
    }
    return out;
  }

  /* ---------- the generator ---------- */
  var tmp3 = new Float32Array(J * 3), noiseState = new Float32Array(J * 2), framePool = [], hidden = new Uint8Array(F * J), pose = P({});
  for (var fp = 0; fp < F; fp++) framePool.push(new Float32Array(J * 3));

  function synthFrames(cls, rng, test, diff, fresh) {
    gHave = false; // no Box-Muller state may leak between samples/calls (reproducibility)
    var name = CLASSES[cls], body = makeSubject(rng, test), i, j;
    // per-sample difficulty: train spreads around the level (curriculum mix), test sits at the level
    var d = clamp01(test ? diff * (0.85 + 0.3 * rng()) : diff * (0.2 + 1.05 * rng()));
    var style = { h: band(rng, 0.78, 1.1, test), ch: band(rng, 0.8, 1.1, test), sway: (rng() - 0.5) * 4 };
    if (rng() < 0.45 * d) style.h *= 0.62 + 0.3 * rng();      // half-hearted / low kick / short punch
    var keys, variant = 'tech';
    if (name === 'ready') { variant = rng() < 0.15 + 0.65 * d ? READY_NEG[Math.floor(rng() * READY_NEG.length)] : 'stance'; keys = READY_VARIANTS[variant](style, rng); }
    else keys = TECH[name](style);
    // sloppy form: constant per-angle offsets + guard drop
    var slop = new Float32Array(NK), sl = 14 * d * (0.3 + rng());
    for (i = 0; i < NK; i++) slop[i] = gauss(rng) * sl * (i < 3 ? 0.6 : 1);
    var guardDrop = rng() < 0.4 * d ? 15 + rng() * 25 : 0;
    // timing: speed up to 3x (motion occupies 1/3 of the window) or slow (motion longer than the window), peak always in view
    var speed = 1 + 2 * d * rng(); if (speed > 3) speed = 3;
    var dur = band(rng, 0.6, 1.05, test) / speed;
    if (rng() < 0.25 * d) dur *= 1.2 + 0.4 * rng();
    var tPeak = (test ? band(rng, 0.3, 0.7, test) : 0.25 + 0.5 * rng()), start = tPeak - 0.5 * dur;
    if (variant !== 'tech') { dur = 1 + rng() * 0.4; start = -rng() * (dur - 1); }
    var warp = (rng() * 2 - 1) * (0.3 + 0.6 * d);            // hesitation / uneven speed (monotonic warp)
    var fpsE = 12 + (rng() * 2 - 1) * (d < 0.15 ? 0 : 4 + 4 * d * rng()); if (fpsE < 8) fpsE = 8; if (fpsE > 20) fpsE = 20;
    var stale = 0.06 * d, tJit = 0.25 * d;
    // camera
    var camYaw = band(rng, -70, 70, test) * D2R, camTilt = band(rng, -14, 14, test) * D2R * (0.6 + 0.8 * d);
    var camRoll = (rng() * 2 - 1) * 8 * d * D2R, faceAway = variant === 'tech' && name !== 'back_kick' && rng() < 0.08 ? Math.PI : 0;
    var dist = band(rng, 3, 9, test) * (1 + d * rng() * 0.6);                  // subject distance in torso units
    var focal = 330 + rng() * 100, pxScale = focal / dist;                     // torso height in pixels (~30..140)
    var cx = IMG_W * (0.5 + (rng() - 0.5) * (0.3 + 0.4 * d)), hipY = IMG_H * (0.5 + (rng() - 0.5) * 0.25);
    if (rng() < 0.3 * d) hipY = IMG_H - pxScale * (0.6 + rng() * 0.8);       // feet/knees cropped at the bottom edge
    var driftX = (rng() - 0.5) * 40 * d, shake = 2.5 * d;
    var mirror = rng() < 0.3;                                                    // 70/30 right/left-dominant performers
    var pxNoise = 1.2 + 4.5 * d * (0.5 + rng()), corr = 0.5 + 0.35 * rng();      // MoveNet jitter (px), temporal correlation
    var pDrop = 0.005 + 0.05 * d * rng(), pFlick = 0.03 * d;
    // occlusion bursts: whole limb low-confidence for 2-6 consecutive frames; far-side limbs preferred (decided per frame below)
    hidden.fill(0);
    var nb = Math.floor(rng() * (1 + 3 * d));
    for (var bI = 0; bI < nb; bI++) { var limb = LIMBS[Math.floor(rng() * 4)], st0 = Math.floor(rng() * F), ln = 2 + Math.floor(rng() * 5);
      for (i = st0; i < st0 + ln && i < F; i++) for (j = 1; j < 3; j++) hidden[i * J + limb[j]] = rng() < 0.85 ? 1 : 0; }
    noiseState.fill(0); gHave = false;
    var frames = fresh ? [] : framePool, prevCap = -1, prev = null;
    for (i = 0; i < F; i++) {
      var fr = fresh ? new Float32Array(J * 3) : framePool[i];
      // capture timing: zero-order hold at fpsE (duplicates when < 12 fps), timestamp jitter, stale frames
      var cap = Math.floor(i * fpsE / 12 + 1e-6);
      if (prev && (cap === prevCap || rng() < stale)) { fr.set(prev); if (fresh) frames.push(fr); prev = fr; continue; }
      prevCap = cap;
      var tt = (cap * 12 / fpsE + (rng() - 0.5) * tJit) / (F - 1);
      var u = (tt - start) / dur; u = u < 0 ? 0 : u > 1 ? 1 : u; u = u + warp * Math.sin(2 * Math.PI * u) / (2 * Math.PI);
      poseAt(keys, u, pose);
      for (var k = 0; k < NK; k++) pose[KEYS[k]] += slop[k];
      if (guardDrop) { pose.laf -= guardDrop; pose.raf -= guardDrop * 0.7; }
      if (variant === 'stance' || variant === 'bounce') pose.lean += Math.sin(i * 0.7 + style.sway) * 1.5;
      skeleton3d(pose, body, tmp3);
      rotate(tmp3, pose.roll * D2R, pose.lean * D2R, pose.yaw * D2R + camYaw + faceAway);
      // camera tilt + roll + shake, perspective by distance
      var ct = Math.cos(camTilt), stl = Math.sin(camTilt), rr = camRoll + gauss(rng) * shake * 0.004, cr = Math.cos(rr), sr = Math.sin(rr);
      var shx = gauss(rng) * shake, shy = gauss(rng) * shake;
      // torso box (camera space) for self-occlusion
      var tz = 0, txMin = 1e9, txMax = -1e9;
      for (j = LSH; j <= RSH; j++) { tz += tmp3[j * 3 + 2]; }
      tz = (tz + tmp3[LHIP * 3 + 2] + tmp3[RHIP * 3 + 2]) / 4;
      var tj = [LSH, RSH, LHIP, RHIP];
      for (k = 0; k < 4; k++) { var xx = tmp3[tj[k] * 3]; if (xx < txMin) txMin = xx; if (xx > txMax) txMax = xx; }
      var nearSide = (tmp3[LSH * 3 + 2] + tmp3[LHIP * 3 + 2]) > (tmp3[RSH * 3 + 2] + tmp3[RHIP * 3 + 2]) ? 1 : -1; // +1: left side nearer
      var sideways = Math.abs(tmp3[LSH * 3] - tmp3[RSH * 3]) < 0.6 * body.shW * 2;
      for (j = 0; j < J; j++) {
        var x = tmp3[j * 3], y = tmp3[j * 3 + 1], z = tmp3[j * 3 + 2];
        var y2 = y * ct - z * stl, z2 = y * stl + z * ct;
        var w = dist / (dist - z2);                                      // perspective (z toward camera)
        var ix = x * w, iy = -y2 * w;
        if (mirror) ix = -ix;
        var rx = ix * cr - iy * sr, ry = ix * sr + iy * cr;
        // MoveNet-style jitter in PIXELS (so it is relatively larger when the subject is small/far), AR(1) over time
        var sig = pxNoise * EXTREMITY[j];
        noiseState[j * 2] = corr * noiseState[j * 2] + gauss(rng) * sig; noiseState[j * 2 + 1] = corr * noiseState[j * 2 + 1] + gauss(rng) * sig;
        var px = cx + driftX * i / F + rx * pxScale + shx + noiseState[j * 2], py = hipY + ry * pxScale + shy + noiseState[j * 2 + 1];
        var score = 0.55 + 0.4 * rng();
        // self-occlusion: joint behind the torso and inside its silhouette
        if (z < tz - 0.08 && x > txMin - 0.06 && x < txMax + 0.06 && y > -0.15 && y < body.torso + 0.15 && rng() < 0.3 + 0.5 * d) score = 0.05 + 0.25 * rng();
        // far-side limb when sideways: often unsure
        var jSide = j === 0 ? 0 : (j % 2 ? 1 : -1);
        if (sideways && jSide === -nearSide && j >= LEL && rng() < 0.35 * (0.3 + d)) score = 0.1 + 0.3 * rng();
        if (hidden[i * J + j]) score = 0.05 + 0.2 * rng();
        if (rng() < pDrop) score = 0.05 + 0.2 * rng();
        // face keypoints when the head faces away
        if (j <= REAR && j !== LEAR && j !== REAR && tmp3[NOSE * 3 + 2] < (tmp3[LEAR * 3 + 2] + tmp3[REAR * 3 + 2]) / 2 && rng() < 0.7) score = 0.1 + 0.2 * rng();
        // out of frame: MoveNet clamps near the edge with low confidence
        if (px < 0 || px > IMG_W || py < 0 || py > IMG_H) { score = 0.05 + 0.2 * rng(); px = px < 0 ? 0 : px > IMG_W ? IMG_W : px; py = py < 0 ? 0 : py > IMG_H ? IMG_H : py; }
        // low-confidence keypoints are also positionally unreliable
        if (score < 0.3) { px += gauss(rng) * sig * 4; py += gauss(rng) * sig * 4; }
        fr[j * 3] = px; fr[j * 3 + 1] = py; fr[j * 3 + 2] = score;
      }
      // left/right flicker: MoveNet swaps the legs (or arms) for a frame
      if (rng() < pFlick) { var lb = rng() < 0.6 ? 2 : 0;
        for (k = 0; k < 3; k++) { var aJ = LIMBS[lb][k], bJ = LIMBS[lb + 1][k];
          for (var c = 0; c < 3; c++) { var tv = fr[aJ * 3 + c]; fr[aJ * 3 + c] = fr[bJ * 3 + c]; fr[bJ * 3 + c] = tv; } } }
      if (fresh) frames.push(fr);
      prev = fr;
    }
    // a mirrored image swaps which detected joint is "left" (do it after so occlusion logic used true sides)
    if (mirror) for (i = 0; i < F; i++) { var fm = frames[i]; tmp3.set(fm); for (j = 0; j < J; j++) { var s2 = SWAP[j]; fm[j * 3] = tmp3[s2 * 3]; fm[j * 3 + 1] = tmp3[s2 * 3 + 1]; fm[j * 3 + 2] = tmp3[s2 * 3 + 2]; } }
    frames.variant = variant; frames.difficulty = d;
    return frames;
  }
  function getDiff(opts, test) {
    var dv = opts && opts.difficulty;
    if (typeof dv !== 'number' || !(dv >= 0)) return test ? 0.8 : 0.6;
    return dv > 1 ? 1 : dv;
  }
  var DEFAULT_MIN = 0.3;

  function generateSample(cls, rng, opts) {
    var test = !!(opts && opts.split === 'test');
    return normalizeSequence(synthFrames(cls, rng, test, getDiff(opts, test), false), DEFAULT_MIN);
  }
  var batchBuf = new Float32Array(F * FEAT), rowX = new Float32Array(F * FEAT);
  function generateBatch(n, rng, opts) {
    if (typeof rng !== 'function') throw new Error('TKD.generateBatch: rng function required (use TKD.makeRng(seed))');
    var test = !!(opts && opts.split === 'test'), diff = getDiff(opts, test), S = F * FEAT;
    var x = new Float32Array(n * S), y = new Float32Array(n * NC), off = Math.floor(rng() * NC), i;
    for (i = 0; i < n; i++) {
      var cls = (i + off) % NC;
      normalizeSequence(synthFrames(cls, rng, test, diff, false), DEFAULT_MIN, batchBuf);
      x.set(batchBuf, i * S); y[i * NC + cls] = 1;
    }
    for (i = n - 1; i > 0; i--) {
      var r = Math.floor(rng() * (i + 1)); if (r === i) continue;
      var a = i * S, b = r * S;
      rowX.set(x.subarray(a, a + S)); x.copyWithin(a, b, b + S); x.set(rowX, b);
      for (var c = 0; c < NC; c++) { var t = y[i * NC + c]; y[i * NC + c] = y[r * NC + c]; y[r * NC + c] = t; }
    }
    return { n: n, x: x, y: y };
  }
  generateBatch.version = 'waffle-data-2.0';

  /** Webcam helper: TKD.makePoseWindow({fps:12, frames:16, minScore:0.3, mirror:false})
   *  .push(keypoints, timeMs)  - keypoints: MoveNet [{x,y,score}]*17 or flat [x,y,score]*17 (copied)
   *  .sequence()              - Float32Array(16*34) normalised like the training data, or null until ~1.3 s collected
   *  .clear(). Resamples whatever the camera fps is to 12 fps with zero-order hold (same as the training data). */
  function makePoseWindow(o) {
    o = o || {}; var fps = o.fps || 12, nF = o.frames || F, buf = [], times = [], span = (nF - 1) * 1000 / fps;
    var tmpF = new Float32Array(J * 3);
    return {
      push: function (kps, tMs) { var f = new Float32Array(J * 3); f.set(toFlat(kps, tmpF)); buf.push(f); times.push(tMs);
        while (times.length > 2 && times[1] < tMs - span - 1500) { times.shift(); buf.shift(); } },
      clear: function () { buf.length = 0; times.length = 0; },
      sequence: function () {
        if (!times.length || times[times.length - 1] - times[0] < span * 0.9) return null;
        var tEnd = times[times.length - 1], frames = [], k = 0;
        for (var i = 0; i < nF; i++) { var t = tEnd - (nF - 1 - i) * 1000 / fps; while (k + 1 < times.length && times[k + 1] <= t) k++; frames.push(buf[k]); }
        return normalizeSequence(frames, { minScore: o.minScore == null ? DEFAULT_MIN : o.minScore, mirror: !!o.mirror });
      }
    };
  }

  TKD.generateBatch = generateBatch;
  TKD.generateTestBatch = function (n, rng, opts) { var o = { split: 'test' }; if (opts && opts.difficulty != null) o.difficulty = opts.difficulty; return generateBatch(n, rng, o); };
  TKD.generateSample = generateSample;
  // NEW arrays (safe to keep, e.g. for the demo animation): FRAMES x Float32Array(J*3) [x,y,score] in a 640x480 image
  TKD.synthFrames = function (cls, rng, opts) { var test = !!(opts && opts.split === 'test'); return synthFrames(cls, rng, test, getDiff(opts, test), true); };
  TKD.normalizeSequence = normalizeSequence;
  TKD.makePoseWindow = makePoseWindow;
  TKD.data = { version: generateBatch.version, techniques: Object.keys(TECH), readyVariants: Object.keys(READY_VARIANTS), minScore: DEFAULT_MIN,
    fpsHint: 12, image: { w: IMG_W, h: IMG_H }, defaultDifficulty: { train: 0.6, test: 0.8 },
    note: 'Synthetic only: hand-written keyframes + randomised bodies/cameras/MoveNet-style noise. No real footage.' };
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
