/* TKD-Net 3D network view (classic script; needs global THREE, loaded lazily by index.html).
   Draws ONLY data handed over by the page's provider: real layer sizes, real activations/probabilities when the worker
   sends them, real weight-change rates, and real mean-|w| edges (v1 only). Missing data = dim, hollow nodes. */
(function (root) {
  'use strict';
  var TKD3D = root.TKD3D = root.TKD3D || {};

  // Perf guard: refuse software / "major performance caveat" WebGL unless the user opted in; cap fps (30 desktop, 20 phones).
  function phone() { var ua = (root.navigator && navigator.userAgent) || '', coarse = !!(root.matchMedia && matchMedia('(pointer: coarse)').matches); return /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua) || (coarse && Math.min(screen.width || 9999, screen.height || 9999) < 700); }
  TKD3D.FRAME_MS = phone() ? 50 : 33;
  TKD3D.rendererOpts = function (extra, allowSoftware) { var o = { antialias: !phone(), powerPreference: 'low-power', failIfMajorPerformanceCaveat: !allowSoftware }; for (var k in extra) o[k] = extra[k]; return o; };

  TKD3D.createNetView = function (container, provider, opts) {
    opts = opts || {};
    var THREE = root.THREE;
    var reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var renderer = new THREE.WebGLRenderer(TKD3D.rendererOpts({ alpha: true }, opts.allowSoftware));
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    var canvas = renderer.domElement; canvas.className = 'net3d'; canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);
    var scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x0a0908, 12, 28);
    var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    var world = new THREE.Group(); scene.add(world);
    var nodeGeo = new THREE.SphereGeometry(0.075, 10, 8), glowGeo = new THREE.SphereGeometry(0.16, 8, 6);
    var nodeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    var glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    var built = null, version = -1, angle = 0, phase = 0, drag = null, lastT = 0, raf = 0, visible = true, inView = true, disposed = false;
    var tmpM = new THREE.Matrix4(), tmpC = new THREE.Color();
    var DIM = new THREE.Color(0x2a221b), RING = new THREE.Color(0x6b5b48);

    function size() {
      var w = container.clientWidth || 300, h = container.clientHeight || 260;
      renderer.setSize(w, h, false); canvas.style.width = '100%'; canvas.style.height = '100%';
      camera.aspect = w / h; camera.updateProjectionMatrix(); if (typeof fit === 'function') fit(lastSpan);
    }
    var lastSpan = 6;
    function fit(span) { lastSpan = span; var t = Math.tan(camera.fov * Math.PI / 360), need = Math.max((span / 2 + 1.6) / (t * camera.aspect), 1.9 / t); camera.position.set(0, 1.4, need); camera.lookAt(0, 0, 0); }
    function clear() {
      if (!built) return;
      world.remove(built.group);
      built.group.traverse(function (o) { if (o.geometry && o.geometry !== nodeGeo && o.geometry !== glowGeo) o.geometry.dispose(); if (o.material && o.material !== nodeMat && o.material !== glowMat) o.material.dispose(); });
      built = null;
    }
    // grid of up to 64 nodes per layer on the YZ plane
    function gridPos(k, n) { var cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), r = Math.floor(k / cols), c = k % cols, s = Math.min(0.32, 2.6 / Math.max(cols, rows)); return [(c - (cols - 1) / 2) * s, ((rows - 1) / 2 - r) * s]; }
    function build(st) {
      clear();
      var L = st.layers; if (!L || !L.length) return;
      var group = new THREE.Group(), n = L.length, span = Math.min(9, 1.8 * (n - 1)), layers = [];
      for (var i = 0; i < n; i++) {
        var shown = Math.max(1, Math.min(64, L[i].units | 0 || 1)), x = n === 1 ? 0 : -span / 2 + span * i / (n - 1);
        var nodes = new THREE.InstancedMesh(nodeGeo, nodeMat, shown), glow = new THREE.InstancedMesh(glowGeo, glowMat, shown);
        var pos = [];
        for (var k = 0; k < shown; k++) { var p = gridPos(k, shown); pos.push([x, p[1], p[0]]); tmpM.makeTranslation(x, p[1], p[0]); nodes.setMatrixAt(k, tmpM); glow.setMatrixAt(k, tmpM); nodes.setColorAt(k, DIM); glow.setColorAt(k, new THREE.Color(0, 0, 0)); }
        group.add(nodes); group.add(glow);
        // layer frame
        var half = 1.45, fg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, -half, -half), new THREE.Vector3(x, half, -half), new THREE.Vector3(x, half, half), new THREE.Vector3(x, -half, half), new THREE.Vector3(x, -half, -half)]);
        var frame = new THREE.Line(fg, new THREE.LineBasicMaterial({ color: RING, transparent: true, opacity: 0.5 }));
        group.add(frame);
        layers.push({ shown: shown, pos: pos, nodes: nodes, glow: glow, frame: frame, units: L[i].units });
      }
      // real edges (v1: mean |w| between display groups) mapped onto 3D nodes
      var E = st.edges || {}, segs = [], cols = [];
      for (i = 0; i < n - 1; i++) {
        var e = E[i], A = layers[i], B = layers[i + 1]; if (!e) continue;
        var gA = st.groups ? st.groups[i] : null, gB = st.groups ? st.groups[i + 1] : null; if (!gA || !gB) continue;
        for (var a = 0; a < gA; a++) for (var b = 0; b < gB; b++) {
          var s = e[a * gB + b]; if (!(s > 0.35)) continue;
          var pa = A.pos[Math.floor((a + 0.5) * A.shown / gA)], pb = B.pos[Math.floor((b + 0.5) * B.shown / gB)];
          if (!pa || !pb) continue;
          segs.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
          var c = 0.12 + 0.55 * s * s; cols.push(0.91 * c, 0.67 * c, 0.35 * c, 0.91 * c, 0.67 * c, 0.35 * c);
        }
      }
      if (segs.length) {
        var eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3)); eg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        group.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
      } else {
        var ag = new THREE.BufferGeometry().setFromPoints(layers.map(function (l) { return new THREE.Vector3(l.pos[0][0], 0, 0); }));
        group.add(new THREE.Line(ag, new THREE.LineDashedMaterial({ color: 0x6b5b48, dashSize: 0.1, gapSize: 0.1 })).computeLineDistances());
      }
      world.add(group);
      built = { group: group, layers: layers, sig: st.sig };
      fit(span);
    }
    function paint(st) {
      if (!built) return;
      var live = st.training;
      for (var i = 0; i < built.layers.length; i++) {
        var l = built.layers[i], vals = st.values(i, l.shown), act = st.activity(i);
        for (var k = 0; k < l.shown; k++) {
          var f = vals ? vals[k] : null;
          if (f == null) { l.nodes.setColorAt(k, DIM); l.glow.setColorAt(k, tmpC.setRGB(0, 0, 0)); }
          else { tmpC.setRGB(0.35 + 0.6 * f, 0.22 + 0.5 * f, 0.12 + 0.25 * f); l.nodes.setColorAt(k, tmpC); l.glow.setColorAt(k, tmpC.setRGB(0.55 * f * f, 0.3 * f * f, 0.1 * f * f)); }
        }
        l.nodes.instanceColor.needsUpdate = true; l.glow.instanceColor.needsUpdate = true;
        l.frame.material.color.copy(RING).lerp(tmpC.setHex(0xe08a3c), act == null || !live ? 0 : act);
        l.frame.material.opacity = act == null ? 0.35 : 0.35 + 0.6 * act * (live ? 1 : 0.4);
      }
    }
    function frame(t) {
      raf = 0; if (disposed) return;
      var st = provider();
      var animate = st.training && visible && inView && !reduced;
      if (animate && t - lastT < TKD3D.FRAME_MS - 1) { raf = requestAnimationFrame(frame); return; }
      var dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0; lastT = t;
      if (!built || built.sig !== st.sig) build(st);
      if (st.version !== version) { version = st.version; paint(st); }
      if (animate && !drag) phase += dt * 0.35;
      world.rotation.y = -0.35 + angle + (reduced ? 0 : Math.sin(phase) * 0.3); // gentle sway, never edge-on
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      if (animate || drag) raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf && !disposed && visible) raf = requestAnimationFrame(frame); }
    // horizontal drag rotates; vertical scroll stays with the page (touch-action: pan-y in CSS)
    canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, a: angle }; kick(); });
    function clampA(a) { return Math.max(-1.1, Math.min(1.1, a)); }
    root.addEventListener('pointermove', function (e) { if (drag) { angle = clampA(drag.a + (e.clientX - drag.x) * 0.006); kick(); } });
    root.addEventListener('pointerup', function () { drag = null; });
    root.addEventListener('pointercancel', function () { drag = null; });
    document.addEventListener('visibilitychange', function () { visible = !document.hidden; lastT = 0; kick(); });
    if (root.IntersectionObserver) new IntersectionObserver(function (es) { inView = es[0].isIntersecting; kick(); }).observe(container);
    if (root.ResizeObserver) new ResizeObserver(function () { size(); kick(); }).observe(container); else root.addEventListener('resize', function () { size(); kick(); });
    size(); kick();
    return { kick: kick, canvas: canvas, dispose: function () { disposed = true; clear(); nodeGeo.dispose(); glowGeo.dispose(); nodeMat.dispose(); glowMat.dispose(); renderer.dispose(); canvas.remove(); } };
  };

  // Small rotating 3D figure for the callout (only when 3D poses exist).
  TKD3D.createFigureView = function (container, opts) {
    opts = opts || {};
    var THREE = root.THREE;
    var reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var renderer = new THREE.WebGLRenderer(TKD3D.rendererOpts({ alpha: true }, opts.allowSoftware));
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1)); renderer.setClearColor(0, 0);
    var canvas = renderer.domElement; canvas.className = 'fig3d'; canvas.setAttribute('aria-hidden', 'true'); container.appendChild(canvas);
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    scene.add(new THREE.HemisphereLight(0xfff1e0, 0x1a1008, 1.1)); var key = new THREE.DirectionalLight(0xffd2a0, 0.9); key.position.set(2, 3, 2); scene.add(key);
    var rig = new TKD3D.Rig(THREE, {}); scene.add(rig.group);
    var seq = null, clip = null, flip = true, t0 = 0, raf = 0, lastT = 0, visible = true;
    camera.position.set(0, 0.4, 5.2); camera.lookAt(0, 0.2, 0);
    function size() { var w = container.clientWidth || 160, h = container.clientHeight || 200; renderer.setSize(w, h, false); canvas.style.width = '100%'; canvas.style.height = '100%'; camera.aspect = w / h; camera.updateProjectionMatrix(); }
    function frame(t) {
      raf = 0; if (!seq) return;
      if (t - lastT < TKD3D.FRAME_MS - 1) { raf = requestAnimationFrame(frame); return; } lastT = t;
      var fps = (clip && clip.fps) || 12, i = reduced ? Math.floor(seq.length * 0.45) : Math.floor(Math.max(0, (t - t0) / 1000) * fps) % seq.length;
      rig.setPose(seq[i], flip);
      var rY = clip && clip.rootY; rig.group.position.y = rY ? (flip ? -1 : 1) * (rY[i] - rY[0]) : 0; rig.group.rotation.y = reduced ? 0.5 : 0.5 + Math.sin((t - t0) / 2600) * 0.5;
      renderer.render(scene, camera);
      if (!reduced && visible) raf = requestAnimationFrame(frame);
    }
    document.addEventListener('visibilitychange', function () { visible = !document.hidden; if (visible && !raf) raf = requestAnimationFrame(frame); });
    if (root.ResizeObserver) new ResizeObserver(size).observe(container);
    size();
    return {
      show: function (c) { clip = c && c.frames ? c : { frames: c, fps: 12 }; seq = clip.frames; flip = TKD3D.isYDown(seq); t0 = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
      hide: function () { seq = null; },
      dispose: function () { seq = null; renderer.dispose(); canvas.remove(); },
      canvas: canvas
    };
  };
})(typeof self !== 'undefined' ? self : this);
