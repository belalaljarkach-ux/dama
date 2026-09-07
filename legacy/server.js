/**
 * server.js — zero-dependency local backend for the gate-log app.
 *
 * Replaces the Google Apps Script / Google Sheets backend with plain files on
 * this machine. Serves the app itself, stores the data as JSON, and mirrors
 * every write to a UTF-8 CSV you can open directly in Excel.
 *
 *   Run:   node server.js
 *   Open:  http://localhost:8787/?backend=server
 *
 * Data lives in ./data/ :
 *   entries.json / entries.csv     one row per trip
 *   vehicles.json / vehicles.csv   one row per registered vehicle
 *   backups/                       timestamped snapshot before each write
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = Number(process.env.PORT || 8787);
const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const BACKUPS  = path.join(DATA_DIR, 'backups');

// Column order matches ENTRY_COLS / VEHICLE_COLS in the Apps Script, so the
// CSV files can be pasted straight into the Google Sheet if you ever migrate.
const COLUMNS = {
  entries:  ['id', 'dateKey', 'vehicle', 'driver', 'customer', 'departTime',
             'notesOut', 'returnTime', 'km', 'notesIn', 'status', 'createdAt'],
  vehicles: ['id', 'name', 'baselineKm', 'registeredAt']
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

/* --------------------------------------------------------------- storage io */

function ensureDirs() {
  [DATA_DIR, BACKUPS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

function jsonPath(col) { return path.join(DATA_DIR, col + '.json'); }
function csvPath(col)  { return path.join(DATA_DIR, col + '.csv'); }

function readCollection(col) {
  const p = jsonPath(col);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[gate-log] ' + col + '.json is corrupt, refusing to read:', err.message);
    throw new Error('corrupt data file: ' + col + '.json');
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(col, rows) {
  const cols  = COLUMNS[col];
  const lines = [cols.join(',')];
  rows.forEach(r => lines.push(cols.map(c => csvCell(r[c])).join(',')));
  // BOM so Excel detects UTF-8 and shows Arabic correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Write to a temp file then rename, so a crash mid-write cannot truncate the
// live data file.
function atomicWrite(file, contents) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

function backup(col) {
  const p = jsonPath(col);
  if (!fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, path.join(BACKUPS, col + '-' + stamp + '.json'));
  // Keep the 40 most recent snapshots per collection.
  const old = fs.readdirSync(BACKUPS)
    .filter(f => f.startsWith(col + '-'))
    .sort()
    .slice(0, -40);
  old.forEach(f => { try { fs.unlinkSync(path.join(BACKUPS, f)); } catch (e) {} });
}

function writeCollection(col, rows) {
  const cols  = COLUMNS[col];
  // Keep only known columns, in a stable order. Drops the app's derived
  // _distance / _durationMin fields if any slipped through.
  const clean = rows.map(r => {
    const o = {};
    cols.forEach(c => { o[c] = (r[c] === undefined) ? null : r[c]; });
    return o;
  });
  backup(col);
  atomicWrite(jsonPath(col), JSON.stringify(clean, null, 2));
  atomicWrite(csvPath(col), toCsv(col, clean));
  return clean.length;
}

/* ------------------------------------------------------------------ http */

function send(res, status, body, headers) {
  const h = Object.assign({
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control':                'no-store'
  }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel  = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, path.normalize(rel));
  // Refuse anything that escapes the project folder.
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), { 'Content-Type': type });
}

const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // GET /api/export/entries.csv
  const exp = pathname.match(/^\/api\/export\/(entries|vehicles)\.csv$/);
  if (exp && req.method === 'GET') {
    const col = exp[1];
    return send(res, 200, toCsv(col, readCollection(col)), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + col + '.csv"'
    });
  }

  // /api/entries | /api/vehicles
  const api = pathname.match(/^\/api\/(entries|vehicles)$/);
  if (api) {
    const col = api[1];
    try {
      if (req.method === 'GET') return sendJson(res, 200, readCollection(col));

      if (req.method === 'PUT' || req.method === 'POST') {
        const rows = JSON.parse(await readBody(req));
        if (!Array.isArray(rows)) return sendJson(res, 400, { error: 'expected a JSON array' });
        const n = writeCollection(col, rows);
        console.log(new Date().toLocaleTimeString() + '  saved ' + n + ' ' + col);
        return sendJson(res, 200, { ok: true, count: n });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    } catch (err) {
      console.error('[gate-log] ' + col + ':', err.message);
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method !== 'GET') return send(res, 405, 'method not allowed');
  serveStatic(req, res, pathname);
});

ensureDirs();
server.listen(PORT, () => {
  console.log('');
  console.log('  gate-log local server');
  console.log('  app   ->  http://localhost:' + PORT + '/?backend=server');
  console.log('  data  ->  ' + DATA_DIR);
  console.log('  stop  ->  Ctrl+C');
  console.log('');
});
