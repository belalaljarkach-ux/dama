/**
 * storage-adapter.js
 * -----------------------------------------------------------------------------
 * index.html was written for a hosted sandbox that provides a global
 * `window.storage` object. That object does not exist in a normal browser, so
 * every load and save silently failed and nothing was ever persisted.
 *
 * This file supplies `window.storage` with three interchangeable backends:
 *
 *   local   (default) -> browser localStorage. Zero install, single machine.
 *   server            -> the bundled Node server (server.js). Real files on disk.
 *   gas               -> a deployed Google Apps Script web app (Code.gs).
 *
 * Pick one with a query string ( index.html?backend=server ) or by editing
 * GATE_LOG_CONFIG below.
 * -----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var CONFIG = window.GATE_LOG_CONFIG = window.GATE_LOG_CONFIG || {
    backend:   'local',                    // 'local' | 'server' | 'gas'
    serverUrl: 'http://localhost:8787',    // used when backend === 'server'
    gasUrl:    ''                          // paste your /exec URL to use 'gas'
  };

  var qs = new URLSearchParams(location.search);
  var backend = qs.get('backend') || CONFIG.backend || 'local';
  if (location.protocol.indexOf('http') === 0 && backend === 'server') {
    CONFIG.serverUrl = location.origin;    // page is served by server.js itself
  }

  // storage key  ->  collection name used by the server / Apps Script sheet
  var COLLECTION = {
    'gate-log-entries':  'entries',
    'gate-log-vehicles': 'vehicles'
  };

  /* ---------------------------------------------------------------- helpers */

  // render() bolts _distance and _durationMin onto every entry object. Strip
  // those derived fields so they never reach disk or the spreadsheet.
  function clean(arr) {
    if (!Array.isArray(arr)) return arr;
    return arr.map(function (o) {
      var c = {};
      Object.keys(o).forEach(function (k) {
        if (k.charAt(0) !== '_') c[k] = o[k];
      });
      return c;
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Google Sheets turns "2026-08-19" into a Date and "08:30" into a time value.
  // After JSON transport those arrive as ISO strings, and every duration and
  // distance calculation in the app breaks. Normalise them back to the shapes
  // the app expects: "YYYY-MM-DD" and "HH:MM".
  function toDateKey(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function toHm(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) {
      var parts = v.split(':');
      return pad(parts[0]) + ':' + parts[1];
    }
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  function normalize(collection, rows) {
    if (!Array.isArray(rows)) return [];
    if (collection === 'entries') {
      return rows.map(function (e) {
        var r = Object.assign({}, e);
        r.dateKey    = toDateKey(r.dateKey);
        r.departTime = toHm(r.departTime);
        r.returnTime = r.returnTime ? toHm(r.returnTime) : null;
        r.km         = toNum(r.km);
        r.notesOut   = r.notesOut || '';
        r.notesIn    = r.notesIn  || '';
        // Trust returnTime + km over a stale status column.
        r.status = (r.returnTime && r.km !== null) ? 'done' : 'out';
        return r;
      });
    }
    return rows.map(function (v) {
      var r = Object.assign({}, v);
      r.baselineKm = toNum(r.baselineKm);
      return r;
    });
  }

  /* ---------------------------------------------------------- backend: local */

  var memory = {};                 // fallback when localStorage is unavailable
  var localOk = (function () {
    try {
      window.localStorage.setItem('__gatelog_test', '1');
      window.localStorage.removeItem('__gatelog_test');
      return true;
    } catch (err) {
      return false;
    }
  })();

  if (!localOk) {
    console.warn('[gate-log] localStorage is blocked on this origin. Data will ' +
                 'live in memory for this page view only. Serve the folder over ' +
                 'http:// (see README.md) to fix this.');
  }

  var localBackend = {
    get: function (key) {
      var v = localOk ? window.localStorage.getItem(key) : (memory[key] || null);
      return Promise.resolve({ value: v });
    },
    set: function (key, value) {
      var out = JSON.stringify(clean(JSON.parse(value)));
      if (localOk) { window.localStorage.setItem(key, out); } else { memory[key] = out; }
      return Promise.resolve({ ok: true });
    }
  };

  /* --------------------------------------------------------- backend: server */

  var serverBackend = {
    get: function (key) {
      var col = COLLECTION[key];
      return fetch(CONFIG.serverUrl + '/api/' + col, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          return { value: JSON.stringify(normalize(col, rows)) };
        });
    },
    set: function (key, value) {
      var col = COLLECTION[key];
      return fetch(CONFIG.serverUrl + '/api/' + col, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(clean(JSON.parse(value)))
      }).then(function (r) {
        if (!r.ok) throw new Error('server responded ' + r.status);
        return r.json();
      });
    }
  };

  /* ------------------------------------------------------------ backend: gas */

  // Apps Script serves no CORS preflight response, so POSTs must stay "simple"
  // requests: text/plain content type and no custom headers.
  var gasBackend = {
    get: function (key) {
      var action = (key === 'gate-log-entries') ? 'listEntries' : 'listVehicles';
      var col    = COLLECTION[key];
      return fetch(CONFIG.gasUrl + '?action=' + action, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          return { value: JSON.stringify(normalize(col, (res && res.rows) || [])) };
        });
    },
    set: function (key, value) {
      var col  = COLLECTION[key];
      var rows = clean(JSON.parse(value));
      return fetch(CONFIG.gasUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body:    JSON.stringify({ action: 'replaceAll', collection: col, rows: rows })
      }).then(function (r) { return r.json(); });
    }
  };

  /* ------------------------------------------------------------------ wire up */

  var chosen = (backend === 'server') ? serverBackend
             : (backend === 'gas')    ? gasBackend
             : localBackend;

  window.storage = {
    get: function (key) { return chosen.get(key); },
    set: function (key, value) { return chosen.set(key, value); }
  };

  window.GATE_LOG_BACKEND_ACTIVE = backend;
  console.info('[gate-log] storage backend =', backend);
})();
