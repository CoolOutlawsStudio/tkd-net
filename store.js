/* TKD-Net store.js (owner: Moneyman)
 * IndexedDB persistence for weights, history and meta. Works in a Web Worker and in a page.
 * DB 'tkd-net', object store 'kv', keys: 'weights', 'history', 'meta'.
 * Every call FAILS SOFT: if IndexedDB is missing, blocked (private mode) or errors, calls resolve null
 * (or false for writes) and TKD.store.available is false. Nothing ever rejects.
 */
(function (root) {
  'use strict';
  var TKD = root.TKD = root.TKD || {};
  var DB_NAME = 'tkd-net', STORE = 'kv', DB_VERSION = 1;

  var store = {
    available: false,
    DB_NAME: DB_NAME,
    STORE_NAME: STORE,
    timeoutMs: 4000,
    _db: null,
    _opening: null
  };

  function getFactory() {
    try { return root.indexedDB || null; } catch (e) { return null; } // access itself can throw (sandboxed iframes, some private modes)
  }

  store.open = function () {
    if (store._opening) return store._opening;
    store._opening = new Promise(function (resolve) {
      var done = false, timer = null;
      function finish(db) {
        if (done) { if (db) { try { db.close(); } catch (e) {} } return; }
        done = true;
        if (timer) clearTimeout(timer);
        store._db = db || null;
        store.available = !!db;
        resolve(store._db);
      }
      var f = getFactory();
      if (!f) { finish(null); return; }
      timer = setTimeout(function () { finish(null); }, store.timeoutMs); // Safari can hang open() forever
      try {
        var req = f.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          try {
            var db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
          } catch (e) { /* onerror will follow */ }
        };
        req.onsuccess = function () {
          var db = req.result;
          try {
            db.onversionchange = function () {
              try { db.close(); } catch (e) {}
              store._db = null; store.available = false; store._opening = null;
            };
          } catch (e) {}
          finish(db);
        };
        req.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); finish(null); };
        req.onblocked = function () { /* wait for timeout or success */ };
      } catch (e) { finish(null); }
    });
    return store._opening;
  };

  function tx(mode, fn) {
    return store.open().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var result = null, settled = false;
        function done(v) { if (!settled) { settled = true; resolve(v); } }
        try {
          var t = db.transaction(STORE, mode);
          var os = t.objectStore(STORE);
          fn(os, function (v) { result = v; });
          t.oncomplete = function () { done(result); };
          t.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); done(null); };
          t.onabort = function () { done(null); };
        } catch (e) { done(null); }
      });
    }, function () { return null; });
  }

  function get(key) {
    return tx('readonly', function (os, set) {
      var r = os.get(key);
      r.onsuccess = function () { set(r.result === undefined ? null : r.result); };
    });
  }
  function put(key, val) {
    return tx('readwrite', function (os, set) { os.put(val, key); set(true); }).then(function (v) { return v === true; });
  }
  function del(key) {
    return tx('readwrite', function (os, set) { os['delete'](key); set(true); }).then(function (v) { return v === true; });
  }

  function weightBytes(w) {
    var b = 0;
    if (!w) return 0;
    for (var k in w) if (Object.prototype.hasOwnProperty.call(w, k) && w[k] && typeof w[k].byteLength === 'number') b += w[k].byteLength;
    return b;
  }
  store.weightBytes = weightBytes;

  // weights: object from net.getWeights() (typed arrays, stored via structured clone, not JSON).
  // Resolves { step, bytes, at } or null.
  store.saveWeights = function (weights, step) {
    var at = Date.now();
    var rec = { version: TKD.MODEL_VERSION, step: step || 0, savedAt: at, weights: weights };
    return put('weights', rec).then(function (ok) {
      return ok ? { step: rec.step, bytes: weightBytes(weights), at: at } : null;
    }, function () { return null; });
  };

  // Resolves { version, step, savedAt, weights } or null. A record from another MODEL_VERSION is deleted and null returned.
  // (If nn.js is not loaded, e.g. page-only use, it returns null without deleting anything.)
  store.loadWeights = function () {
    return get('weights').then(function (rec) {
      if (!rec || !rec.weights) return null;
      if (TKD.MODEL_VERSION === undefined) return null;
      if (rec.version !== TKD.MODEL_VERSION) return del('weights').then(function () { return null; });
      return rec;
    }, function () { return null; });
  };

  // history: { progress: [...last 500 progress points], evals: [{step, acc, loss}] }
  store.saveHistory = function (history) { return put('history', history).catch(function () { return false; }); };
  store.loadHistory = function () { return get('history').catch(function () { return null; }); };

  store.loadMeta = function () { return get('meta').catch(function () { return null; }); };

  // Resolves the new meta { sessions, firstSeen, lastSeen } or null if storage is unavailable.
  store.incrementSessions = function () {
    return get('meta').then(function (m) {
      if (!store.available) return null;
      var now = Date.now();
      m = m || { sessions: 0, firstSeen: now };
      m.sessions = (m.sessions || 0) + 1;
      m.lastSeen = now;
      return put('meta', m).then(function (ok) { return ok ? m : null; });
    }).catch(function () { return null; });
  };

  // Deletes saved weights and history (keeps the session counter). Resolves true, or null if unavailable.
  store.clear = function () {
    return store.open().then(function (db) {
      if (!db) return null;
      return del('weights').then(function (a) { return del('history').then(function (b) { return a && b; }); });
    }).catch(function () { return null; });
  };

  TKD.store = store;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
