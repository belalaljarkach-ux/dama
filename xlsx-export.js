/**
 * xlsx-export.js — يبني ملف Excel (.xlsx) فعلي لأي تقرير (عنوان + أعمدة + صفوف) جاهز من العميل،
 * بلا اعتماديات خارجية: ملف xlsx هو أرشيف zip من ملفات XML، فنكتبه مباشرة بـ zlib المدمج في Node.
 *
 *  - الورقة من اليمين لليسار (rightToLeft) لتناسب العربية.
 *  - صف عنوان مدموج، ثم صف رؤوس منسّق (خط عريض + خلفية + حدود) مثبّت أثناء التمرير.
 *  - النصوص تُخزَّن نصًا حرفيًا (لا صيغ)، فلا يُنفَّذ محتوى يبدأ بـ = أو + (CSV injection).
 *  - السلاسل الرقمية الصرفة (12.5، 40) تُخزَّن أرقامًا ليتمكن Excel من جمعها وفرزها؛ أما ما فيه أصفار بادئة
 *    أو أكثر من 15 خانة (هواتف، أرقام مرجعية) فيبقى نصًا كما هو.
 */

'use strict';

const zlib = require('node:zlib');

/* ------------------------------------------------------------ zip بسيط */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data(Buffer|string) }] → Buffer لأرشيف zip (deflate)
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);   // 0x0800 = أسماء UTF-8
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ------------------------------------------------------------ XML */

// محارف التحكم غير المسموحة في XML 1.0 تُحذف، ثم تُهرَّب الرموز الخاصة.
const xmlText = v => String(v === null || v === undefined ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colRef(i) {            // 0 → A، 25 → Z، 26 → AA
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
function cellXml(ref, v, style) {
  const s = v === null || v === undefined ? '' : (typeof v === 'number' ? String(v) : String(v).trim());
  if (s === '') return `<c r="${ref}" s="${style}"/>`;
  if (typeof v === 'number' ? isFinite(v) : (NUM_RE.test(s) && s.replace(/[-.]/g, '').length <= 15)) {
    return `<c r="${ref}" s="${style}"><v>${s}</v></c>`;
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
}

// أنماط: 0 افتراضي، 1 عنوان التقرير، 2 رأس العمود، 3 خلية بيانات (حدود رفيعة + محاذاة لليمين)
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4D3F"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFC9C2B0"/></left><right style="thin"><color rgb="FFC9C2B0"/></right><top style="thin"><color rgb="FFC9C2B0"/></top><bottom style="thin"><color rgb="FFC9C2B0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1" readingOrder="2"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// اسم الورقة: ≤ 31 حرفًا وبلا  \ / ? * [ ] :
function sheetName(title) {
  const n = String(title || '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  return n || 'تقرير';
}

function buildReportXlsx(title, columns, rows) {
  const nCols = Math.max(1, columns.length);
  const widths = columns.map((c, i) => {
    let w = String(c || '').length;
    for (const r of rows.slice(0, 500)) w = Math.max(w, String(r[i] === null || r[i] === undefined ? '' : r[i]).length);
    return Math.min(60, Math.max(10, w + 3));
  });
  const rowXml = [];
  // 1: العنوان (مدموج على عرض الجدول)
  rowXml.push(`<row r="1" ht="26" customHeight="1">${cellXml('A1', title, 1)}${columns.slice(1).map((_, i) => `<c r="${colRef(i + 1)}1" s="1"/>`).join('')}</row>`);
  // 2: الرؤوس
  rowXml.push(`<row r="2" ht="22" customHeight="1">${columns.map((c, i) => `<c r="${colRef(i)}2" s="2" t="inlineStr"><is><t xml:space="preserve">${xmlText(c)}</t></is></c>`).join('')}</row>`);
  rows.forEach((r, ri) => {
    const rn = ri + 3;
    rowXml.push(`<row r="${rn}">${columns.map((_, ci) => cellXml(colRef(ci) + rn, r[ci], 3)).join('')}</row>`);
  });
  const lastRow = rows.length + 2;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${colRef(nCols - 1)}${lastRow}"/>
<sheetViews><sheetView rightToLeft="1" workbookViewId="0" tabSelected="1"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowXml.join('')}</sheetData>
<autoFilter ref="A2:${colRef(nCols - 1)}${Math.max(2, lastRow)}"/>
${nCols > 1 ? `<mergeCells count="1"><mergeCell ref="A1:${colRef(nCols - 1)}1"/></mergeCells>` : ''}
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape"/>
</worksheet>`;
  // ترتيب عناصر الورقة يتبع مخطط OOXML (autoFilter قبل mergeCells) — Excel صارم فيه؛ وautoFilter يحتاج اسمًا معرَّفًا _xlnm._FilterDatabase
  const name = xmlText(sheetName(title));
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$2:$${colRef(nCols - 1)}$${Math.max(2, lastRow)}</definedName></definedNames>
</workbook>`;
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
}

module.exports = { buildReportXlsx, zip, crc32, sheetName };
