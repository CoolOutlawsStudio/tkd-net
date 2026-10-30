/* TKD-Net nn.js (owner: Moneyman)
 * From-scratch neural network on typed arrays. Classic script, no dependencies.
 * Architecture: Conv1D over time (kernel 3, same padding, C filters) -> ReLU
 *   -> global mean+max pool over time (2C) -> Dense(H) -> ReLU -> Dense(9) -> softmax.
 * Loss: cross-entropy. Optimiser: Adam with decoupled weight decay (AdamW) and global-norm gradient clipping.
 * Works in a classic Web Worker (importScripts), in a page (<script>), and in node (tests).
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};

  TKD.CLASSES = ['ready', 'front_kick', 'roundhouse', 'side_kick', 'back_kick', 'axe_kick', 'low_block', 'high_block', 'punch'];
  TKD.FRAMES = 16;
  TKD.JOINTS = 17;
  TKD.FEATURES = 34;
  TKD.NCLASSES = 9;
  // Bump when the architecture / weight layout changes. Saved weights with another version are discarded.
  TKD.MODEL_VERSION = 'conv1d-k3-meanmax-v1';

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

  function Net(opts) {
    opts = opts || {};
    var A = this.A = opts.float64 ? Float64Array : Float32Array; // float64 only for gradient-check tests
    this.T = TKD.FRAMES;
    this.F = TKD.FEATURES;
    this.K = 3;
    this.C = opts.filters || 32;
    this.H = opts.hidden || 64;
    this.O = TKD.NCLASSES;
    this.KF = this.K * this.F;
    this.P = 2 * this.C;
    this.seed = (opts.seed == null ? 1 : opts.seed) >>> 0;
    this.weightDecay = opts.weightDecay == null ? 1e-4 : opts.weightDecay;
    this.clip = opts.clip == null ? 5 : opts.clip;
    this.beta1 = 0.9; this.beta2 = 0.999; this.eps = 1e-8;

    var rng = TKD.makeRng(this.seed || 1);
    var self = this;
    function param(name, size, std, decay) {
      var w = new A(size);
      if (std > 0) for (var i = 0; i < size; i++) w[i] = gaussian(rng) * std;
      return { name: name, w: w, g: new A(size), m: new A(size), v: new A(size), decay: decay };
    }
    // Layouts: W1[c][k*F+f], W2[h][p], W3[o][h]
    this.params = [
      param('W1', this.C * this.KF, Math.sqrt(2 / this.KF), true),
      param('b1', this.C, 0, false),
      param('W2', this.H * this.P, Math.sqrt(2 / this.P), true),
      param('b2', this.H, 0, false),
      param('W3', this.O * this.H, Math.sqrt(1 / this.H), true),
      param('b3', this.O, 0, false)
    ];
    this.byName = {};
    this.params.forEach(function (p) { self.byName[p.name] = p; });
    this.t = 0; // Adam step count
    this.cap = 0;
    // per-sample backward scratch
    this.dz3 = new A(this.O); this.da2 = new A(this.H); this.dz2 = new A(this.H);
    this.dpool = new A(this.P); this.dz1 = new A(this.T * this.C);
  }

  Net.prototype._ensure = function (n) {
    if (n <= this.cap) return;
    var A = this.A;
    this.cap = n;
    this.a1 = new A(n * this.T * this.C);
    this.amax = new Uint8Array(n * this.C);
    this.pool = new A(n * this.P);
    this.a2 = new A(n * this.H);
    this.probs = new A(n * this.O);
  };

  // Forward pass for n samples. Fills internal caches; returns probs (length >= n*9, first n*9 valid).
  Net.prototype.forward = function (x, n) {
    if (n == null) n = Math.floor(x.length / (this.T * this.F));
    this._ensure(n);
    var T = this.T, F = this.F, C = this.C, H = this.H, O = this.O, KF = this.KF, P = this.P;
    var W1 = this.byName.W1.w, b1 = this.byName.b1.w, W2 = this.byName.W2.w, b2 = this.byName.b2.w;
    var W3 = this.byName.W3.w, b3 = this.byName.b3.w;
    var a1 = this.a1, amax = this.amax, pool = this.pool, a2 = this.a2, probs = this.probs;
    for (var i = 0; i < n; i++) {
      var xo = i * T * F;
      var ao = i * T * C;
      // conv1d, same padding: frame t sees frames t-1, t, t+1 which are contiguous in x
      for (var t = 0; t < T; t++) {
        var k0 = t === 0 ? 1 : 0, k1 = t === T - 1 ? 2 : 3;
        var xs = xo + (t - 1 + k0) * F, ws0 = k0 * F, L = (k1 - k0) * F;
        var row = ao + t * C;
        for (var c = 0; c < C; c++) {
          var s = b1[c], ws = c * KF + ws0;
          for (var j = 0; j < L; j++) s += x[xs + j] * W1[ws + j];
          a1[row + c] = s > 0 ? s : 0;
        }
      }
      // global mean + max pool over time
      var po = i * P;
      for (c = 0; c < C; c++) {
        var sum = 0, mx = -Infinity, am = 0;
        for (t = 0; t < T; t++) {
          var v = a1[ao + t * C + c];
          sum += v;
          if (v > mx) { mx = v; am = t; }
        }
        pool[po + c] = sum / T;
        pool[po + C + c] = mx;
        amax[i * C + c] = am;
      }
      // dense hidden + ReLU
      var ho = i * H;
      for (var h = 0; h < H; h++) {
        var z = b2[h], wo = h * P;
        for (var p = 0; p < P; p++) z += W2[wo + p] * pool[po + p];
        a2[ho + h] = z > 0 ? z : 0;
      }
      // output + softmax
      var oo = i * O, zmax = -Infinity;
      for (var o = 0; o < O; o++) {
        var zz = b3[o], w3 = o * H;
        for (h = 0; h < H; h++) zz += W3[w3 + h] * a2[ho + h];
        probs[oo + o] = zz;
        if (zz > zmax) zmax = zz;
      }
      var den = 0;
      for (o = 0; o < O; o++) { var e = Math.exp(probs[oo + o] - zmax); probs[oo + o] = e; den += e; }
      for (o = 0; o < O; o++) probs[oo + o] /= den;
    }
    return probs;
  };

  function argmax(a, off, len) {
    var b = 0, bv = a[off];
    for (var k = 1; k < len; k++) if (a[off + k] > bv) { bv = a[off + k]; b = k; }
    return b;
  }

  // Loss/acc of the last forward pass.
  Net.prototype._lossAcc = function (y, n) {
    var O = this.O, probs = this.probs, loss = 0, correct = 0;
    for (var i = 0; i < n; i++) {
      var oo = i * O;
      for (var o = 0; o < O; o++) if (y[oo + o] > 0) loss -= y[oo + o] * Math.log(Math.max(probs[oo + o], 1e-12));
      if (argmax(probs, oo, O) === argmax(y, oo, O)) correct++;
    }
    return { loss: loss / n, acc: correct / n };
  };

  // Forward + backward; fills p.g with d(mean loss)/d(param). No update.
  Net.prototype.computeGradients = function (x, y, n) {
    this.forward(x, n);
    var res = this._lossAcc(y, n);
    var T = this.T, F = this.F, C = this.C, H = this.H, O = this.O, KF = this.KF, P = this.P;
    var W2 = this.byName.W2.w, W3 = this.byName.W3.w;
    var gW1 = this.byName.W1.g, gb1 = this.byName.b1.g, gW2 = this.byName.W2.g, gb2 = this.byName.b2.g;
    var gW3 = this.byName.W3.g, gb3 = this.byName.b3.g;
    for (var q = 0; q < this.params.length; q++) this.params[q].g.fill(0);
    var a1 = this.a1, amax = this.amax, pool = this.pool, a2 = this.a2, probs = this.probs;
    var dz3 = this.dz3, da2 = this.da2, dz2 = this.dz2, dpool = this.dpool, dz1 = this.dz1;
    var invN = 1 / n;
    for (var i = 0; i < n; i++) {
      var oo = i * O, ho = i * H, po = i * P, ao = i * T * C, xo = i * T * F;
      var ysum = 0;
      for (var o = 0; o < O; o++) ysum += y[oo + o];
      for (o = 0; o < O; o++) dz3[o] = (probs[oo + o] * ysum - y[oo + o]) * invN;
      da2.fill(0);
      for (o = 0; o < O; o++) {
        var d = dz3[o], w3 = o * H;
        gb3[o] += d;
        for (var h = 0; h < H; h++) { gW3[w3 + h] += d * a2[ho + h]; da2[h] += W3[w3 + h] * d; }
      }
      for (h = 0; h < H; h++) dz2[h] = a2[ho + h] > 0 ? da2[h] : 0;
      dpool.fill(0);
      for (h = 0; h < H; h++) {
        var d2 = dz2[h];
        if (d2 === 0) continue;
        var wo = h * P;
        gb2[h] += d2;
        for (var p = 0; p < P; p++) { gW2[wo + p] += d2 * pool[po + p]; dpool[p] += W2[wo + p] * d2; }
      }
      for (var t = 0; t < T; t++) {
        for (var c = 0; c < C; c++) {
          var g = dpool[c] / T;
          if (amax[i * C + c] === t) g += dpool[C + c];
          dz1[t * C + c] = a1[ao + t * C + c] > 0 ? g : 0;
        }
      }
      for (t = 0; t < T; t++) {
        var k0 = t === 0 ? 1 : 0, k1 = t === T - 1 ? 2 : 3;
        var xs = xo + (t - 1 + k0) * F, ws0 = k0 * F, L = (k1 - k0) * F;
        for (c = 0; c < C; c++) {
          var g1 = dz1[t * C + c];
          if (g1 === 0) continue;
          gb1[c] += g1;
          var ws = c * KF + ws0;
          for (var j = 0; j < L; j++) gW1[ws + j] += g1 * x[xs + j];
        }
      }
    }
    return res;
  };

  // Adam (+ decoupled weight decay) with global-norm clipping. Returns pre-clip gradient norm.
  Net.prototype.applyGradients = function (lr) {
    var ps = this.params, sq = 0, i, q;
    for (q = 0; q < ps.length; q++) { var g = ps[q].g; for (i = 0; i < g.length; i++) sq += g[i] * g[i]; }
    var norm = Math.sqrt(sq);
    if (!isFinite(norm)) return norm;
    var scale = (this.clip > 0 && norm > this.clip) ? this.clip / norm : 1;
    this.t++;
    var b1 = this.beta1, b2 = this.beta2, eps = this.eps;
    var bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    var stepSize = lr / bc1, wd = lr * this.weightDecay;
    for (q = 0; q < ps.length; q++) {
      var P = ps[q], w = P.w, gg = P.g, m = P.m, v = P.v, decay = P.decay && wd > 0;
      for (i = 0; i < w.length; i++) {
        var gi = gg[i] * scale;
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
    if (!isFinite(r.loss)) return { loss: NaN, acc: r.acc, gradNorm: NaN };
    var norm = this.applyGradients(lr == null ? 0.003 : lr);
    if (!isFinite(norm)) return { loss: NaN, acc: r.acc, gradNorm: norm };
    return { loss: r.loss, acc: r.acc, gradNorm: norm };
  };

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

  // Probabilities for ONE sample (x: FRAMES*FEATURES values). Returns a new Float32Array(9).
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
      arch: { frames: this.T, features: this.F, kernel: this.K, filters: this.C, hidden: this.H, classes: this.O }
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

  Net.prototype.paramCount = function () {
    var s = 0;
    for (var q = 0; q < this.params.length; q++) s += this.params[q].w.length;
    return s;
  };

  TKD.Net = Net;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
