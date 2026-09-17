/**
 * pdf-export.js — يبني ملف PDF فعلي لأي تقرير (عنوان + أعمدة + صفوف) جاهز من
 * العميل، بلا تكرار لمنطق حساب التقارير على الخادم.
 *
 * الصعوبة الوحيدة هنا: pdfkit لا يشكّل الحروف العربية (لا يصل الحروف ببعضها)
 * ولا يعيد ترتيبها بصريًا من اليمين لليسار — كلاهما يلزم لعرض عربي صحيح.
 * نحلّ هذا يدويًا لكل نص قبل رسمه: `arabic-reshaper` يحوّل كل حرف لشكله
 * الصحيح (بداية/وسط/نهاية/منفصل)، ثم `bidi-js` (تطبيق كامل لخوارزمية
 * Unicode Bidirectional) يعيد ترتيب النص للترتيب البصري الصحيح — بما يشمل
 * الأرقام والتواريخ اللاتينية المُضمَّنة داخل نص عربي دون قلبها خطأ.
 */

'use strict';

const path = require('node:path');
const PDFDocument = require('pdfkit');
const reshaper = require('arabic-reshaper');
const bidiFactory = require('bidi-js');

const bidi = bidiFactory();

const FONT_DIR = path.join(__dirname, 'node_modules/@fontsource/noto-sans-arabic/files');
const FONT_REGULAR = path.join(FONT_DIR, 'noto-sans-arabic-arabic-400-normal.woff');
const FONT_BOLD = path.join(FONT_DIR, 'noto-sans-arabic-arabic-700-normal.woff');

function shapeLine(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (!s) return '';
  const reshaped = reshaper.convertArabic(s);
  const levels = bidi.getEmbeddingLevels(reshaped);
  return bidi.getReorderedString(reshaped, levels);
}

const ROW_HEIGHT = 20;
const HEADER_ROW_HEIGHT = 22;
const FONT_SIZE = 9;

function buildReportPdf(title, columns, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.registerFont('ar', FONT_REGULAR);
    doc.registerFont('ar-bold', FONT_BOLD);

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = usable / Math.max(columns.length, 1);
    const bottomLimit = doc.page.height - doc.page.margins.bottom;

    // العمود الأول يظهر أقصى اليمين (نفس اتجاه جداول الواجهة نفسها)، فالعمود i
    // يبدأ من اليمين ناقص (i+1) عرض عمود.
    function colX(i) { return left + usable - (i + 1) * colWidth; }

    function drawHeaderRow(y) {
      doc.font('ar-bold').fontSize(FONT_SIZE);
      columns.forEach((col, i) => {
        doc.text(shapeLine(col), colX(i), y, { width: colWidth, align: 'center' });
      });
      doc.moveTo(left, y + HEADER_ROW_HEIGHT - 4).lineTo(left + usable, y + HEADER_ROW_HEIGHT - 4)
        .strokeColor('#999999').stroke();
      doc.font('ar').fontSize(FONT_SIZE);
    }

    doc.font('ar-bold').fontSize(15).text(shapeLine(title), left, doc.y, { width: usable, align: 'center' });
    doc.moveDown(0.8);

    let y = doc.y;
    drawHeaderRow(y);
    y += HEADER_ROW_HEIGHT;

    if (!rows.length) {
      doc.font('ar').fontSize(FONT_SIZE).text(shapeLine('لا توجد بيانات لهذا التقرير.'), left, y, { width: usable, align: 'center' });
    }

    rows.forEach(row => {
      if (y + ROW_HEIGHT > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeaderRow(y);
        y += HEADER_ROW_HEIGHT;
      }
      row.forEach((cell, i) => {
        doc.text(shapeLine(cell), colX(i), y, { width: colWidth, height: ROW_HEIGHT - 4, ellipsis: true, align: 'center' });
      });
      y += ROW_HEIGHT;
    });

    doc.end();
  });
}

module.exports = { buildReportPdf };
