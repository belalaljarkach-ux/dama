/**
 * سكربت خلفي لتطبيق سجل بوابة المجبل — يستخدم Google Sheets كقاعدة بيانات.
 *
 * Fixed version of Code_2.gs. Differences from the original:
 *
 *  1. Text columns are forced to plain-text format ("@") so Sheets stops
 *     converting "2026-08-19" into a Date and "08:30" into a time value.
 *     In the original, those came back from getValues() as Date objects and
 *     every duration / distance calculation in the front end produced NaN.
 *  2. Adds the `replaceAll` action the front-end adapter uses (the original
 *     exposed only per-row upsert/delete, which the HTML never called).
 *  3. Wraps every write in LockService so two gate clerks saving at the same
 *     moment cannot clobber each other's row.
 *  4. Optional shared secret (SECRET) — a web app deployed as "Anyone" is
 *     otherwise world-readable and world-writable by URL alone.
 *  5. Returns { ok:false, error } instead of throwing raw stack traces.
 *
 * Deploy: Extensions > Apps Script > paste > Deploy > New deployment >
 *         Web app > Execute as: Me > Who has access: Anyone > copy /exec URL.
 */

const ENTRIES_SHEET  = 'Entries';
const VEHICLES_SHEET = 'Vehicles';

const ENTRY_COLS   = ['id','dateKey','vehicle','driver','customer','departTime',
                      'notesOut','returnTime','km','notesIn','status','createdAt'];
const VEHICLE_COLS = ['id','name','baselineKm','registeredAt'];

// Columns that must never be auto-coerced into dates/times/numbers by Sheets.
const TEXT_COLS = ['id','dateKey','departTime','returnTime','createdAt','registeredAt'];

// Set to a long random string and send it as ?token=... / {token:...}.
// Leave empty to disable the check (fine while testing, not for production).
const SECRET = '';

/* ------------------------------------------------------------------ routing */

function doGet(e) {
  try {
    if (!authorized(e.parameter.token)) return jsonOut({ ok: false, error: 'unauthorized' });
    const action = e.parameter.action;
    if (action === 'listEntries')  return jsonOut({ ok: true, rows: listRows(ENTRIES_SHEET,  ENTRY_COLS) });
    if (action === 'listVehicles') return jsonOut({ ok: true, rows: listRows(VEHICLES_SHEET, VEHICLE_COLS) });
    return jsonOut({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!authorized(body.token)) return jsonOut({ ok: false, error: 'unauthorized' });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (body.action) {
        // Used by storage-adapter.js: the front end owns the whole array and
        // rewrites it after each change.
        case 'replaceAll': {
          const isEntries = body.collection === 'entries';
          return jsonOut({
            ok: true,
            count: replaceAll(isEntries ? ENTRIES_SHEET  : VEHICLES_SHEET,
                              isEntries ? ENTRY_COLS     : VEHICLE_COLS,
                              body.rows || [])
          });
        }
        // Per-row operations, kept for compatibility / other clients.
        case 'upsertEntry':   return jsonOut(upsertRow(ENTRIES_SHEET,  ENTRY_COLS,   body.data));
        case 'deleteEntry':   return jsonOut(deleteRow(ENTRIES_SHEET,  body.id));
        case 'upsertVehicle': return jsonOut(upsertRow(VEHICLES_SHEET, VEHICLE_COLS, body.data));
        case 'deleteVehicle': return jsonOut(deleteRow(VEHICLES_SHEET, body.id));
        default:              return jsonOut({ ok: false, error: 'unknown action' });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function authorized(token) {
  return !SECRET || token === SECRET;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------- sheets */

function getSheet(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    sheet.setFrozenRows(1);
  }
  forceTextColumns(sheet, cols);
  return sheet;
}

// The core fix: any column holding an id, a date key or a HH:MM time is pinned
// to plain text, so Sheets stores exactly what the app sent.
function forceTextColumns(sheet, cols) {
  cols.forEach(function (c, idx) {
    if (TEXT_COLS.indexOf(c) === -1) return;
    sheet.getRange(1, idx + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

function listRows(sheetName, cols) {
  const sheet  = getSheet(sheetName, cols);
  const values = sheet.getDataRange().getDisplayValues();
  const rows   = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;              // تجاهل الصفوف الفارغة
    const obj = {};
    cols.forEach(function (c, idx) { obj[c] = values[i][idx]; });
    rows.push(obj);
  }
  return rows;
}

function rowArray(cols, data) {
  return cols.map(function (c) {
    const v = data[c];
    return (v === undefined || v === null) ? '' : v;
  });
}

function replaceAll(sheetName, cols, rows) {
  const sheet = getSheet(sheetName, cols);
  const last  = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, cols.length).clearContent();
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, cols.length)
         .setValues(rows.map(function (r) { return rowArray(cols, r); }));
  }
  return rows.length;
}

function upsertRow(sheetName, cols, data) {
  const sheet  = getSheet(sheetName, cols);
  const values = sheet.getDataRange().getDisplayValues();
  const arr    = rowArray(cols, data);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(data.id)) {
      sheet.getRange(i + 1, 1, 1, cols.length).setValues([arr]);
      return { ok: true, updated: true };
    }
  }
  sheet.appendRow(arr);
  return { ok: true, inserted: true };
}

function deleteRow(sheetName, id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { ok: true };
  const values = sheet.getDataRange().getDisplayValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { ok: true, deleted: true };
    }
  }
  return { ok: true, deleted: false };
}
