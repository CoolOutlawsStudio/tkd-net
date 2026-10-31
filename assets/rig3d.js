/* TKD-Net 3D fighter rig (classic script; needs global THREE). Shared by the trainer page and the arena view.
   Joints: COCO-17 / MoveNet order. Input poses: [17][x,y,z] (or flat 51) in torso units, origin mid-hip.
   y is DOWN in the project's 2D convention; the rig auto-detects y-up vs y-down per pose sequence. */
(function (root) {
  'use strict';
  var TKD3D = root.TKD3D = root.TKD3D || {};
  var DEFAULT_EDGES = [[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
  var LEG = { 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1 };

  function edges() { var e = root.TKD && root.TKD.EDGES; return (e && e.length) ? e : DEFAULT_EDGES; }

  // Normalise one frame to [17] of THREE.Vector3 (y up). flipY decided by caller.
  function toVecs(THREE, f, flipY, out) {
    out = out || []; var i, flat = typeof f[0] === 'number';
    for (i = 0; i < 17; i++) {
      var x = flat ? f[i * 3] : f[i][0], y = flat ? f[i * 3 + 1] : f[i][1], z = flat ? f[i * 3 + 2] : (f[i][2] || 0);
      (out[i] || (out[i] = new THREE.Vector3())).set(+x || 0, (flipY ? -1 : 1) * (+y || 0), +z || 0);
    }
    return out;
  }
  // y-down if the nose is numerically below (greater y than) the ankles on average.
  TKD3D.isYDown = function (frames) {
    var f = frames && frames[0]; if (!f) return true;
    var flat = typeof f[0] === 'number';
    function y(i) { return flat ? f[i * 3 + 1] : f[i][1]; }
    return y(0) < (y(15) + y(16)) / 2;
  };

  /* opts: { body: 0xRRGGBB, legs: 0xRRGGBB, joint: 0xRRGGBB, radius: 0.07 } */
  TKD3D.Rig = function (THREE, opts) {
    opts = opts || {};
    var g = new THREE.Group(), E = edges(), r = opts.radius || 0.07;
    var matB = new THREE.MeshStandardMaterial({ color: opts.body || 0xf3ead8, roughness: 0.55, metalness: 0.05, emissive: opts.emissive || 0x000000 });
    var matL = new THREE.MeshStandardMaterial({ color: opts.legs || 0xc8102e, roughness: 0.55, metalness: 0.05, emissive: opts.emissive || 0x000000 });
    var cyl = new THREE.CylinderGeometry(r, r, 1, 10, 1, false); cyl.translate(0, 0.5, 0);
    var sph = new THREE.SphereGeometry(r * 1.25, 10, 8), head = new THREE.SphereGeometry(r * 3.2, 16, 12);
    var bones = E.map(function (e) { var m = new THREE.Mesh(cyl, LEG[e[0]] && LEG[e[1]] ? matL : matB); g.add(m); return m; });
    var joints = []; for (var i = 5; i < 17; i++) { var j = new THREE.Mesh(sph, LEG[i] ? matL : matB); g.add(j); joints[i] = j; }
    var headM = new THREE.Mesh(head, matB); g.add(headM);
    var V = [], up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), mid = new THREE.Vector3();
    this.group = g; this.materials = [matB, matL];
    this.setPose = function (frame, flipY) {
      toVecs(THREE, frame, flipY, V);
      for (var k = 0; k < E.length; k++) {
        var a = V[E[k][0]], b = V[E[k][1]], m = bones[k];
        d.subVectors(b, a); var len = d.length() || 1e-4;
        m.position.copy(a); m.scale.set(1, len, 1); m.quaternion.setFromUnitVectors(up, d.multiplyScalar(1 / len));
      }
      for (var i = 5; i < 17; i++) joints[i].position.copy(V[i]);
      // head: between nose and ears, lifted slightly
      mid.copy(V[3]).add(V[4]).multiplyScalar(0.5); headM.position.copy(V[0]).lerp(mid, 0.5);
    };
    this.setEmissive = function (hex, k) { matB.emissive.setHex(hex); matB.emissiveIntensity = k; matL.emissive.setHex(hex); matL.emissiveIntensity = k; };
    this.dispose = function () { cyl.dispose(); sph.dispose(); head.dispose(); matB.dispose(); matL.dispose(); };
  };

  // Find a 3D clip for class index i -> { frames: [Float32Array(51) per frame], fps, rootY|null } or null.
  // Sources (feature-detected): TKD.poses3d[id|slug|index] clip objects ({frames flat, frameCount, fps, rootY}) or
  // arrays of frames, then TKD.generateSequence3D(i, rng) -> { frames, nFrames, fps, rootY }.
  function asClip(c) {
    if (!c) return null;
    var fr = c.frames || c, fps = c.fps || 12, rootY = c.rootY || null, out = [], J = 51, n;
    if (fr && typeof fr.length === 'number' && (typeof fr[0] === 'number')) { n = c.frameCount || c.nFrames || Math.floor(fr.length / J); for (var f = 0; f < n; f++) out.push(fr.subarray ? fr.subarray(f * J, f * J + J) : fr.slice(f * J, f * J + J)); }
    else if (fr && fr.length) out = fr;
    return out.length ? { frames: out, fps: fps, rootY: rootY } : null;
  }
  TKD3D.clipFor = function (i, classId, rng) {
    var T = root.TKD || {}, P = T.poses3d, c = null, slug = T.CLASS_SLUGS && T.CLASS_SLUGS[i];
    if (P) c = P[classId] || (slug && P[slug]) || P[String(classId).replace(/_/g, '-')] || P[i] || null;
    if (!c && typeof T.generateSequence3D === 'function') { try { c = T.generateSequence3D(i, rng || Math.random, {}); } catch (e) { c = null; } }
    return asClip(c);
  };
  TKD3D.sequenceFor = function (i, classId, rng) { var c = TKD3D.clipFor(i, classId, rng); return c ? c.frames : null; };
  TKD3D.has3DPoses = function () { var T = root.TKD || {}; return !!(T.poses3d || typeof T.generateSequence3D === 'function'); };
})(typeof self !== 'undefined' ? self : this);
