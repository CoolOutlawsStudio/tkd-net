/* TKD-Net nn.js v2 (owner: Moneyman)
 * From-scratch neural network on typed arrays. Classic script, no dependencies, no TensorFlow.js.
 * Architecture ("tcn-attn"), per sample X[T=16][F=34]:
 *   h0[t]  = Win * X[t] + bin + pos[t]                       (input projection + learned positional encoding, D ch)
 *   block j (j = 0..B-1, dilation 1,2,4,...):                 (temporal conv block, residual)
 *     g    = depthwise temporal conv, kernel K=5, dilation d, zero padding
 *     r    = ReLU(PW_j * g + pb_j)                            (pointwise D->D)
 *     h    = h + r
 *   attention (single head, residual):  q = Wq h, k = Wk h (dq ch), v = Wv h + bv (D ch)
 *     A[t][u] = softmax_u(q[t].k[u] / sqrt(dq)),  h = h + A v
 *   pool: mean_t and max_t of h (2D) -> Dense(H) -> ReLU -> Dense(O) -> softmax
 * Loss: cross-entropy with optional label smoothing. Optimiser: AdamW + global-norm clipping.
 * LR schedule: TKD.lrSchedule (linear warmup, cosine decay over the GLOBAL step, then a floor).
 * Augmentation: TKD.augment (training batches only; see CONTRACT.md).
 * Works in a classic Web Worker (importScripts), in a page (<script>), and in node (tests).
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};

  // Constants: data.js's exports win when present (it may load before or after this file).
  if (!TKD.CLASSES) TKD.CLASSES = ['ready', 'front_kick', 'roundhouse', 'side_kick', 'back_kick', 'axe_kick', 'low_block', 'high_block', 'punch'];
  if (!TKD.FRAMES) TKD.FRAMES = TKD.NUM_FRAMES || 16;
  if (!TKD.FEATURES) TKD.FEATURES = TKD.NUM_FEATURES || 34;
  if (!TKD.NCLASSES) TKD.NCLASSES = TKD.NUM_CLASSES || 9;
  if (!TKD.JOINTS) TKD.JOINTS = TKD.FEATURES / 2;
  // Lookup order: TKD.FRAMES / FEATURES / NCLASSES first, NUM_* aliases as fallback, then the v1 defaults.
  TKD.dims = function () {
    var T = TKD.FRAMES || TKD.NUM_FRAMES || 16, F = TKD.FEATURES || TKD.NUM_FEATURES || 34;
    return { T: T, F: F, O: TKD.NCLASSES || TKD.NUM_CLASSES || 9, J: TKD.JOINTS || F / 2 };
  };
  // Bump when the architecture / weight layout changes. Saved weights with another version are discarded.
  TKD.MODEL_VERSION = 'tcn-attn-v2';
  TKD.MODEL_NAME = 'TKD-Net v2: 2 dilated temporal-conv blocks + self-attention';

  // mulberry32: small, fast, seedable PRNG returning floats in [0,1).
  TKD.makeRng = function (seed) {
    var a = (seed >>> 0) || 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  function gaussian(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  TKD.gaussian = gaussian;

  // ---------------- learning-rate schedule ----------------
  // lr(step) over the GLOBAL step count (continues across page opens):
  //   step < warmup              : linear from base*warmupFrom to base
  //   warmup <= step < warmup+decay : cosine from base down to base*floor
  //   afterwards                 : base*floor (never 0, so later sessions still learn)
  TKD.LR_DEFAULTS = { warmup: 150, decay: 4000, floor: 0.15, warmupFrom: 0.1 };
  TKD.lrSchedule = function (step, base, o) {
    o = o || TKD.LR_DEFAULTS;
    var wu = o.warmup == null ? 150 : o.warmup, dc = o.decay == null ? 4000 : o.decay;
    var fl = o.floor == null ? 0.15 : o.floor, wf = o.warmupFrom == null ? 0.1 : o.warmupFrom;
    if (step < wu) return base * (wf + (1 - wf) * step / wu);
    var p = (step - wu) / Math.max(1, dc);
    if (p >= 1) return base * fl;
    return base * (fl + (1 - fl) * 0.5 * (1 + Math.cos(Math.PI * p)));
  };

  // ---------------- augmentation (training batches only) ----------------
  // Left/right swap for the 17-joint COCO order.
  var SWAP17 = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];
  TKD.AUGMENT_DEFAULTS = {
    p: 0.5,           // probability a sample is augmented at all (the rest stay clean)
    rotate: 0.17,     // max |rotation| in radians (~10 deg) about the mid-hip origin
    scale: 0.1,       // overall scale in [1-s, 1+s] (torso stays ~1)
    stretchX: 0.12,   // extra x-only scale in [1-s, 1+s] (camera yaw / foreshortening)
    flip: 0.5,        // probability of a left/right mirror (x -> -x, swap joints); techniques are side-agnostic
    noise: 0.01,      // gaussian sigma on every visible coordinate (torso units)
    jointDrop: 0.01,  // per joint per frame probability of being zeroed (missing keypoint, like score < 0.3)
    limbDrop: 0.02,   // per sample probability that one joint is missing for the whole window (occlusion)
    speed: 0.1,       // temporal speed warp in [1-s, 1+s]
    shift: 1,         // temporal shift in frames, uniform in [-shift, shift]
    mixup: 0          // mixup probability (0 = off); mixes pairs inside the batch with lambda in [0.6, 1]
  };
  // In place on x [n][T][F] (and y for mixup). Deterministic given rng. Zero joints (0,0) mean "missing" and stay missing.
  TKD.augment = function (x, y, n, rng, opts) {
    var o = {}, k, d = TKD.dims(), T = d.T, F = d.F, J = F >> 1, O = d.O, S = T * F;
    for (k in TKD.AUGMENT_DEFAULTS) o[k] = TKD.AUGMENT_DEFAULTS[k];
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    var canFlip = J === 17, tmp = new Float32Array(S), i, t, j, f;
    for (i = 0; i < n; i++) {
      if (rng() >= o.p) continue;
      var off = i * S;
      // 1) temporal speed warp + shift (resample frames; never interpolate with a missing joint)
      var sp = 1 + (rng() * 2 - 1) * o.speed, sh = (rng() * 2 - 1) * o.shift, c = (T - 1) / 2;
      for (f = 0; f < S; f++) tmp[f] = x[off + f];
      for (t = 0; t < T; t++) {
        var src = c + (t - c) * sp + sh;
        if (src < 0) src = 0; else if (src > T - 1) src = T - 1;
        var t0 = Math.floor(src), t1 = t0 < T - 1 ? t0 + 1 : t0, w = src - t0;
        for (j = 0; j < J; j++) {
          var a0 = t0 * F + 2 * j, a1 = t1 * F + 2 * j, dst = off + t * F + 2 * j;
          var m0 = tmp[a0] === 0 && tmp[a0 + 1] === 0, m1 = tmp[a1] === 0 && tmp[a1 + 1] === 0;
          if (m0 && m1) { x[dst] = 0; x[dst + 1] = 0; }
          else if (m0 || m1) { var a = m0 ? a1 : a0; x[dst] = tmp[a]; x[dst + 1] = tmp[a + 1]; }
          else { x[dst] = tmp[a0] + w * (tmp[a1] - tmp[a0]); x[dst + 1] = tmp[a0 + 1] + w * (tmp[a1 + 1] - tmp[a0 + 1]); }
        }
      }
      // 2) spatial: mirror, rotation, scale, x-stretch about the origin (mid-hip stays at 0,0)
      var flip = canFlip && rng() < o.flip;
      var ang = (rng() * 2 - 1) * o.rotate, sc = 1 + (rng() * 2 - 1) * o.scale, sx = sc * (1 + (rng() * 2 - 1) * o.stretchX);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var lost = rng() < o.limbDrop ? Math.floor(rng() * J) : -1;
      for (t = 0; t < T; t++) {
        var fo = off + t * F;
        if (flip) {
          for (f = 0; f < F; f++) tmp[f] = x[fo + f];
          for (j = 0; j < J; j++) { var s2 = SWAP17[j]; x[fo + 2 * j] = -tmp[2 * s2]; x[fo + 2 * j + 1] = tmp[2 * s2 + 1]; }
        }
        for (j = 0; j < J; j++) {
          var p = fo + 2 * j, px = x[p], py = x[p + 1];
          if (px === 0 && py === 0) continue; // missing stays missing
          if (j === lost || rng() < o.jointDrop) { x[p] = 0; x[p + 1] = 0; continue; }
          var rx = (ca * px - sa * py) * sx, ry = (sa * px + ca * py) * sc;
          if (o.noise > 0) { rx += gaussian(rng) * o.noise; ry += gaussian(rng) * o.noise; }
          if (rx === 0 && ry === 0) rx = 1e-6;
          x[p] = rx; x[p + 1] = ry;
        }
      }
    }
    // 3) optional mixup (soft labels; the loss supports them)
    if (o.mixup > 0 && y && n > 1) {
      for (i = 0; i < n; i++) {
        if (rng() >= o.mixup) continue;
        var jj = Math.floor(rng() * n); if (jj === i) continue;
        var lam = 0.6 + 0.4 * rng();
        for (f = 0; f < S; f++) x[i * S + f] = lam * x[i * S + f] + (1 - lam) * x[jj * S + f];
        for (k = 0; k < O; k++) y[i * O + k] = lam * y[i * O + k] + (1 - lam) * y[jj * O + k];
      }
    }
    return x;
  };

  // ---------------- network ----------------
  function Net(opts) {
    opts = opts || {};
    var A = this.A = opts.float64 ? Float64Array : Float32Array; // float64 only for gradient-check tests
    var d = TKD.dims();
    this.T = d.T; this.F = d.F; this.O = d.O;
    this.D = opts.channels || opts.filters || 32;  // model width (32 keeps batch-64 steps ~25 ms on a laptop core)
    this.K = opts.kernel || 5;                      // depthwise temporal kernel (odd)
    this.B = opts.blocks == null ? 2 : opts.blocks; // conv blocks
    this.DQ = opts.attnDim || 16;                   // query/key width
    this.H = opts.hidden || 64;
    this.dil = []; for (var j = 0; j < this.B; j++) this.dil.push(1 << j); // dilations 1, 2, ...
    this.labelSmoothing = opts.labelSmoothing == null ? 0.05 : opts.labelSmoothing;
    this.seed = (opts.seed == null ? 1 : opts.seed) >>> 0;
    this.weightDecay = opts.weightDecay == null ? 1e-4 : opts.weightDecay;
    this.clip = opts.clip == null ? 5 : opts.clip;
    this.beta1 = 0.9; this.beta2 = 0.999; this.eps = 1e-8;
    var D = this.D, F = this.F, T = this.T, K = this.K, DQ = this.DQ, H = this.H, O = this.O;
    var rng = TKD.makeRng(this.seed || 1), self = this;
    function param(name, size, std, decay) {
      var w = new A(size);
      if (std > 0) for (var i = 0; i < size; i++) w[i] = gaussian(rng) * std;
      return { name: name, w: w, g: new A(size), m: new A(size), v: new A(size), decay: decay };
    }
    // Layouts: Win[d][f], pos[t][d], DWj[d][k], PWj[e][d], Wq/Wk[a][d], Wv[e][d], W2[h][p], W3[o][h]
    var ps = [param('Win', D * F, Math.sqrt(1 / F), true), param('bin', D, 0, false), param('pos', T * D, 0.1, false)];
    for (j = 0; j < this.B; j++) {
      ps.push(param('DW' + j, D * K, Math.sqrt(1 / K), true));
      ps.push(param('PW' + j, D * D, Math.sqrt(1 / D), true)); // residual branch: ~half He scale keeps activations stable
      ps.push(param('pb' + j, D, 0, false));
    }
    ps.push(param('Wq', DQ * D, Math.sqrt(1 / D), true), param('Wk', DQ * D, Math.sqrt(1 / D), true));
    ps.push(param('Wv', D * D, Math.sqrt(0.5 / D), true), param('bv', D, 0, false));
    ps.push(param('W2', H * 2 * D, Math.sqrt(2 / (2 * D)), true), param('b2', H, 0, false));
    ps.push(param('W3', O * H, Math.sqrt(1 / H), true), param('b3', O, 0, false));
    this.params = ps;
    this.byName = {};
    ps.forEach(function (p) { self.byName[p.name] = p; });
    this.t = 0; this.cap = 0;
    // per-sample backward scratch
    var TD = T * D;
    this.dh = new A(TD); this.dg = new A(TD); this.dz = new A(TD); this.dvv = new A(TD); this.dA = new A(T * T);
    this.dq = new A(T * DQ); this.dk = new A(T * DQ);
    this.dpool = new A(2 * D); this.da2 = new A(H); this.dz2 = new A(H); this.dz3 = new A(O); this.ys = new A(O);
    this.rowT = new A(T);
  }

  // ---- batched dense helpers (hot loops kept small so JS engines optimise them well) ----
  // Y[r][o] = b[o] + sum_i X[xo + r*I + i] * W[o*I + i]
  function linF(X, W, b, Y, rows, I, O) {
    var I4 = I - (I & 3);
    for (var r = 0; r < rows; r++) {
      var xr = r * I, yr = r * O;
      for (var o = 0; o < O; o++) {
        var wr = o * I, s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0;
        for (; i < I4; i += 4) {
          s0 += X[xr + i] * W[wr + i]; s1 += X[xr + i + 1] * W[wr + i + 1];
          s2 += X[xr + i + 2] * W[wr + i + 2]; s3 += X[xr + i + 3] * W[wr + i + 3];
        }
        for (; i < I; i++) s0 += X[xr + i] * W[wr + i];
        Y[yr + o] = (b ? b[o] : 0) + s0 + s1 + s2 + s3;
      }
    }
  }
  // Backward of linF: gW += dY^T X, gb += sum dY, dX += dY W (dX may be null).
  // Uses transposed copies so every inner loop is a contiguous dot product (much faster than scattered updates).
  var scratch = { xt: null, yt: null, wt: null };
  function grow(name, n, A) {
    var s = scratch[name];
    if (!s || s.length < n || s.constructor !== A) s = scratch[name] = new A(n);
    return s;
  }
  function transpose(src, dst, rows, cols) { // src [rows][cols] -> dst [cols][rows]
    for (var r = 0; r < rows; r++) { var sr = r * cols; for (var c = 0; c < cols; c++) dst[c * rows + r] = src[sr + c]; }
  }
  function dot4(a, ao, b, bo, len) {
    var s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0, L4 = len - (len & 3);
    for (; i < L4; i += 4) { s0 += a[ao + i] * b[bo + i]; s1 += a[ao + i + 1] * b[bo + i + 1]; s2 += a[ao + i + 2] * b[bo + i + 2]; s3 += a[ao + i + 3] * b[bo + i + 3]; }
    for (; i < len; i++) s0 += a[ao + i] * b[bo + i];
    return s0 + s1 + s2 + s3;
  }
  function linB(X, W, dY, gW, gb, dX, rows, I, O) {
    var A = gW.constructor, r, o, i;
    var XT = grow('xt', I * rows, A), YT = grow('yt', O * rows, A);
    transpose(X, XT, rows, I); transpose(dY, YT, rows, O);
    for (o = 0; o < O; o++) {
      var yo = o * rows, wr = o * I;
      if (gb) { var sb = 0; for (r = 0; r < rows; r++) sb += YT[yo + r]; gb[o] += sb; }
      for (i = 0; i < I; i++) gW[wr + i] += dot4(YT, yo, XT, i * rows, rows);
    }
    if (dX) {
      var WT = grow('wt', I * O, A);
      transpose(W, WT, O, I); // [I][O]
      for (r = 0; r < rows; r++) {
        var dyr = r * O, dxr = r * I;
        for (i = 0; i < I; i++) dX[dxr + i] += dot4(dY, dyr, WT, i * O, O);
      }
    }
  }
  // depthwise temporal conv per sample: G[t][d] = sum_k DW[d][k] * Hin[t + (k-half)*dl][d]
  function dwF(Hin, DW, G, n, T, D, K, dl) {
    var half = (K - 1) >> 1, TD = T * D;
    G.fill(0, 0, n * TD);
    for (var i = 0; i < n; i++) {
      var ho = i * TD;
      for (var k = 0; k < K; k++) {
        var sh = (k - half) * dl, t0 = sh < 0 ? -sh : 0, t1 = sh > 0 ? T - sh : T;
        for (var t = t0; t < t1; t++) {
          var gr = ho + t * D, hr = ho + (t + sh) * D;
          for (var d = 0; d < D; d++) G[gr + d] += DW[d * K + k] * Hin[hr + d];
        }
      }
    }
  }
  function dwB(Hin, DW, dG, gDW, dHin, n, T, D, K, dl) {
    var half = (K - 1) >> 1, TD = T * D;
    for (var i = 0; i < n; i++) {
      var ho = i * TD;
      for (var k = 0; k < K; k++) {
        var sh = (k - half) * dl, t0 = sh < 0 ? -sh : 0, t1 = sh > 0 ? T - sh : T;
        for (var t = t0; t < t1; t++) {
          var gr = ho + t * D, hr = ho + (t + sh) * D;
          for (var d = 0; d < D; d++) {
            var g = dG[gr + d];
            gDW[d * K + k] += g * Hin[hr + d];
            dHin[hr + d] += DW[d * K + k] * g;
          }
        }
      }
    }
  }

  // attention forward (per sample): A = softmax(q k^T * scale), h3 = h2 + A v; then mean+max pool of h3
  function attF(q, kk, v, h2, att, h3, pool, amax, n, T, D, DQ, scale) {
    var TD = T * D, P = 2 * D;
    for (var i = 0; i < n; i++) {
      var qo = i * T * DQ, ao = i * T * T, ho = i * TD, t, u, a, e, d, s;
      for (t = 0; t < T; t++) {
        var mx = -Infinity, ar = ao + t * T, qt = qo + t * DQ;
        for (u = 0; u < T; u++) {
          s = 0;
          var ku = qo + u * DQ;
          for (a = 0; a < DQ; a++) s += q[qt + a] * kk[ku + a];
          s *= scale;
          att[ar + u] = s;
          if (s > mx) mx = s;
        }
        var den = 0;
        for (u = 0; u < T; u++) { var ex = Math.exp(att[ar + u] - mx); att[ar + u] = ex; den += ex; }
        var inv = 1 / den;
        for (u = 0; u < T; u++) att[ar + u] *= inv;
        var or = ho + t * D;
        for (e = 0; e < D; e++) h3[or + e] = h2[or + e];
        for (u = 0; u < T; u++) {
          var au = att[ar + u], vr = ho + u * D;
          for (e = 0; e < D; e++) h3[or + e] += au * v[vr + e];
        }
      }
      var po = i * P;
      for (d = 0; d < D; d++) {
        var sum = 0, m = -Infinity, am = 0;
        for (t = 0; t < T; t++) { var val = h3[ho + t * D + d]; sum += val; if (val > m) { m = val; am = t; } }
        pool[po + d] = sum / T; pool[po + D + d] = m; amax[i * D + d] = am;
      }
    }
  }
  // pool backward: dH[t][d] = dmean/T + (t == argmax ? dmax : 0)
  function poolB(dPool, amax, dH, n, T, D) {
    var P = 2 * D, TD = T * D, invT = 1 / T;
    for (var i = 0; i < n; i++) {
      var po = i * P, ho = i * TD;
      for (var t = 0; t < T; t++) {
        var hr = ho + t * D;
        for (var d = 0; d < D; d++) dH[hr + d] = dPool[po + d] * invT;
      }
      for (d = 0; d < D; d++) dH[ho + amax[i * D + d] * D + d] += dPool[po + D + d];
    }
  }
  // attention backward. In: dH = d h3. Out: dV, dQ, dK (d h2 via q/k/v is added later by linB).
  function attB(q, kk, v, att, dH, dV, dS, dQ, dK, n, T, D, DQ, scale) {
    var TD = T * D;
    dV.fill(0, 0, n * TD); dQ.fill(0, 0, n * T * DQ); dK.fill(0, 0, n * T * DQ);
    for (var i = 0; i < n; i++) {
      var ao = i * T * T, hb = i * TD, qo = i * T * DQ, t, u, e, a, s;
      for (t = 0; t < T; t++) {
        var ar = ao + t * T, dor = hb + t * D, dot = 0;
        for (u = 0; u < T; u++) {
          var vr = hb + u * D, au = att[ar + u];
          s = 0;
          for (e = 0; e < D; e++) { var de = dH[dor + e]; s += de * v[vr + e]; dV[vr + e] += au * de; }
          dS[ar + u] = s; dot += au * s;
        }
        for (u = 0; u < T; u++) dS[ar + u] = att[ar + u] * (dS[ar + u] - dot) * scale;
      }
      for (t = 0; t < T; t++) {
        var qt = qo + t * DQ;
        for (u = 0; u < T; u++) {
          var ds = dS[ao + t * T + u], ku = qo + u * DQ;
          for (a = 0; a < DQ; a++) { dQ[qt + a] += ds * kk[ku + a]; dK[ku + a] += ds * q[qt + a]; }
        }
      }
    }
  }

  Net.prototype._ensure = function (n) {
    if (n <= this.cap) return;
    var A = this.A, T = this.T, D = this.D, B = this.B, NT = n * T, NTD = NT * D;
    this.cap = n;
    this.hs = []; this.gs = []; this.rs = [];
    for (var j = 0; j <= B; j++) this.hs.push(new A(NTD)); // hs[0] = h0, hs[j+1] = block j output
    for (j = 0; j < B; j++) { this.gs.push(new A(NTD)); this.rs.push(new A(NTD)); }
    this.q = new A(NT * this.DQ); this.k = new A(NT * this.DQ); this.v = new A(NTD);
    this.att = new A(NT * T); this.h3 = new A(NTD);
    this.amax = new Uint8Array(n * D);
    this.pool = new A(n * 2 * D); this.a2 = new A(n * this.H); this.probs = new A(n * this.O);
    // backward buffers
    this.dH = new A(NTD); this.dG = new A(NTD); this.dZ = new A(NTD); this.dV = new A(NTD); this.dS = new A(NT * T);
    this.dQ = new A(NT * this.DQ); this.dK = new A(NT * this.DQ);
    this.dPool = new A(n * 2 * D); this.dA2 = new A(n * this.H); this.dZ3 = new A(n * this.O);
  };

  // Forward pass for n samples. Fills internal caches; returns probs (first n*O valid).
  Net.prototype.forward = function (x, n) {
    var T = this.T, F = this.F, D = this.D, K = this.K, B = this.B, DQ = this.DQ, H = this.H, O = this.O;
    if (n == null) n = Math.floor(x.length / (T * F));
    this._ensure(n);
    var bn = this.byName, NT = n * T, TD = T * D, P = 2 * D, scale = 1 / Math.sqrt(DQ);
    var q = this.q, kk = this.k, v = this.v, att = this.att, h3 = this.h3, amax = this.amax, pool = this.pool, a2 = this.a2, probs = this.probs;
    var i, t, d, e, u, a, j, s, o, r;
    // input projection + positional encoding
    var h0 = this.hs[0], pos = bn.pos.w;
    linF(x, bn.Win.w, bn.bin.w, h0, NT, F, D);
    for (i = 0; i < n; i++) { var hb = i * TD; for (r = 0; r < TD; r++) h0[hb + r] += pos[r]; }
    // temporal conv blocks: h = h + ReLU(PW * dwconv(h) + pb)
    for (j = 0; j < B; j++) {
      var hin = this.hs[j], hout = this.hs[j + 1], g = this.gs[j], rr = this.rs[j];
      dwF(hin, bn['DW' + j].w, g, n, T, D, K, this.dil[j]);
      linF(g, bn['PW' + j].w, bn['pb' + j].w, rr, NT, D, D);
      for (r = 0; r < NT * D; r++) { s = rr[r]; if (s < 0) { s = 0; rr[r] = 0; } hout[r] = hin[r] + s; }
    }
    // self-attention (single head), residual
    var h2 = this.hs[B];
    linF(h2, bn.Wq.w, null, q, NT, D, DQ);
    linF(h2, bn.Wk.w, null, kk, NT, D, DQ);
    linF(h2, bn.Wv.w, bn.bv.w, v, NT, D, D);
    attF(q, kk, v, h2, att, h3, pool, amax, n, T, D, DQ, scale);
    // dense + ReLU, output + softmax
    linF(pool, bn.W2.w, bn.b2.w, a2, n, P, H);
    for (r = 0; r < n * H; r++) if (a2[r] < 0) a2[r] = 0;
    linF(a2, bn.W3.w, bn.b3.w, probs, n, H, O);
    for (i = 0; i < n; i++) {
      var oo = i * O, zmax = -Infinity;
      for (o = 0; o < O; o++) if (probs[oo + o] > zmax) zmax = probs[oo + o];
      var dn = 0;
      for (o = 0; o < O; o++) { var eo = Math.exp(probs[oo + o] - zmax); probs[oo + o] = eo; dn += eo; }
      for (o = 0; o < O; o++) probs[oo + o] /= dn;
    }
    return probs;
  };

  function argmax(a, off, len) {
    var b = 0, bv = a[off];
    for (var k = 1; k < len; k++) if (a[off + k] > bv) { bv = a[off + k]; b = k; }
    return b;
  }

  // Loss/acc of the last forward pass. loss = plain cross-entropy (what the page charts);
  // objective = the label-smoothed cross-entropy that is actually optimised (used by the gradient check).
  Net.prototype._lossAcc = function (y, n) {
    var O = this.O, probs = this.probs, loss = 0, obj = 0, correct = 0, ls = this.labelSmoothing;
    for (var i = 0; i < n; i++) {
      var oo = i * O, ysum = 0, o;
      for (o = 0; o < O; o++) ysum += y[oo + o];
      for (o = 0; o < O; o++) {
        var lp = Math.log(Math.max(probs[oo + o], 1e-12)), yo = y[oo + o];
        if (yo > 0) loss -= yo * lp;
        obj -= ((1 - ls) * yo + ls * ysum / O) * lp;
      }
      if (argmax(probs, oo, O) === argmax(y, oo, O)) correct++;
    }
    return { loss: loss / n, acc: correct / n, objective: obj / n };
  };

  // Forward + backward; fills p.g with d(mean objective)/d(param). No update.
  Net.prototype.computeGradients = function (x, y, n) {
    this.forward(x, n);
    var res = this._lossAcc(y, n);
    var T = this.T, F = this.F, D = this.D, K = this.K, B = this.B, DQ = this.DQ, H = this.H, O = this.O;
    var NT = n * T, TD = T * D, NTD = NT * D, P = 2 * D, scale = 1 / Math.sqrt(DQ), ls = this.labelSmoothing;
    var bn = this.byName;
    for (var qi = 0; qi < this.params.length; qi++) this.params[qi].g.fill(0);
    var q = this.q, kk = this.k, v = this.v, att = this.att, amax = this.amax, pool = this.pool, a2 = this.a2, probs = this.probs;
    var dH = this.dH, dG = this.dG, dZ = this.dZ, dV = this.dV, dS = this.dS, dQ = this.dQ, dK = this.dK;
    var dPool = this.dPool, dA2 = this.dA2, dZ3 = this.dZ3;
    var invN = 1 / n, i, t, d, e, u, a, j, o, r, s;
    // softmax + (smoothed) cross-entropy
    for (i = 0; i < n; i++) {
      var oo = i * O, ysum = 0;
      for (o = 0; o < O; o++) ysum += y[oo + o];
      for (o = 0; o < O; o++) dZ3[oo + o] = (probs[oo + o] * ysum - ((1 - ls) * y[oo + o] + ls * ysum / O)) * invN;
    }
    // output + hidden dense
    dA2.fill(0, 0, n * H);
    linB(a2, bn.W3.w, dZ3, bn.W3.g, bn.b3.g, dA2, n, H, O);
    for (r = 0; r < n * H; r++) if (!(a2[r] > 0)) dA2[r] = 0;
    dPool.fill(0, 0, n * P);
    linB(pool, bn.W2.w, dA2, bn.W2.g, bn.b2.g, dPool, n, P, H);
    // pool -> dH (= d h3, and also d h2 via the attention residual)
    poolB(dPool, amax, dH, n, T, D);
    // attention backward: h3 = h2 + A v
    var h2 = this.hs[B];
    attB(q, kk, v, att, dH, dV, dS, dQ, dK, n, T, D, DQ, scale);
    linB(h2, bn.Wq.w, dQ, bn.Wq.g, null, dH, NT, D, DQ);
    linB(h2, bn.Wk.w, dK, bn.Wk.g, null, dH, NT, D, DQ);
    linB(h2, bn.Wv.w, dV, bn.Wv.g, bn.bv.g, dH, NT, D, D);
    // conv blocks backward (residual passes dH straight through; branch adds to it)
    for (j = B - 1; j >= 0; j--) {
      var rr = this.rs[j];
      for (r = 0; r < NTD; r++) dZ[r] = rr[r] > 0 ? dH[r] : 0;
      dG.fill(0, 0, NTD);
      linB(this.gs[j], bn['PW' + j].w, dZ, bn['PW' + j].g, bn['pb' + j].g, dG, NT, D, D);
      dwB(this.hs[j], bn['DW' + j].w, dG, bn['DW' + j].g, dH, n, T, D, K, this.dil[j]);
    }
    // input projection + positional encoding
    var gpos = bn.pos.g;
    for (i = 0; i < n; i++) { var hq = i * TD; for (r = 0; r < TD; r++) gpos[r] += dH[hq + r]; }
    linB(x, bn.Win.w, dH, bn.Win.g, bn.bin.g, null, NT, F, D);
    return res;
  };

  // AdamW with global-norm clipping. Returns pre-clip gradient norm.
  Net.prototype.applyGradients = function (lr) {
    var ps = this.params, sq = 0, i, q;
    for (q = 0; q < ps.length; q++) { var g = ps[q].g; for (i = 0; i < g.length; i++) sq += g[i] * g[i]; }
    var norm = Math.sqrt(sq);
    if (!isFinite(norm)) return norm;
    var sc = (this.clip > 0 && norm > this.clip) ? this.clip / norm : 1;
    this.t++;
    var b1 = this.beta1, b2 = this.beta2, eps = this.eps;
    var bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    var stepSize = lr / bc1, wd = lr * this.weightDecay;
    for (q = 0; q < ps.length; q++) {
      var P = ps[q], w = P.w, gg = P.g, m = P.m, v = P.v, decay = P.decay && wd > 0;
      for (i = 0; i < w.length; i++) {
        var gi = gg[i] * sc;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        var upd = stepSize * m[i] / (Math.sqrt(v[i] / bc2) + eps);
        w[i] -= decay ? upd + wd * w[i] : upd;
      }
    }
    return norm;
  };

  // One optimiser step on a batch. If the loss or gradients are non-finite, no update is made and loss is NaN.
  Net.prototype.trainBatch = function (x, y, n, lr) {
    if (n == null) n = Math.floor(y.length / this.O);
    var r = this.computeGradients(x, y, n);
    if (!isFinite(r.loss) || !isFinite(r.objective)) return { loss: NaN, acc: r.acc, gradNorm: NaN };
    var norm = this.applyGradients(lr == null ? 0.003 : lr);
    if (!isFinite(norm)) return { loss: NaN, acc: r.acc, gradNorm: norm };
    return { loss: r.loss, acc: r.acc, gradNorm: norm };
  };

  // Plain cross-entropy / accuracy / confusion. Can be called on a slice (the worker evaluates in chunks).
  Net.prototype.evaluate = function (x, y, n) {
    if (n == null) n = Math.floor(y.length / this.O);
    var O = this.O, S = this.T * this.F, chunk = 64, loss = 0, correct = 0;
    var confusion = [], perTotal = new Array(O), perOk = new Array(O), i, o;
    for (o = 0; o < O; o++) { confusion.push(new Array(O).fill(0)); perTotal[o] = 0; perOk[o] = 0; }
    for (var s = 0; s < n; s += chunk) {
      var m = Math.min(chunk, n - s);
      var xs = x.subarray ? x.subarray(s * S, (s + m) * S) : x.slice(s * S, (s + m) * S);
      var ys = y.subarray ? y.subarray(s * O, (s + m) * O) : y.slice(s * O, (s + m) * O);
      var probs = this.forward(xs, m);
      for (i = 0; i < m; i++) {
        var oo = i * O, tr = argmax(ys, oo, O), pr = argmax(probs, oo, O);
        for (o = 0; o < O; o++) if (ys[oo + o] > 0) loss -= ys[oo + o] * Math.log(Math.max(probs[oo + o], 1e-12));
        confusion[tr][pr]++;
        perTotal[tr]++;
        if (tr === pr) { correct++; perOk[tr]++; }
      }
    }
    var perClass = [];
    for (o = 0; o < O; o++) perClass.push(perTotal[o] ? perOk[o] / perTotal[o] : 0);
    return { loss: loss / n, acc: correct / n, confusion: confusion, perClass: perClass };
  };

  // Probabilities for ONE sample (x: FRAMES*FEATURES values). Returns a new Float32Array(O).
  Net.prototype.predict = function (x) {
    var probs = this.forward(x, 1), out = new Float32Array(this.O);
    for (var o = 0; o < this.O; o++) out[o] = probs[o];
    return out;
  };

  Net.prototype.resetOptimizer = function () {
    this.t = 0;
    for (var q = 0; q < this.params.length; q++) { this.params[q].m.fill(0); this.params[q].v.fill(0); }
  };

  Net.prototype.getWeights = function () {
    var out = {
      version: TKD.MODEL_VERSION,
      arch: { name: 'tcn-attn', frames: this.T, features: this.F, channels: this.D, kernel: this.K, blocks: this.B,
        dilations: this.dil.slice(), attnDim: this.DQ, hidden: this.H, classes: this.O }
    };
    for (var q = 0; q < this.params.length; q++) out[this.params[q].name] = new Float32Array(this.params[q].w);
    return out;
  };

  // Throws on version/shape mismatch (caller decides to discard). Resets the optimiser state.
  Net.prototype.setWeights = function (obj) {
    if (!obj) throw new Error('setWeights: no weights');
    if (obj.version !== TKD.MODEL_VERSION) throw new Error('setWeights: version mismatch ' + obj.version + ' != ' + TKD.MODEL_VERSION);
    var q, p;
    for (q = 0; q < this.params.length; q++) {
      p = this.params[q];
      var src = obj[p.name];
      if (!src || src.length !== p.w.length) throw new Error('setWeights: bad shape for ' + p.name);
      for (var i = 0; i < src.length; i++) if (!isFinite(src[i])) throw new Error('setWeights: non-finite value in ' + p.name);
    }
    for (q = 0; q < this.params.length; q++) { p = this.params[q]; p.w.set(obj[p.name]); }
    this.resetOptimizer();
  };

  // ---------------- visualisation (forward-only, cheap) ----------------
  // Logical layers for the page's network picture. weights = names of the param arrays in that layer.
  Net.prototype.layerInfo = function () {
    var T = this.T, D = this.D, bn = this.byName, out = [];
    function cnt(names) { var c = 0; names.forEach(function (n) { c += bn[n].w.length; }); return c; }
    function add(name, shape, weights, extra) {
      var L = { name: name, shape: shape, params: cnt(weights), weights: weights };
      if (extra) for (var k in extra) L[k] = extra[k];
      out.push(L);
    }
    add('input', [T, this.F], []);
    add('embed', [T, D], ['Win', 'bin', 'pos']);
    for (var j = 0; j < this.B; j++) add('conv' + (j + 1), [T, D], ['DW' + j, 'PW' + j, 'pb' + j], { kernel: this.K, dilation: this.dil[j] });
    add('attention', [T, D], ['Wq', 'Wk', 'Wv', 'bv']);
    add('pool', [2 * D], []);
    add('dense', [this.H], ['W2', 'b2']);
    add('output', [this.O], ['W3', 'b3']);
    return out;
  };
  // Average-pool a vector down to <= max values.
  function downsample(src, off, len, max) {
    var m = Math.min(len, max), out = new Float32Array(m);
    for (var i = 0; i < m; i++) {
      var a = Math.floor(i * len / m), b = Math.floor((i + 1) * len / m), s = 0;
      for (var k = a; k < b; k++) s += src[off + k];
      out[i] = s / (b - a);
    }
    return out;
  }
  function timeMean(src, T, C) { // [T][C] (first sample) -> mean over time [C]
    var out = new Float32Array(C);
    for (var t = 0; t < T; t++) for (var c = 0; c < C; c++) out[c] += src[t * C + c];
    for (c = 0; c < C; c++) out[c] /= T;
    return out;
  }
  // Forward ONE sample and describe every layer. prev: the snapshot returned by the previous call (or null).
  // Returns { layers: [{name, shape, params, activations (<=64), weightDelta, weightNorm}], probs, top, snapshot }.
  Net.prototype.visualize = function (x, prev) {
    var probs = this.forward(x, 1), T = this.T, D = this.D, info = this.layerInfo(), bn = this.byName, snap = {}, layers = [];
    var acts = { input: timeMean(x, T, this.F), embed: timeMean(this.hs[0], T, D), attention: timeMean(this.h3, T, D),
      pool: this.pool.subarray(0, 2 * D), dense: this.a2.subarray(0, this.H), output: probs.subarray(0, this.O) };
    for (var j = 0; j < this.B; j++) acts['conv' + (j + 1)] = timeMean(this.hs[j + 1], T, D);
    // mean attention each frame receives (which moments of the move the model looks at)
    var attn = new Float32Array(T);
    for (var t = 0; t < T; t++) for (var u = 0; u < T; u++) attn[u] += this.att[t * T + u] / T;
    info.forEach(function (L) {
      var a = acts[L.name], sq = 0, dsum = 0, n = 0, hasPrev = !!(prev && prev[L.name]);
      var cur = new Float32Array(L.params), o = 0;
      L.weights.forEach(function (nm) { cur.set(bn[nm].w, o); o += bn[nm].w.length; });
      for (var i = 0; i < cur.length; i++) { sq += cur[i] * cur[i]; if (hasPrev) dsum += Math.abs(cur[i] - prev[L.name][i]); n++; }
      snap[L.name] = cur;
      var out = { name: L.name, shape: L.shape, params: L.params, activations: downsample(a, 0, a.length, 64),
        weightDelta: hasPrev && n ? dsum / n : 0, weightNorm: Math.sqrt(sq) };
      if (L.name === 'attention') out.attention = attn;
      layers.push(out);
    });
    var pr = [], top = 0;
    for (var o2 = 0; o2 < this.O; o2++) { pr.push(probs[o2]); if (probs[o2] > probs[top]) top = o2; }
    return { layers: layers, probs: pr, top: top, snapshot: snap };
  };

  Net.prototype.paramCount = function () {
    var s = 0;
    for (var q = 0; q < this.params.length; q++) s += this.params[q].w.length;
    return s;
  };
  Net.prototype.modelBytes = function () { return this.paramCount() * 4; }; // saved as Float32Array

  TKD.Net = Net;
  TKD._kernels = { linF: linF, linB: linB, dwF: dwF, dwB: dwB, attF: attF, attB: attB, poolB: poolB }; // for tests/benchmarks
  // =====================================================================================
  // 'large' model (opt-in, start {size:'large'}). Separate class so the base model is untouched.
  //   embed: Win*x + bin + pos
  //   4 pre-norm residual temporal-conv blocks: h += Dropout(ReLU(PW * dwconv_k,d(LN(h)) + pb))   k/d = 5/1, 5/2, 3/4, 3/8
  //   2 pre-norm transformer encoder layers:  h += Dropout(Wo * MHA_4heads(LN(h)) + bo);  h += Dropout(F2 * ReLU(F1 * LN(h) + f1b) + f2b)
  //   final LN -> [attention pooling over time, mean over time] (2D) -> Dense(H) ReLU Dropout -> Dense(O) -> softmax
  // Dropout (inverted, rate 0.1) only when training; masks come from a seed, so a step is reproducible.
  // =====================================================================================
  TKD.MODEL_VERSION_LARGE = 'tcn-attn-v2-large';
  TKD.MODEL_NAME_LARGE = 'TKD-Net v2 large: 4 dilated conv blocks + 2 transformer layers (4 heads)';
  TKD.MODEL_VERSIONS = { base: TKD.MODEL_VERSION, large: TKD.MODEL_VERSION_LARGE };

  // LayerNorm over the last dim (D) of R rows. Caches xhat and rstd for backward.
  function lnF(X, g, b, Y, xhat, rstd, R, D) {
    var invD = 1 / D;
    for (var r = 0; r < R; r++) {
      var o = r * D, m = 0, v = 0, d;
      for (d = 0; d < D; d++) m += X[o + d];
      m *= invD;
      for (d = 0; d < D; d++) { var c = X[o + d] - m; v += c * c; }
      var rs = 1 / Math.sqrt(v * invD + 1e-5);
      rstd[r] = rs;
      for (d = 0; d < D; d++) { var xh = (X[o + d] - m) * rs; xhat[o + d] = xh; Y[o + d] = xh * g[d] + b[d]; }
    }
  }
  // Adds d(loss)/dX into dX; accumulates gamma/beta grads.
  function lnB(dY, g, xhat, rstd, gg, gb, dX, R, D) {
    var invD = 1 / D;
    for (var r = 0; r < R; r++) {
      var o = r * D, m1 = 0, m2 = 0, d;
      for (d = 0; d < D; d++) {
        var dy = dY[o + d], xh = xhat[o + d], dyh = dy * g[d];
        gg[d] += dy * xh; gb[d] += dy;
        m1 += dyh; m2 += dyh * xh;
      }
      m1 *= invD; m2 *= invD;
      var rs = rstd[r];
      for (d = 0; d < D; d++) dX[o + d] += rs * (dY[o + d] * g[d] - m1 - xhat[o + d] * m2);
    }
  }
  // Multi-head self-attention core: Out[t][h*DH+a] = sum_u softmax_u(Q_h[t].K_h[u]*scale) V[u][h*DH+a]
  function mhaF(Q, K, V, P, Out, n, T, D, NH) {
    var DH = D / NH, scale = 1 / Math.sqrt(DH), TD = T * D, TT = T * T;
    for (var i = 0; i < n; i++) {
      var so = i * TD;
      for (var h = 0; h < NH; h++) {
        var hs = h * DH, po = (i * NH + h) * TT;
        for (var t = 0; t < T; t++) {
          var qt = so + t * D + hs, pr = po + t * T, mx = -Infinity, u, a, s;
          for (u = 0; u < T; u++) {
            var ku = so + u * D + hs;
            s = 0;
            for (a = 0; a < DH; a++) s += Q[qt + a] * K[ku + a];
            s *= scale; P[pr + u] = s; if (s > mx) mx = s;
          }
          var den = 0;
          for (u = 0; u < T; u++) { var e = Math.exp(P[pr + u] - mx); P[pr + u] = e; den += e; }
          var inv = 1 / den;
          for (u = 0; u < T; u++) P[pr + u] *= inv;
          var ot = so + t * D + hs;
          for (a = 0; a < DH; a++) Out[ot + a] = 0;
          for (u = 0; u < T; u++) {
            var p = P[pr + u], vu = so + u * D + hs;
            for (a = 0; a < DH; a++) Out[ot + a] += p * V[vu + a];
          }
        }
      }
    }
  }
  function mhaB(Q, K, V, P, dOut, dQ, dK, dV, dProw, n, T, D, NH) {
    var DH = D / NH, scale = 1 / Math.sqrt(DH), TD = T * D, TT = T * T;
    dQ.fill(0, 0, n * TD); dK.fill(0, 0, n * TD); dV.fill(0, 0, n * TD);
    for (var i = 0; i < n; i++) {
      var so = i * TD;
      for (var h = 0; h < NH; h++) {
        var hs = h * DH, po = (i * NH + h) * TT;
        for (var t = 0; t < T; t++) {
          var ot = so + t * D + hs, pr = po + t * T, dot = 0, u, a, s;
          for (u = 0; u < T; u++) {
            var vu = so + u * D + hs, p = P[pr + u];
            s = 0;
            for (a = 0; a < DH; a++) { var go = dOut[ot + a]; s += go * V[vu + a]; dV[vu + a] += p * go; }
            dProw[u] = s; dot += p * s;
          }
          for (u = 0; u < T; u++) {
            var ds = P[pr + u] * (dProw[u] - dot) * scale;
            if (ds === 0) continue;
            var ku = so + u * D + hs;
            for (a = 0; a < DH; a++) { dQ[ot + a] += ds * K[ku + a]; dK[ku + a] += ds * Q[ot + a]; }
          }
        }
      }
    }
  }
  // inverted dropout: mask = 0 or 1/(1-p); train=false -> mask 1
  function dropMask(mask, len, p, rng) {
    if (!rng || !(p > 0)) { mask.fill(1, 0, len); return; }
    var keep = 1 / (1 - p);
    for (var i = 0; i < len; i++) mask[i] = rng() < p ? 0 : keep;
  }

  var LARGE_CONVS = [{ k: 5, d: 1 }, { k: 5, d: 2 }, { k: 3, d: 4 }, { k: 3, d: 8 }];
  function NetLarge(opts) {
    opts = opts || {};
    var A = this.A = opts.float64 ? Float64Array : Float32Array;
    var dm = TKD.dims();
    this.size = 'large';
    this.version = TKD.MODEL_VERSION_LARGE;
    this.T = dm.T; this.F = dm.F; this.O = dm.O;
    var D = this.D = opts.channels || 48;
    this.NH = opts.heads || 4;
    if (D % this.NH) throw new Error('channels must be a multiple of heads');
    this.convs = opts.convs || LARGE_CONVS;
    this.L = opts.layers == null ? 2 : opts.layers;
    this.FF = opts.ffn || 2 * D;
    this.H = opts.hidden || 64;
    this.pDrop = opts.dropout == null ? 0.1 : opts.dropout;
    this.labelSmoothing = opts.labelSmoothing == null ? 0.05 : opts.labelSmoothing;
    this.seed = (opts.seed == null ? 1 : opts.seed) >>> 0;
    this.weightDecay = opts.weightDecay == null ? 1e-4 : opts.weightDecay;
    this.clip = opts.clip == null ? 5 : opts.clip;
    this.beta1 = 0.9; this.beta2 = 0.999; this.eps = 1e-8;
    var T = this.T, F = this.F, H = this.H, O = this.O, FF = this.FF, self = this, rng = TKD.makeRng(this.seed || 1);
    function param(name, size, std, decay, fillv) {
      var w = new A(size), i;
      if (fillv) for (i = 0; i < size; i++) w[i] = fillv;
      else if (std > 0) for (i = 0; i < size; i++) w[i] = gaussian(rng) * std;
      return { name: name, w: w, g: new A(size), m: new A(size), v: new A(size), decay: decay };
    }
    var ps = [param('Win', D * F, Math.sqrt(1 / F), true), param('bin', D, 0, false), param('pos', T * D, 0.1, false)], j, l;
    for (j = 0; j < this.convs.length; j++) {
      var k = this.convs[j].k;
      ps.push(param('c' + j + 'g', D, 0, false, 1), param('c' + j + 'b', D, 0, false));
      ps.push(param('c' + j + 'DW', D * k, Math.sqrt(1 / k), true), param('c' + j + 'PW', D * D, Math.sqrt(1 / D), true), param('c' + j + 'pb', D, 0, false));
    }
    for (l = 0; l < this.L; l++) {
      var e = 'e' + l;
      ps.push(param(e + 'ag', D, 0, false, 1), param(e + 'ab', D, 0, false));
      ps.push(param(e + 'Wq', D * D, Math.sqrt(1 / D), true), param(e + 'bq', D, 0, false));
      ps.push(param(e + 'Wk', D * D, Math.sqrt(1 / D), true)); // no key bias: softmax over keys is invariant to it (its gradient is exactly 0)
      ps.push(param(e + 'Wv', D * D, Math.sqrt(1 / D), true), param(e + 'bv', D, 0, false));
      ps.push(param(e + 'Wo', D * D, Math.sqrt(0.5 / D), true), param(e + 'bo', D, 0, false));
      ps.push(param(e + 'fg', D, 0, false, 1), param(e + 'fb', D, 0, false));
      ps.push(param(e + 'F1', FF * D, Math.sqrt(2 / D), true), param(e + 'f1b', FF, 0, false));
      ps.push(param(e + 'F2', D * FF, Math.sqrt(0.5 / FF), true), param(e + 'f2b', D, 0, false));
    }
    ps.push(param('og', D, 0, false, 1), param('ob', D, 0, false), param('wp', D, Math.sqrt(1 / D), true));
    ps.push(param('Wd', H * 2 * D, Math.sqrt(2 / (2 * D)), true), param('bd', H, 0, false));
    ps.push(param('Wout', O * H, Math.sqrt(1 / H), true), param('bout', O, 0, false));
    this.params = ps;
    this.byName = {};
    ps.forEach(function (p) { self.byName[p.name] = p; });
    this.t = 0; this.cap = 0;
    this.dProw = new A(T);
  }

  NetLarge.prototype._ensure = function (n) {
    if (n <= this.cap) return;
    var A = this.A, T = this.T, D = this.D, R = n * T, RD = R * D, C = this.convs.length, L = this.L, j;
    this.cap = n;
    function f(len) { return new A(len); }
    this.S = []; for (j = 0; j < 1 + C + 2 * L; j++) this.S.push(f(RD)); // residual stream states
    this.cv = [];
    for (j = 0; j < C; j++) this.cv.push({ xh: f(RD), rs: f(R), a: f(RD), g: f(RD), r: f(RD), m: f(RD) });
    this.en = [];
    for (j = 0; j < L; j++) this.en.push({ xhA: f(RD), rsA: f(R), uA: f(RD), Q: f(RD), K: f(RD), V: f(RD), P: f(n * this.NH * T * T),
      Oc: f(RD), Po: f(RD), mA: f(RD), xhF: f(RD), rsF: f(R), uF: f(RD), f1: f(R * this.FF), f2: f(RD), mF: f(RD) });
    this.xhO = f(RD); this.rsO = f(R); this.hf = f(RD);
    this.alpha = f(n * T); this.pool = f(n * 2 * D); this.d1 = f(n * this.H); this.mD = f(n * this.H); this.dd = f(n * this.H);
    this.probs = f(n * this.O);
    // backward
    this.dS = f(RD); this.dT1 = f(RD); this.dT2 = f(RD); this.dQ = f(RD); this.dK = f(RD); this.dV = f(RD); this.dF1 = f(R * this.FF);
    this.dPool = f(n * 2 * D); this.dDD = f(n * this.H); this.dZ3 = f(n * this.O);
  };

  // train: apply dropout with masks from makeRng(seed). Returns probs.
  NetLarge.prototype.forward = function (x, n, train, seed) {
    var T = this.T, F = this.F, D = this.D, H = this.H, O = this.O, FF = this.FF, C = this.convs.length, L = this.L;
    if (n == null) n = Math.floor(x.length / (T * F));
    this._ensure(n);
    var bn = this.byName, R = n * T, RD = R * D, TD = T * D, i, r, j, l, s;
    var rng = train && this.pDrop > 0 ? TKD.makeRng(seed >>> 0) : null, p = this.pDrop;
    this._train = !!rng;
    var S0 = this.S[0], pos = bn.pos.w;
    linF(x, bn.Win.w, bn.bin.w, S0, R, F, D);
    for (i = 0; i < n; i++) { var hb = i * TD; for (r = 0; r < TD; r++) S0[hb + r] += pos[r]; }
    var si = 0;
    for (j = 0; j < C; j++) {
      var cj = this.cv[j], c = 'c' + j, Sin = this.S[si], Sout = this.S[si + 1];
      lnF(Sin, bn[c + 'g'].w, bn[c + 'b'].w, cj.a, cj.xh, cj.rs, R, D);
      dwF(cj.a, bn[c + 'DW'].w, cj.g, n, T, D, this.convs[j].k, this.convs[j].d);
      linF(cj.g, bn[c + 'PW'].w, bn[c + 'pb'].w, cj.r, R, D, D);
      dropMask(cj.m, RD, p, rng);
      for (r = 0; r < RD; r++) { s = cj.r[r]; if (s < 0) { s = 0; cj.r[r] = 0; } Sout[r] = Sin[r] + s * cj.m[r]; }
      si++;
    }
    for (l = 0; l < L; l++) {
      var E = this.en[l], e = 'e' + l, S1 = this.S[si], S2 = this.S[si + 1], S3 = this.S[si + 2];
      lnF(S1, bn[e + 'ag'].w, bn[e + 'ab'].w, E.uA, E.xhA, E.rsA, R, D);
      linF(E.uA, bn[e + 'Wq'].w, bn[e + 'bq'].w, E.Q, R, D, D);
      linF(E.uA, bn[e + 'Wk'].w, null, E.K, R, D, D);
      linF(E.uA, bn[e + 'Wv'].w, bn[e + 'bv'].w, E.V, R, D, D);
      mhaF(E.Q, E.K, E.V, E.P, E.Oc, n, T, D, this.NH);
      linF(E.Oc, bn[e + 'Wo'].w, bn[e + 'bo'].w, E.Po, R, D, D);
      dropMask(E.mA, RD, p, rng);
      for (r = 0; r < RD; r++) S2[r] = S1[r] + E.Po[r] * E.mA[r];
      lnF(S2, bn[e + 'fg'].w, bn[e + 'fb'].w, E.uF, E.xhF, E.rsF, R, D);
      linF(E.uF, bn[e + 'F1'].w, bn[e + 'f1b'].w, E.f1, R, D, FF);
      for (r = 0; r < R * FF; r++) if (E.f1[r] < 0) E.f1[r] = 0;
      linF(E.f1, bn[e + 'F2'].w, bn[e + 'f2b'].w, E.f2, R, FF, D);
      dropMask(E.mF, RD, p, rng);
      for (r = 0; r < RD; r++) S3[r] = S2[r] + E.f2[r] * E.mF[r];
      si += 2;
    }
    var Sl = this.S[si], hf = this.hf, wp = bn.wp.w, alpha = this.alpha, pool = this.pool, P2 = 2 * D;
    lnF(Sl, bn.og.w, bn.ob.w, hf, this.xhO, this.rsO, R, D);
    for (i = 0; i < n; i++) {
      var ho = i * TD, ao = i * T, mx = -Infinity, t, d;
      for (t = 0; t < T; t++) { s = 0; for (d = 0; d < D; d++) s += wp[d] * hf[ho + t * D + d]; alpha[ao + t] = s; if (s > mx) mx = s; }
      var den = 0;
      for (t = 0; t < T; t++) { var ex = Math.exp(alpha[ao + t] - mx); alpha[ao + t] = ex; den += ex; }
      for (t = 0; t < T; t++) alpha[ao + t] /= den;
      var po = i * P2;
      for (d = 0; d < P2; d++) pool[po + d] = 0;
      for (t = 0; t < T; t++) {
        var at = alpha[ao + t], hr = ho + t * D;
        for (d = 0; d < D; d++) { pool[po + d] += at * hf[hr + d]; pool[po + D + d] += hf[hr + d] / T; }
      }
    }
    var d1 = this.d1, dd = this.dd, mD = this.mD;
    linF(pool, bn.Wd.w, bn.bd.w, d1, n, P2, H);
    dropMask(mD, n * H, p, rng);
    for (r = 0; r < n * H; r++) { if (d1[r] < 0) d1[r] = 0; dd[r] = d1[r] * mD[r]; }
    var probs = this.probs;
    linF(dd, bn.Wout.w, bn.bout.w, probs, n, H, O);
    for (i = 0; i < n; i++) {
      var oo = i * O, zm = -Infinity, o;
      for (o = 0; o < O; o++) if (probs[oo + o] > zm) zm = probs[oo + o];
      var dn = 0;
      for (o = 0; o < O; o++) { var eo = Math.exp(probs[oo + o] - zm); probs[oo + o] = eo; dn += eo; }
      for (o = 0; o < O; o++) probs[oo + o] /= dn;
    }
    return probs;
  };

  NetLarge.prototype._lossAcc = Net.prototype._lossAcc;

  // Forward (train mode, dropout seed) + backward. opts: {accumulate: keep existing grads, invN: 1/total batch, seed}
  NetLarge.prototype.computeGradients = function (x, y, n, opts) {
    opts = opts || {};
    this.forward(x, n, opts.train !== false, opts.seed == null ? 1 : opts.seed);
    var res = this._lossAcc(y, n);
    var T = this.T, F = this.F, D = this.D, H = this.H, O = this.O, FF = this.FF, C = this.convs.length, L = this.L;
    var bn = this.byName, R = n * T, RD = R * D, TD = T * D, P2 = 2 * D, ls = this.labelSmoothing, i, r, j, l, t, d, o;
    if (!opts.accumulate) for (var q = 0; q < this.params.length; q++) this.params[q].g.fill(0);
    var invN = opts.invN == null ? 1 / n : opts.invN, probs = this.probs, dZ3 = this.dZ3;
    for (i = 0; i < n; i++) {
      var oo = i * O, ysum = 0;
      for (o = 0; o < O; o++) ysum += y[oo + o];
      for (o = 0; o < O; o++) dZ3[oo + o] = (probs[oo + o] * ysum - ((1 - ls) * y[oo + o] + ls * ysum / O)) * invN;
    }
    var dDD = this.dDD, d1 = this.d1, mD = this.mD;
    dDD.fill(0, 0, n * H);
    linB(this.dd, bn.Wout.w, dZ3, bn.Wout.g, bn.bout.g, dDD, n, H, O);
    for (r = 0; r < n * H; r++) dDD[r] = d1[r] > 0 ? dDD[r] * mD[r] : 0;
    var dPool = this.dPool;
    dPool.fill(0, 0, n * P2);
    linB(this.pool, bn.Wd.w, dDD, bn.Wd.g, bn.bd.g, dPool, n, P2, H);
    // pooling backward -> dT1 = d hf
    var hf = this.hf, alpha = this.alpha, wp = bn.wp.w, gwp = bn.wp.g, dHf = this.dT1, dPr = this.dProw;
    for (i = 0; i < n; i++) {
      var ho = i * TD, ao = i * T, po = i * P2, dot = 0;
      for (t = 0; t < T; t++) {
        var hr = ho + t * D, at = alpha[ao + t], da = 0;
        for (d = 0; d < D; d++) { var dpa = dPool[po + d]; da += dpa * hf[hr + d]; dHf[hr + d] = at * dpa + dPool[po + D + d] / T; }
        dPr[t] = da; dot += at * da;
      }
      for (t = 0; t < T; t++) {
        var ds = alpha[ao + t] * (dPr[t] - dot), hr2 = ho + t * D;
        for (d = 0; d < D; d++) { gwp[d] += ds * hf[hr2 + d]; dHf[hr2 + d] += ds * wp[d]; }
      }
    }
    var dS = this.dS;
    dS.fill(0, 0, RD);
    lnB(dHf, bn.og.w, this.xhO, this.rsO, bn.og.g, bn.ob.g, dS, R, D);
    var si = C + 2 * L, dA = this.dT1, dB = this.dT2;
    for (l = L - 1; l >= 0; l--) {
      var E = this.en[l], e = 'e' + l;
      // FFN: S3 = S2 + f2 * mF
      for (r = 0; r < RD; r++) dA[r] = dS[r] * E.mF[r];
      var dF1 = this.dF1;
      dF1.fill(0, 0, R * FF);
      linB(E.f1, bn[e + 'F2'].w, dA, bn[e + 'F2'].g, bn[e + 'f2b'].g, dF1, R, FF, D);
      for (r = 0; r < R * FF; r++) if (!(E.f1[r] > 0)) dF1[r] = 0;
      dB.fill(0, 0, RD);
      linB(E.uF, bn[e + 'F1'].w, dF1, bn[e + 'F1'].g, bn[e + 'f1b'].g, dB, R, D, FF);
      lnB(dB, bn[e + 'fg'].w, E.xhF, E.rsF, bn[e + 'fg'].g, bn[e + 'fb'].g, dS, R, D);
      // attention: S2 = S1 + Po * mA
      for (r = 0; r < RD; r++) dA[r] = dS[r] * E.mA[r];
      dB.fill(0, 0, RD);
      linB(E.Oc, bn[e + 'Wo'].w, dA, bn[e + 'Wo'].g, bn[e + 'bo'].g, dB, R, D, D);
      mhaB(E.Q, E.K, E.V, E.P, dB, this.dQ, this.dK, this.dV, this.dProw, n, T, D, this.NH);
      dA.fill(0, 0, RD);
      linB(E.uA, bn[e + 'Wq'].w, this.dQ, bn[e + 'Wq'].g, bn[e + 'bq'].g, dA, R, D, D);
      linB(E.uA, bn[e + 'Wk'].w, this.dK, bn[e + 'Wk'].g, null, dA, R, D, D);
      linB(E.uA, bn[e + 'Wv'].w, this.dV, bn[e + 'Wv'].g, bn[e + 'bv'].g, dA, R, D, D);
      lnB(dA, bn[e + 'ag'].w, E.xhA, E.rsA, bn[e + 'ag'].g, bn[e + 'ab'].g, dS, R, D);
    }
    for (j = C - 1; j >= 0; j--) {
      var cj = this.cv[j], c = 'c' + j;
      for (r = 0; r < RD; r++) dA[r] = cj.r[r] > 0 ? dS[r] * cj.m[r] : 0;
      dB.fill(0, 0, RD);
      linB(cj.g, bn[c + 'PW'].w, dA, bn[c + 'PW'].g, bn[c + 'pb'].g, dB, R, D, D);
      dA.fill(0, 0, RD);
      dwB(cj.a, bn[c + 'DW'].w, dB, bn[c + 'DW'].g, dA, n, T, D, this.convs[j].k, this.convs[j].d);
      lnB(dA, bn[c + 'g'].w, cj.xh, cj.rs, bn[c + 'g'].g, bn[c + 'b'].g, dS, R, D);
    }
    var gpos = bn.pos.g;
    for (i = 0; i < n; i++) { var hq = i * TD; for (r = 0; r < TD; r++) gpos[r] += dS[hq + r]; }
    linB(x, bn.Win.w, dS, bn.Win.g, bn.bin.g, null, R, F, D);
    return res;
  };

  NetLarge.prototype.applyGradients = Net.prototype.applyGradients;
  NetLarge.prototype.resetOptimizer = Net.prototype.resetOptimizer;
  NetLarge.prototype.paramCount = Net.prototype.paramCount;
  NetLarge.prototype.modelBytes = Net.prototype.modelBytes;
  NetLarge.prototype.zeroGrad = function () { for (var q = 0; q < this.params.length; q++) this.params[q].g.fill(0); };

  // Full step on a batch (tests/bench). The worker instead calls computeGradients on micro-batches with accumulate + invN.
  NetLarge.prototype.trainBatch = function (x, y, n, lr, seed) {
    if (n == null) n = Math.floor(y.length / this.O);
    var r = this.computeGradients(x, y, n, { seed: seed == null ? 1 : seed });
    if (!isFinite(r.loss) || !isFinite(r.objective)) return { loss: NaN, acc: r.acc, gradNorm: NaN };
    var norm = this.applyGradients(lr == null ? 0.003 : lr);
    if (!isFinite(norm)) return { loss: NaN, acc: r.acc, gradNorm: norm };
    return { loss: r.loss, acc: r.acc, gradNorm: norm };
  };

  NetLarge.prototype.evaluate = function (x, y, n) {
    if (n == null) n = Math.floor(y.length / this.O);
    var O = this.O, S = this.T * this.F, chunk = 16, loss = 0, correct = 0;
    var confusion = [], perTotal = new Array(O), perOk = new Array(O), i, o;
    for (o = 0; o < O; o++) { confusion.push(new Array(O).fill(0)); perTotal[o] = 0; perOk[o] = 0; }
    for (var s = 0; s < n; s += chunk) {
      var m = Math.min(chunk, n - s);
      var xs = x.subarray ? x.subarray(s * S, (s + m) * S) : x.slice(s * S, (s + m) * S);
      var ys = y.subarray ? y.subarray(s * O, (s + m) * O) : y.slice(s * O, (s + m) * O);
      var probs = this.forward(xs, m, false);
      for (i = 0; i < m; i++) {
        var oo = i * O, tr = argmax(ys, oo, O), pr = argmax(probs, oo, O);
        for (o = 0; o < O; o++) if (ys[oo + o] > 0) loss -= ys[oo + o] * Math.log(Math.max(probs[oo + o], 1e-12));
        confusion[tr][pr]++; perTotal[tr]++;
        if (tr === pr) { correct++; perOk[tr]++; }
      }
    }
    var perClass = [];
    for (o = 0; o < O; o++) perClass.push(perTotal[o] ? perOk[o] / perTotal[o] : 0);
    return { loss: loss / n, acc: correct / n, confusion: confusion, perClass: perClass };
  };
  NetLarge.prototype.predict = function (x) {
    var probs = this.forward(x, 1, false), out = new Float32Array(this.O);
    for (var o = 0; o < this.O; o++) out[o] = probs[o];
    return out;
  };
  NetLarge.prototype.getWeights = function () {
    var out = { version: this.version, size: 'large',
      arch: { name: 'tcn-attn-large', frames: this.T, features: this.F, channels: this.D, convs: this.convs.map(function (c) { return { k: c.k, d: c.d }; }),
        layers: this.L, heads: this.NH, ffn: this.FF, hidden: this.H, dropout: this.pDrop, classes: this.O } };
    for (var q = 0; q < this.params.length; q++) out[this.params[q].name] = new Float32Array(this.params[q].w);
    return out;
  };
  NetLarge.prototype.setWeights = function (obj) {
    if (!obj) throw new Error('setWeights: no weights');
    if (obj.version !== this.version) throw new Error('setWeights: version mismatch ' + obj.version + ' != ' + this.version);
    var q, p;
    for (q = 0; q < this.params.length; q++) {
      p = this.params[q];
      var src = obj[p.name];
      if (!src || src.length !== p.w.length) throw new Error('setWeights: bad shape for ' + p.name);
      for (var i = 0; i < src.length; i++) if (!isFinite(src[i])) throw new Error('setWeights: non-finite value in ' + p.name);
    }
    for (q = 0; q < this.params.length; q++) { p = this.params[q]; p.w.set(obj[p.name]); }
    this.resetOptimizer();
  };
  NetLarge.prototype.layerInfo = function () {
    var T = this.T, D = this.D, bn = this.byName, out = [], j;
    function cnt(prefix, names) { var c = 0; names.forEach(function (nm) { c += bn[prefix + nm].w.length; }); return c; }
    function add(name, shape, weights, extra) {
      var c = 0; weights.forEach(function (nm) { c += bn[nm].w.length; });
      var L = { name: name, shape: shape, params: c, weights: weights };
      if (extra) for (var k in extra) L[k] = extra[k];
      out.push(L);
    }
    add('input', [T, this.F], []);
    add('embed', [T, D], ['Win', 'bin', 'pos']);
    for (j = 0; j < this.convs.length; j++) add('conv' + (j + 1), [T, D], ['g', 'b', 'DW', 'PW', 'pb'].map(function (s) { return 'c' + j + s; }), { kernel: this.convs[j].k, dilation: this.convs[j].d });
    for (j = 0; j < this.L; j++) add('encoder' + (j + 1), [T, D], ['ag', 'ab', 'Wq', 'bq', 'Wk', 'Wv', 'bv', 'Wo', 'bo', 'fg', 'fb', 'F1', 'f1b', 'F2', 'f2b'].map(function (s) { return 'e' + j + s; }), { heads: this.NH, ffn: this.FF });
    add('pool', [2 * D], ['og', 'ob', 'wp']);
    add('dense', [this.H], ['Wd', 'bd']);
    add('output', [this.O], ['Wout', 'bout']);
    return out;
  };
  NetLarge.prototype.visualize = function (x, prev) {
    var probs = this.forward(x, 1, false), T = this.T, D = this.D, info = this.layerInfo(), bn = this.byName, snap = {}, layers = [];
    var acts = { input: timeMean(x, T, this.F), embed: timeMean(this.S[0], T, D), pool: this.pool.subarray(0, 2 * D),
      dense: this.d1.subarray(0, this.H), output: probs.subarray(0, this.O) };
    var C = this.convs.length, j;
    for (j = 0; j < C; j++) acts['conv' + (j + 1)] = timeMean(this.S[j + 1], T, D);
    for (j = 0; j < this.L; j++) acts['encoder' + (j + 1)] = timeMean(this.S[C + 2 * j + 2], T, D);
    var attn = new Float32Array(T), E = this.en[this.L - 1], NH = this.NH;
    if (E) for (var h = 0; h < NH; h++) for (var t = 0; t < T; t++) for (var u = 0; u < T; u++) attn[u] += E.P[(h * T + t) * T + u] / (T * NH);
    info.forEach(function (L) {
      var a = acts[L.name], sq = 0, dsum = 0, hasPrev = !!(prev && prev[L.name]);
      var cur = new Float32Array(L.params), o = 0;
      L.weights.forEach(function (nm) { cur.set(bn[nm].w, o); o += bn[nm].w.length; });
      for (var i = 0; i < cur.length; i++) { sq += cur[i] * cur[i]; if (hasPrev) dsum += Math.abs(cur[i] - prev[L.name][i]); }
      snap[L.name] = cur;
      var outL = { name: L.name, shape: L.shape, params: L.params, activations: downsample(a, 0, a.length, 64),
        weightDelta: hasPrev && cur.length ? dsum / cur.length : 0, weightNorm: Math.sqrt(sq) };
      if (L.name === 'encoder' + NetLarge_last(info)) outL.attention = attn;
      layers.push(outL);
    });
    var pr = [], top = 0;
    for (var o2 = 0; o2 < this.O; o2++) { pr.push(probs[o2]); if (probs[o2] > probs[top]) top = o2; }
    return { layers: layers, probs: pr, top: top, snapshot: snap };
  };
  function NetLarge_last(info) { var k = 0; info.forEach(function (L) { if (/^encoder/.test(L.name)) k++; }); return k; }
  TKD.NetLarge = NetLarge;
  TKD._kernels.lnF = lnF; TKD._kernels.lnB = lnB; TKD._kernels.mhaF = mhaF; TKD._kernels.mhaB = mhaB;
  // Build a net for a size ('base' | 'large'); unknown sizes give base.
  TKD.makeNet = function (size, opts) { return size === 'large' ? new NetLarge(opts) : new Net(opts); };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
