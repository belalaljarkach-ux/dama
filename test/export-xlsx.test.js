/**
 * export-xlsx.test.js — تصدير Excel (.xlsx) بدل PDF.
 *
 *  1) المولّد: أرشيف zip صالح (CRC صحيح)، هيكل xlsx كامل، ورقة RTL، رؤوس وصفوف، أرقام كأرقام،
 *     نصوص حرفية (لا صيغ)، تهريب XML، وحذف محارف التحكم، واسم ورقة صالح.
 *  2) المسار POST /api/export/xlsx على خادم حقيقي: يتطلب جلسة، يعمل لكل الأدوار، يُرجع نوع Excel
 *     واسم ملف .xlsx، ويرفض الطلب بلا أعمدة، ويقصّ الصفوف الزائدة، ويُسجَّل في التدقيق.
 *
 *   node test/export-xlsx.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { buildReportXlsx, crc32, sheetName } = require('../xlsx-export');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

// قارئ zip مصغّر للتحقق: يقرأ الدليل المركزي ويفكّ الضغط ويتأكد من CRC
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'لا يوجد End Of Central Directory');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'توقيع الدليل المركزي');
    const method = buf.readUInt16LE(off + 10), crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'توقيع الرأس المحلي');
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    assert.equal(method, 8);
    const raw = zlib.inflateRawSync(buf.slice(dataStart, dataStart + csize));
    assert.equal(raw.length, usize, 'الحجم الأصلي ' + name);
    assert.equal(crc32(raw), crc, 'CRC ' + name);
    out[name] = raw.toString('utf8');
    off += 46 + nlen + elen + clen;
  }
  return out;
}

const PORT = 8911, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'xlsx-pw-1';
const call = async (cookie, method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: Object.assign(cookie ? { cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch (e) { /* */ }
  return { status: r.status, headers: r.headers, buf, data };
};
const login = async (user, pw) => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
  if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
};

