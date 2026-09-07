/**
 * سكربت خلفي لتطبيق سجل بوابة المجبل — يستخدم Google Sheets كقاعدة بيانات.
 * كل عملية دخول/خروج وكل آلية تُخزَّن كصف حقيقي، يمكنك فتح الشيت ورؤيتها مباشرة.
 */

const ENTRIES_SHEET = 'Entries';
const VEHICLES_SHEET = 'Vehicles';

const ENTRY_COLS   = ['id','dateKey','vehicle','driver','customer','departTime','notesOut','returnTime','km','notesIn','status','createdAt'];
const VEHICLE_COLS = ['id','name','baselineKm','registeredAt'];

function doGet(e) {
  const action = e.parameter.action;
  let result;
  if (action === 'listEntries') result = listRows(ENTRIES_SHEET, ENTRY_COLS);
  else if (action === 'listVehicles') result = listRows(VEHICLES_SHEET, VEHICLE_COLS);
  else result = { error: 'unknown action' };
  return jsonOut(result);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  let result;
  if (body.action === 'upsertEntry') result = upsertRow(ENTRIES_SHEET, ENTRY_COLS, body.data);
  else if (body.action === 'deleteEntry') result = deleteRow(ENTRIES_SHEET, body.id);
  else if (body.action === 'upsertVehicle') result = upsertRow(VEHICLES_SHEET, VEHICLE_COLS, body.data);
  else if (body.action === 'deleteVehicle') result = deleteRow(VEHICLES_SHEET, body.id);
  else result = { error: 'unknown action' };
  return jsonOut(result);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function listRows(sheetName, cols) {
  const sheet = getSheet(sheetName, cols);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue; // تجاهل الصفوف الفارغة
    const obj = {};
    cols.forEach((c, idx) => obj[c] = values[i][idx]);
    rows.push(obj);
  }
  return { rows: rows };
}

function upsertRow(sheetName, cols, data) {
  const sheet = getSheet(sheetName, cols);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === data.id) {
      const rowArr = cols.map(c => (data[c] === undefined || data[c] === null) ? '' : data[c]);
      sheet.getRange(i + 1, 1, 1, cols.length).setValues([rowArr]);
      return { ok: true };
    }
  }
  const rowArr = cols.map(c => (data[c] === undefined || data[c] === null) ? '' : data[c]);
  sheet.appendRow(rowArr);
  return { ok: true };
}

function deleteRow(sheetName, id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { ok: true };
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === id) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: true };
}
