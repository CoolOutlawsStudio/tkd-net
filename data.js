/* TKD-Net data.js (owner: Waffle) - synthetic taekwondo pose-sequence generator.
 * CLASSIC script (no import/export). Works in a Web Worker (importScripts) and in the page.
 * Contract: TKD.generateBatch(n, rng, opts) -> { n, x: Float32Array(n*FRAMES*FEATURES), y: Float32Array(n*NCLASSES) }
 *   opts.split: 'train' (default) | 'test'. 'test' draws simulated subjects/cameras/styles from DISJOINT
 *   parameter bands, so held-out accuracy measures generalisation, not memorisation.
 * Uses ONLY the passed rng (never Math.random). Does not define TKD.makeRng (nn.js owns it).
 *
 * How a sample is made: hand-written keyframes (joint angles) per technique -> smooth interpolation over time ->
 * 3D forward kinematics on a randomised body -> random camera yaw/tilt/weak perspective -> optional left/right mirror ->
 * keypoint jitter + dropped keypoints -> TKD.normalizeSequence (same function the webcam path must use).
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};
  var CLASSES = TKD.CLASSES || ['ready','front_kick','roundhouse','side_kick','back_kick','axe_kick','low_block','high_block','punch'];
  var NC = TKD.NCLASSES || CLASSES.length;
  var F = TKD.FRAMES || 16, J = TKD.JOINTS || 17, FEAT = TKD.FEATURES || J * 2;
  var D2R = Math.PI / 180;
  // COCO-17 / MoveNet order
  var NOSE=0, LEYE=1, REYE=2, LEAR=3, REAR=4, LSH=5, RSH=6, LEL=7, REL=8, LWR=9, RWR=10, LHIP=11, RHIP=12, LKN=13, RKN=14, LAN=15, RAN=16;
  var SWAP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];

  /* ---------- pose model ----------
   * Angles in degrees. Body frame: x = performer's LEFT, y = up, z = the way the performer faces.
   * yaw: whole-body turn (+ = counter-clockwise seen from above), lean: + = torso pitched forward, roll: + = tilt toward left.
   * Legs: f = flexion (0 down, 90 forward horizontal, <0 backward), a = abduction (sideways out), k = knee bend.
   * Arms: f = flexion (0 down, 90 forward, 180 up), a = abduction (+ out, - across the body), e = elbow bend. */
  var KEYS = ['yaw','lean','roll','lf','la','lk','rf','ra','rk','laf','laa','lae','raf','raa','rae'];
  function P(o) { var p = {}; for (var i = 0; i < KEYS.length; i++) p[KEYS[i]] = o[KEYS[i]] || 0; return p; }
  function ext(base, o) { var p = {}; for (var k in base) p[k] = base[k]; for (k in o) p[k] = o[k]; return P(p); }

  var GUARD = { lf: 0, la: 8, lk: 15, rf: -12, ra: 8, rk: 12, laf: 45, laa: 10, lae: 115, raf: 30, raa: 12, rae: 120 };
  var FRONT_STANCE = { lf: 28, la: 6, lk: 35, rf: -28, ra: 6, rk: 2 };

  // keyframes: [t, pose]; kick peaks marked with the 'h' (height) style factor via function form
  var TECH = {
    ready: function (s) { // joonbi: feet shoulder width, fists in front of the belt, near-still
      var b = { la: 10, lk: 4, ra: 10, rk: 4, laf: 18, laa: -18, lae: 45, raf: 18, raa: -18, rae: 45 };
      return [[0, P(b)], [0.5, ext(b, { lean: s.sway, laf: 18 + s.sway, raf: 18 - s.sway })], [1, P(b)]];
    },
    front_kick: function (s) { // ap chagi, right leg
      var g = P(GUARD);
      return [[0, g], [0.3, ext(GUARD, { rf: 85 * s.ch, rk: 100, lean: -4 })], [0.5, ext(GUARD, { rf: 88 * s.h, rk: 5, lean: -10 })],
              [0.7, ext(GUARD, { rf: 78, rk: 105, lean: -4 })], [1, ext(GUARD, { rf: 5, rk: 15 })]];
    },
    roundhouse: function (s) { // dollyeo chagi: hip turns over, knee rises to the side, foot snaps across
      var g = P(GUARD);
      return [[0, g], [0.3, ext(GUARD, { yaw: 35, rf: 75 * s.ch, ra: 35, rk: 120, roll: 5 })],
              [0.5, ext(GUARD, { yaw: 70, rf: 50, ra: 62 * s.h, rk: 5, roll: 18 })],
              [0.7, ext(GUARD, { yaw: 55, rf: 60, ra: 40, rk: 115, roll: 8 })], [1, ext(GUARD, { yaw: 15, rf: 0, rk: 15 })]];
    },
    side_kick: function (s) { // yeop chagi: body turns sideways, heel thrusts out, torso leans away
      var g = P(GUARD);
      return [[0, g], [0.3, ext(GUARD, { yaw: 80, rf: 60 * s.ch, ra: 50, rk: 130, roll: 8 })],
              [0.52, ext(GUARD, { yaw: 92, rf: 10, ra: 82 * s.h, rk: 4, roll: 32 })],
              [0.72, ext(GUARD, { yaw: 88, rf: 55, ra: 50, rk: 125, roll: 10 })], [1, ext(GUARD, { yaw: 70, rf: 0, ra: 10, rk: 15 })]];
    },
    back_kick: function (s) { // dwit chagi: spin to face away, leg drives straight back, torso folds forward
      var g = P(GUARD);
      return [[0, g], [0.32, ext(GUARD, { yaw: -150, rf: -10, rk: 95 * s.ch, lean: 15 })],
              [0.55, ext(GUARD, { yaw: -175, rf: -82 * s.h, rk: 5, lean: 40 })],
              [0.78, ext(GUARD, { yaw: -178, rf: -15, rk: 90, lean: 15 })], [1, ext(GUARD, { yaw: -180, rf: 0, rk: 15 })]];
    },
    axe_kick: function (s) { // naeryeo chagi: straight leg swings high then chops down
      var g = P(GUARD);
      return [[0, g], [0.25, ext(GUARD, { rf: 80, ra: 30, rk: 10, lean: -5 })], [0.45, ext(GUARD, { rf: 150 * s.h, ra: 12, rk: 4, lean: -18 })],
              [0.65, ext(GUARD, { rf: 95, ra: 0, rk: 2, lean: -8 })], [0.85, ext(GUARD, { rf: 15, rk: 10 })], [1, ext(GUARD, { rf: 0, rk: 15 })]];
    },
    low_block: function (s) { // arae makki: right fist from left shoulder sweeps down over the front thigh
      var st = ext(FRONT_STANCE, {});
      return [[0, ext(st, { yaw: 10, raf: 70, raa: -60, rae: 140, laf: 40, laa: 0, lae: 10 })],
              [0.25, ext(st, { yaw: 5, raf: 60, raa: -40, rae: 115, laf: 35, lae: 30 })],
              [0.6, ext(st, { yaw: -20, raf: 30, raa: 22 * s.h, rae: 5, laf: -25, laa: 5, lae: 115 })],
              [1, ext(st, { yaw: -20, raf: 30, raa: 22, rae: 5, laf: -25, laa: 5, lae: 115 })]];
    },
    high_block: function (s) { // eolgul makki: forearm rises from the belt to above the forehead
      var st = ext(FRONT_STANCE, {});
      return [[0, ext(st, { yaw: 10, raf: 30, raa: -20, rae: 85, laf: 100, laa: 0, lae: 20 })],
              [0.3, ext(st, { yaw: 0, raf: 90, raa: -15, rae: 100, laf: 80, lae: 40 })],
              [0.6, ext(st, { yaw: -18, raf: 150 * s.h + 5, raa: 10, rae: 75, laf: -25, laa: 5, lae: 115 })],
              [1, ext(st, { yaw: -18, raf: 155, raa: 10, rae: 75, laf: -25, laa: 5, lae: 115 })]];
    },
    punch: function (s) { // momtong jireugi: right fist drives from the hip to chest height, left fist pulls back
      var st = ext(FRONT_STANCE, {});
      return [[0, ext(st, { yaw: 12, raf: -25, raa: 5, rae: 115, laf: 88, laa: -5, lae: 5 })],
              [0.5, ext(st, { yaw: -15, raf: 85 * s.h + 5, raa: -8, rae: 3, laf: -25, laa: 5, lae: 115 })],
              [1, ext(st, { yaw: -15, raf: 88, raa: -8, rae: 3, laf: -25, laa: 5, lae: 115 })]];
    }
  };

  function smooth(u) { return u * u * (3 - 2 * u); }
  var poseTmp = P({});
  function poseAt(keys, t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (var i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        var a = keys[i - 1], b = keys[i], u = smooth((t - a[0]) / (b[0] - a[0])), p = poseTmp;
        for (var k = 0; k < KEYS.length; k++) { var n = KEYS[k]; p[n] = a[1][n] + (b[1][n] - a[1][n]) * u; }
        return p;
      }
    }
    return keys[keys.length - 1][1];
  }

  function limbDir(f, a, side) { // unit vector; side +1 = left (x+), -1 = right
    f *= D2R; a *= D2R;
    return [side * Math.sin(a), -Math.cos(a) * Math.cos(f), Math.cos(a) * Math.sin(f)];
  }
  // 3D joints in the body frame (origin mid-hip), before body rotation; body = subject proportions
  function skeleton3d(p, body, out) {
    var hw = body.hipW, sw = body.shW, T = body.torso;
    function set(j, x, y, z) { out[j * 3] = x; out[j * 3 + 1] = y; out[j * 3 + 2] = z; }
    set(LHIP, hw, 0, 0); set(RHIP, -hw, 0, 0);
    set(LSH, sw, T, 0); set(RSH, -sw, T, 0);
    set(NOSE, 0, T + body.neck, 0.1); set(LEYE, 0.05, T + body.neck + 0.06, 0.08); set(REYE, -0.05, T + body.neck + 0.06, 0.08);
    set(LEAR, 0.1, T + body.neck + 0.03, -0.03); set(REAR, -0.1, T + body.neck + 0.03, -0.03);
    function chain(rootJ, midJ, endJ, side, f1, a1, f2, a2, l1, l2) {
      var d1 = limbDir(f1, a1, side), d2 = limbDir(f2, a2, side), r = rootJ * 3;
      var mx = out[r] + d1[0] * l1, my = out[r + 1] + d1[1] * l1, mz = out[r + 2] + d1[2] * l1;
      set(midJ, mx, my, mz); set(endJ, mx + d2[0] * l2, my + d2[1] * l2, mz + d2[2] * l2);
    }
    chain(LHIP, LKN, LAN, 1, p.lf, p.la, p.lf - p.lk, p.la, body.thigh, body.shin);
    chain(RHIP, RKN, RAN, -1, p.rf, p.ra, p.rf - p.rk, p.ra, body.thigh, body.shin);
    chain(LSH, LEL, LWR, 1, p.laf, p.laa, p.laf + p.lae, p.laa, body.upArm, body.foreArm);
    chain(RSH, REL, RWR, -1, p.raf, p.raa, p.raf + p.rae, p.raa, body.upArm, body.foreArm);
  }

  // rotate in place: roll (about z), lean (about x), yaw (about y)
  function rotate(pts, roll, lean, yaw) {
    var cr = Math.cos(roll), sr = Math.sin(roll), cl = Math.cos(lean), sl = Math.sin(lean), cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (var j = 0; j < J; j++) {
      var x = pts[j * 3], y = pts[j * 3 + 1], z = pts[j * 3 + 2], t;
      t = x * cr + y * sr; y = -x * sr + y * cr; x = t;         // roll + : top tilts toward +x (performer's left)
      t = y * cl - z * sl; z = y * sl + z * cl; y = t;          // lean + : shoulders move toward +z (forward)
      t = x * cy + z * sy; z = -x * sy + z * cy; x = t;         // yaw
      pts[j * 3] = x; pts[j * 3 + 1] = y; pts[j * 3 + 2] = z;
    }
  }

  /* ---------- randomisation with disjoint train/test bands ----------
   * band(): split [lo,hi] into 6 equal bins; train draws from even bins, test from odd bins. So no test subject
   * shares a body/camera/style parameter value with any train subject, but test stays inside the same overall range. */
  function band(rng, lo, hi, test) {
    var bins = 6, b = Math.floor(rng() * 3) * 2 + (test ? 1 : 0), w = (hi - lo) / bins;
    return lo + (b + rng()) * w;
  }
  // Box-Muller, both outputs used (spare is reset per sample so samples stay independent of call history)
  var gSpare = 0, gHave = false;
  function gauss(rng) {
    if (gHave) { gHave = false; return gSpare; }
    var u = rng() || 1e-9, v = rng(), r = Math.sqrt(-2 * Math.log(u));
    gSpare = r * Math.sin(2 * Math.PI * v); gHave = true; return r * Math.cos(2 * Math.PI * v);
  }

  function makeSubject(rng, test) {
    var s = band(rng, 0.88, 1.14, test);           // overall limb scale vs torso
    return {
      torso: 1, hipW: band(rng, 0.13, 0.22, test), shW: band(rng, 0.17, 0.27, test), neck: band(rng, 0.25, 0.36, test),
      thigh: 0.88 * s * band(rng, 0.94, 1.06, test), shin: 0.84 * s * band(rng, 0.94, 1.06, test),
      upArm: 0.58 * s * band(rng, 0.94, 1.06, test), foreArm: 0.52 * s * band(rng, 0.94, 1.06, test)
    };
  }

  var tmp3 = new Float32Array(J * 3), swapBuf = new Float32Array(J * 3), framePool = [];
  for (var fp = 0; fp < F; fp++) framePool.push(new Float32Array(J * 3));

  /** Normalise one sequence to the contract frame. frames: array of FRAMES entries, each a flat array/typed array of
   *  J*3 values [x, y, score, ...] in IMAGE coordinates (pixels or any unit, y down). Keypoints with score < minScore
   *  become (0,0). Origin = mid-hip per frame (carried from the last frame where both hips were seen);
   *  scale = mean torso length (mid-shoulder to mid-hip) over the frames where all four were seen.
   *  Writes FRAMES*FEATURES floats into out (or a new Float32Array) and returns it. The webcam path MUST use this. */
  function normalizeSequence(frames, minScore, out) {
    minScore = minScore == null ? 0.3 : minScore;
    var nF = frames.length; out = out || new Float32Array(nF * FEAT);
    var sum = 0, cnt = 0, ox = 0, oy = 0, have = false, origins = new Float32Array(nF * 2), i, j, fr;
    for (i = 0; i < nF; i++) {
      fr = frames[i];
      var okH = fr[LHIP * 3 + 2] >= minScore && fr[RHIP * 3 + 2] >= minScore;
      if (okH) { ox = (fr[LHIP * 3] + fr[RHIP * 3]) / 2; oy = (fr[LHIP * 3 + 1] + fr[RHIP * 3 + 1]) / 2; have = true; }
      origins[i * 2] = ox; origins[i * 2 + 1] = oy;
      if (okH && fr[LSH * 3 + 2] >= minScore && fr[RSH * 3 + 2] >= minScore) {
        var sx = (fr[LSH * 3] + fr[RSH * 3]) / 2, sy = (fr[LSH * 3 + 1] + fr[RSH * 3 + 1]) / 2;
        sum += Math.sqrt((sx - ox) * (sx - ox) + (sy - oy) * (sy - oy)); cnt++;
      }
    }
    // back-fill origins for leading frames before the hips were first seen
    var first = -1;
    for (i = 0; i < nF && first < 0; i++) { fr = frames[i]; if (fr[LHIP * 3 + 2] >= minScore && fr[RHIP * 3 + 2] >= minScore) first = i; }
    for (i = 0; i < first; i++) { origins[i * 2] = origins[first * 2]; origins[i * 2 + 1] = origins[first * 2 + 1]; }
    var scale = cnt ? sum / cnt : 0;
    for (i = 0; i < nF; i++) {
      fr = frames[i];
      for (j = 0; j < J; j++) {
        var o = i * FEAT + j * 2;
        if (!scale || first < 0 || fr[j * 3 + 2] < minScore) { out[o] = 0; out[o + 1] = 0; continue; }
        var vx = (fr[j * 3] - origins[i * 2]) / scale, vy = (fr[j * 3 + 1] - origins[i * 2 + 1]) / scale;
        out[o] = vx > 4 ? 4 : vx < -4 ? -4 : vx; out[o + 1] = vy > 4 ? 4 : vy < -4 ? -4 : vy;
      }
    }
    return out;
  }

  /** Raw (un-normalised) image-space frames [x,y,score]*J for one synthetic sample. Used by generateSample and the demo. */
  function synthFrames(cls, rng, test, opts) {
    var name = CLASSES[cls], body = makeSubject(rng, test);
    var style = { h: band(rng, 0.72, 1.1, test), ch: band(rng, 0.8, 1.1, test), sway: (rng() - 0.5) * 4 };
    var keys = TECH[name](style);
    var dur = band(rng, 0.6, 1.05, test), start = (rng() * 1.1 - 0.35) * (1 - dur) - 0.05 * rng(); // where the motion sits in the window
    var warp = band(rng, 0.75, 1.35, test);                    // >1 = slow start / fast finish
    var camYaw = band(rng, -70, 70, test) * D2R, camTilt = band(rng, -14, 14, test) * D2R, persp = rng() * 0.12;
    var mirror = rng() < 0.5, noise = 0.012 + rng() * 0.04, drop = rng() < 0.6 ? rng() * 0.06 : 0;
    var faceAway = name !== 'back_kick' && rng() < 0.08 ? Math.PI : 0; // occasional back-to-camera performer
    var scale = 80 + rng() * 120, cx = 100 + rng() * 200, cy = 120 + rng() * 120, driftX = (rng() - 0.5) * 30;
    var frames = opts && opts.fresh ? [] : framePool; gHave = false;
    for (var i = 0; i < F; i++) {
      var tt = (i / (F - 1) - start) / dur; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt; tt = Math.pow(tt, warp);
      var p = poseAt(keys, tt);
      skeleton3d(p, body, tmp3);
      rotate(tmp3, p.roll * D2R, p.lean * D2R, p.yaw * D2R + camYaw + faceAway);
      var fr = frames === framePool ? framePool[i] : new Float32Array(J * 3), ct = Math.cos(camTilt), st = Math.sin(camTilt);
      for (var j = 0; j < J; j++) {
        var x = tmp3[j * 3], y = tmp3[j * 3 + 1], z = tmp3[j * 3 + 2];
        var y2 = y * ct - z * st, z2 = y * st + z * ct;          // camera tilt
        var w = 1 / (1 - z2 * persp * 0.3);                        // weak perspective: nearer = bigger
        var ix = x * w, iy = -y2 * w;                              // image: x right, y down (performer's left appears on the right)
        if (mirror) ix = -ix;
        fr[j * 3] = cx + driftX * i / F + (ix + gauss(rng) * noise) * scale;
        fr[j * 3 + 1] = cy + (iy + gauss(rng) * noise) * scale;
        fr[j * 3 + 2] = rng() < drop ? 0.05 : 0.5 + rng() * 0.5;
      }
      if (mirror) { // a mirrored image swaps which detected joint is "left"
        swapBuf.set(fr);
        for (j = 0; j < J; j++) { var s = SWAP[j]; fr[j * 3] = swapBuf[s * 3]; fr[j * 3 + 1] = swapBuf[s * 3 + 1]; fr[j * 3 + 2] = swapBuf[s * 3 + 2]; }
      }
      if (frames !== framePool) frames.push(fr);
    }
    return frames;
  }

  /** One normalised sample of class cls (0..8). Returns Float32Array(FRAMES*FEATURES). For the no-webcam demo mode. */
  function generateSample(cls, rng, opts) {
    var test = !!(opts && opts.split === 'test');
    return normalizeSequence(synthFrames(cls, rng, test), 0.3);
  }

  function generateBatch(n, rng, opts) {
    if (typeof rng !== 'function') throw new Error('TKD.generateBatch: rng function required (use TKD.makeRng(seed))');
    var test = !!(opts && opts.split === 'test');
    var x = new Float32Array(n * F * FEAT), y = new Float32Array(n * NC);
    var off = Math.floor(rng() * NC), buf = new Float32Array(F * FEAT);
    for (var i = 0; i < n; i++) {
      var cls = (i + off) % NC;                          // exact round-robin balance, random start
      normalizeSequence(synthFrames(cls, rng, test), 0.3, buf);
      x.set(buf, i * F * FEAT); y[i * NC + cls] = 1;
    }
    // shuffle sample order (Fisher-Yates) so a batch is not in class order
    var rowX = new Float32Array(F * FEAT);
    for (i = n - 1; i > 0; i--) {
      var r = Math.floor(rng() * (i + 1)); if (r === i) continue;
      var a = i * F * FEAT, b = r * F * FEAT;
      rowX.set(x.subarray(a, a + F * FEAT)); x.copyWithin(a, b, b + F * FEAT); x.set(rowX, b);
      for (var c = 0; c < NC; c++) { var t = y[i * NC + c]; y[i * NC + c] = y[r * NC + c]; y[r * NC + c] = t; }
    }
    return { n: n, x: x, y: y };
  }
  generateBatch.version = 'waffle-data-1.0';

  TKD.generateBatch = generateBatch;
  TKD.generateTestBatch = function (n, rng) { return generateBatch(n, rng, { split: 'test' }); }; // thin alias
  TKD.generateSample = generateSample;
  // returns NEW arrays (safe to keep, e.g. for the demo animation): FRAMES x Float32Array(J*3) [x,y,score] image coords
  TKD.synthFrames = function (cls, rng, opts) { return synthFrames(cls, rng, !!(opts && opts.split === 'test'), { fresh: true }); };
  TKD.normalizeSequence = normalizeSequence;
  TKD.data = { version: generateBatch.version, techniques: Object.keys(TECH), minScore: 0.3, fpsHint: 12,
    note: 'Synthetic only: hand-written keyframes + randomised bodies/cameras/noise. No real footage.' };
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