(async () => {
  console.log('— المولّد');
  const cols = ['الآلية', 'السائق', 'المسافة (كم)', 'ملاحظة'];
  const rows = [
    ['قلاب 1', 'أحمد', '12.5', '=1+1'],
    ['قلاب 2', 'سامر & <ابن>', '40', '0555123456'],
    ['قلاب 3', 'خالد', '', 'a\u0007b"c'],
    ['قلاب 4', 'ليلى', '1234567890123456789', '-3']
  ];
  const files = unzip(buildReportXlsx('تقرير المسافات', cols, rows));
  await check('هيكل xlsx كامل', async () => {
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) assert.ok(files[n], n);
  });
  const sheet = files['xl/worksheets/sheet1.xml'];
  await check('الورقة من اليمين لليسار ورأس مثبّت', async () => {
    assert.match(sheet, /rightToLeft="1"/); assert.match(sheet, /state="frozen"/);
    // rightToLeft سمة صالحة في sheetView فقط؛ وجودها في workbookView يجعل Excel يشكو من ملف تالف
    assert.ok(!/<workbookView[^>]*rightToLeft/.test(files['xl/workbook.xml']));
  });
  await check('العنوان والرؤوس والصفوف حاضرة', async () => {
    assert.ok(sheet.includes('تقرير المسافات'));
    for (const c of cols) assert.ok(sheet.includes(c), c);
    assert.ok(sheet.includes('قلاب 4'));
    assert.match(sheet, /<mergeCell ref="A1:D1"\/>/);
    assert.match(sheet, /<dimension ref="A1:D6"\/>/);
  });
  await check('ترتيب عناصر الورقة يطابق مخطط OOXML (Excel صارم فيه)', async () => {
    const order = ['<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<autoFilter', '<mergeCells', '<pageMargins', '<pageSetup'];
    const idx = order.map(t => sheet.indexOf(t));
    assert.ok(idx.every(i => i >= 0), JSON.stringify(idx));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  });
  await check('الأرقام الصرفة تُخزَّن أرقامًا (12.5 و40 و-3)', async () => {
    assert.match(sheet, /<c r="C3"[^>]*><v>12.5<\/v><\/c>/);
    assert.match(sheet, /<c r="C4"[^>]*><v>40<\/v><\/c>/);
    assert.match(sheet, /<c r="D6"[^>]*><v>-3<\/v><\/c>/);
  });
  await check('الأصفار البادئة (هاتف) والأرقام الطويلة جدًا تبقى نصًا', async () => {
    assert.match(sheet, /<c r="D4"[^>]*t="inlineStr"><is><t[^>]*>0555123456</);
    assert.match(sheet, /<c r="C6"[^>]*t="inlineStr"><is><t[^>]*>1234567890123456789</);
  });
  await check('نص يبدأ بـ = يُخزَّن نصًا حرفيًا لا صيغة', async () => {
    assert.match(sheet, /<c r="D3"[^>]*t="inlineStr"><is><t[^>]*>=1\+1</);
    assert.ok(!/<f>/.test(sheet));
  });
  await check('تهريب XML وحذف محارف التحكم', async () => {
    assert.ok(sheet.includes('سامر &amp; &lt;ابن&gt;'));
    assert.ok(sheet.includes('ab&quot;c'));
    assert.ok(!sheet.includes('\u0007'));
  });
  await check('خلية فارغة تُكتب فارغة', async () => assert.match(sheet, /<c r="C5" s="3"\/>/));
  await check('اسم الورقة: بلا محارف ممنوعة وبحد 31', async () => {
    assert.equal(sheetName('أ/ب:ج?د*[هـ]'), 'أ ب ج د هـ');
    assert.equal(sheetName('x'.repeat(50)).length, 31);
    assert.equal(sheetName('///'), 'تقرير');
    assert.match(unzip(buildReportXlsx('تقرير/المسافات:اليومية', ['أ'], []))['xl/workbook.xml'], /name="تقرير المسافات اليومية"/);
  });
  await check('جدول بلا صفوف وبعمود واحد يُنتج ملفًا صالحًا', async () => {
    const f = unzip(buildReportXlsx('فارغ', ['عمود'], []));
    assert.match(f['xl/worksheets/sheet1.xml'], /<dimension ref="A1:A2"\/>/);
    assert.ok(!/mergeCell /.test(f['xl/worksheets/sheet1.xml']));
  });
  await check('أكثر من 26 عمودًا: مراجع الأعمدة AA…', async () => {
    const c = Array.from({ length: 30 }, (_, i) => 'ع' + i);
    const f = unzip(buildReportXlsx('عريض', c, [c.map((_, i) => String(i))]));
    assert.match(f['xl/worksheets/sheet1.xml'], /<c r="AD3"/);
  });

  console.log('— المسار /api/export/xlsx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-xlsx-'));
  let srv = null;
  try {
    const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dir,
      GATE_LOG_CONFIG: path.join(dir, 'none.json'), ADMIN_PASSWORD: ADMIN_PW });
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
      srv.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); res(); } });
      srv.on('exit', c => rej(new Error('الخادم توقّف ' + c)));
    });
    const pwPath = path.join(dir, 'كلمات-المرور-الأولية.txt');
    for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
    const pwFile = fs.readFileSync(pwPath, 'utf8');
    const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];
    const admin = await login('admin', ADMIN_PW), gate = await login('بوابة', pwOf('بوابة')), mgr = await login('مدير_الاليات', pwOf('مدير_الاليات'));
    const body = { title: 'تقرير: الجبالات', columns: ['الآلية', 'المسافة'], rows: [['جبالة 1', '12.5'], ['جبالة 2', '8']] };

    await check('بلا جلسة → 401', async () => assert.equal((await call(null, 'POST', '/api/export/xlsx', body)).status, 401));
    for (const [who, c] of [['الأدمن', admin], ['البوابة', gate], ['مدير الآليات', mgr]]) {
      await check(`${who}: ملف Excel صالح بالنوع واسم الملف`, async () => {
        const r = await call(c, 'POST', '/api/export/xlsx', body);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /spreadsheetml\.sheet/);
        assert.match(r.headers.get('content-disposition'), /\.xlsx"/);
        assert.equal(r.buf.slice(0, 2).toString(), 'PK');
        const f = unzip(r.buf);
        assert.ok(f['xl/worksheets/sheet1.xml'].includes('جبالة 2'));
      });
    }
    await check('بلا أعمدة → 400، وبلا عنوان → 400', async () => {
      assert.equal((await call(admin, 'POST', '/api/export/xlsx', { title: 't', columns: [], rows: [] })).status, 400);
      assert.equal((await call(admin, 'POST', '/api/export/xlsx', { columns: ['a'], rows: [] })).status, 400);
    });
    await check('صف أطول من الأعمدة يُقصّ، وصف ليس مصفوفة يصير فارغًا', async () => {
      const r = await call(admin, 'POST', '/api/export/xlsx', { title: 't', columns: ['أ'], rows: [['1', 'زائد'], 'خطأ'] });
      assert.equal(r.status, 200);
      const sh = unzip(r.buf)['xl/worksheets/sheet1.xml'];
      assert.ok(!sh.includes('زائد'));
    });
    await check('التصدير يُسجَّل في التدقيق (export_xlsx)', async () => {
      const a = await call(admin, 'GET', '/api/audit?limit=50');
      assert.ok(a.data.rows.some(x => x.action === 'export_xlsx'), JSON.stringify(a.data).slice(0, 200));
    });
    await check('مسار PDF القديم لم يتأثر', async () => {
      assert.equal((await call(admin, 'POST', '/api/export/pdf', { title: 't', columns: ['a'], rows: [['1']] })).status, 200);
    });
  } catch (e) {
    fail++; console.log('  ✗ فشل غير متوقع: ' + e.stack);
  } finally {
    if (srv) { const s = srv; await new Promise(r => { s.removeAllListeners('exit'); s.on('exit', r); s.kill(); }); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} نجح، ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})();
