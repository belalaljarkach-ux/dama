/**
 * guest-stats.test.js — إحصاءات «عدد الزبائن» و«عدد الضيوف» في لوحة الأدمن.
 *
 * خادم حقيقي على SQLite مؤقتة (لا يلمس قاعدة الإنتاج ولا يطبّق أي migration):
 *  A) قاعدة جديدة (فيها عمود visit_type): تسجيل من حسابَي بوابة مختلفين → الأدمن يرى مجموع الجميع،
 *     لا عدّ مزدوج، البطاقات من السجلات الفعلية، إغلاق الزيارة (خروج) لا يغيّر العدد، النوع الخاطئ 400،
 *     الصلاحيات (guestStats للأدمن وحده، التسجيل للبوابة وحدها).
 *  B) قاعدة قديمة بلا عمود visit_type (migration 002 لم يُطبَّق): التطبيق يعمل كما كان؛ كل شيء «ضيوف»،
 *     «زبون» يُرفض 409 بدل أن يُسجَّل ضيفًا بصمت، ولا يُعدَّل مخطط الجدول.
 *
 *   node test/guest-stats.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

const ADMIN_PW = 'guest-stats-pw-1';
async function startServer(port, dataDir) {
  const env = Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dataDir,
    GATE_LOG_CONFIG: path.join(dataDir, 'none.json'), ADMIN_PASSWORD: ADMIN_PW });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
    srv.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); res(); } });
    srv.on('exit', c => rej(new Error('الخادم توقّف ' + c)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (cookie, method, url, body) => {
    const r = await fetch(base + url, { method, headers: Object.assign({ cookie }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* */ }
    return { status: r.status, data, text };
  };
  const login = async (user, pw) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
    if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const pwPath = path.join(dataDir, 'كلمات-المرور-الأولية.txt');
  for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
  const pwFile = fs.readFileSync(pwPath, 'utf8');
  const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];
  return { srv, call, login, pwOf };
}
const today = () => new Date().toISOString().slice(0, 10);
const stats = async (S, admin) => (await S.call(admin, 'GET', '/api/state')).data.guestStats;

(async () => {
  /* ------------------------------------------------------------ A */
  console.log('\nA) قاعدة جديدة (عمود visit_type موجود)');
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-gs-a-'));
  const A = await startServer(8893, dirA);
  try {
    const admin = await A.login('admin', ADMIN_PW);
    const gate1 = await A.login('بوابة', A.pwOf('بوابة'));
    const created = await A.call(admin, 'POST', '/api/users', { username: 'بوابة_٢', fullName: 'بوابة ثانية', role: 'gate', password: 'gate-two-pw-1' });
    assert.equal(created.status, 201);
    const gate2 = await A.login('بوابة_٢', 'gate-two-pw-1');
    const fleet = await A.login('مدير_الاليات', A.pwOf('مدير_الاليات'));
    const reg = (cookie, type, n) => A.call(cookie, 'POST', '/api/guests',
      { vehicleDesc: 'مركبة ' + n, purpose: 'جهة ' + n, dateIn: today(), timeIn: '10:15', visitType: type });

    await check('قبل أي تسجيل: العدّادان صفر ومن قاعدة البيانات', async () => {
      const s = await stats(A, admin);
      assert.deepEqual([s.customers, s.guests, s.todayCustomers, s.todayGuests, s.typeSupported], [0, 0, 0, 0, true]);
    });
    let firstId;
    await check('بوابة ١ تسجّل زبونًا → 201 ويُخزَّن النوع مع التاريخ والوقت', async () => {
      const r = await reg(gate1, 'customer', 'v1');
      assert.equal(r.status, 201);
      assert.equal(r.data.visit.visitType, 'customer');
      assert.equal(r.data.visit.dateIn, today()); assert.equal(r.data.visit.timeIn, '10:15');
      firstId = r.data.visit.id;
    });
    await check('الأدمن يرى الزبون فورًا في /api/state (الزبائن=1، الضيوف=0)', async () => {
      const s = await stats(A, admin);
      assert.equal(s.customers, 1); assert.equal(s.guests, 0);
    });
    await check('بوابة ٢ (حساب آخر) تسجّل ضيفين وزبونًا → الأدمن يرى مجموع الحسابين (الزبائن=2، الضيوف=2)', async () => {
      assert.equal((await reg(gate2, 'guest', 'g1')).status, 201);
      assert.equal((await reg(gate2, 'guest', 'g2')).status, 201);
      assert.equal((await reg(gate2, 'customer', 'v2')).status, 201);
      const s = await stats(A, admin);
      assert.equal(s.customers, 2); assert.equal(s.guests, 2);
    });
    await check('بلا نوع في الطلب = ضيف (السلوك السابق) — بلا عدّ مزدوج لأي سجل', async () => {
      const r = await A.call(gate1, 'POST', '/api/guests', { vehicleDesc: 'قديم', purpose: 'x', dateIn: today(), timeIn: '11:00' });
      assert.equal(r.data.visit.visitType, 'guest');
      const s = await stats(A, admin);
      assert.equal(s.customers + s.guests, 5);   // 5 سجلات = 5 عدّات بالضبط
      const rows = (await A.call(admin, 'GET', '/api/state')).data.guestVisits;
      assert.equal(rows.length, 5);
      assert.equal(new Set(rows.map(v => v.id)).size, 5);
      assert.equal(rows.filter(v => v.visitType === 'customer').length, s.customers);
      assert.equal(rows.filter(v => v.visitType === 'guest').length, s.guests);
    });
    await check('تسجيل خروج زيارة لا يغيّر الإحصاءات (العدّ للتسجيل لا للتواجد)', async () => {
      const before = await stats(A, admin);
      const r = await A.call(gate1, 'POST', `/api/guests/${firstId}/exit`, { dateOut: today(), timeOut: '12:00' });
      assert.equal(r.status, 200);
      const after = await stats(A, admin);
      assert.deepEqual(after, before);
    });
    await check('إعادة قراءة الحالة مرارًا (تحديث دوري) لا تغيّر الأعداد', async () => {
      const a = await stats(A, admin), b = await stats(A, admin), c = await stats(A, admin);
      assert.deepEqual(a, b); assert.deepEqual(b, c);
    });
    await check('إحصاء اليوم التشغيلي: تسجيل اليوم يُحتسب، تسجيل قديم (2020) لا يُحتسب في «اليوم» لكنه في الإجمالي', async () => {
      const before = await stats(A, admin);
      await A.call(gate1, 'POST', '/api/guests', { vehicleDesc: 'قديمة', purpose: 'x', dateIn: '2020-01-01', timeIn: '09:00', visitType: 'customer' });
      const after = await stats(A, admin);
      assert.equal(after.customers, before.customers + 1);
      assert.equal(after.todayCustomers, before.todayCustomers);
    });
    await check('الإحصاء لا يتقيّد بنافذة الأيام ولا بالمستخدم الحالي (سجل 2020 ضمن الإجمالي مع أنه خارج guestVisits)', async () => {
      // السجل القديم ما زال «بالموقع» فيظهر دائمًا في القائمة؛ نغلقه فيخرج من نافذة الأيام فقط.
      const old = (await A.call(admin, 'GET', '/api/state')).data.guestVisits.find(v => v.dateIn === '2020-01-01');
      assert.equal((await A.call(gate1, 'POST', `/api/guests/${old.id}/exit`, { dateOut: '2020-01-01', timeOut: '10:00' })).status, 200);
      const st = (await A.call(admin, 'GET', '/api/state')).data;
      assert.ok(!st.guestVisits.some(v => v.dateIn === '2020-01-01'));
      assert.equal(st.guestStats.customers, 3);
    });
    await check('الصلاحيات: guestStats للأدمن وحده (null لبقية الأدوار)', async () => {
      for (const c of [gate1, gate2, fleet]) assert.equal((await A.call(c, 'GET', '/api/state')).data.guestStats, null);
      assert.ok((await A.call(admin, 'GET', '/api/state')).data.guestStats);
    });
    await check('الصلاحيات: التسجيل للبوابة وحدها (الأدمن ومدير الآليات 403)', async () => {
      assert.equal((await reg(admin, 'guest', 'x')).status, 403);
      assert.equal((await reg(fleet, 'guest', 'x')).status, 403);
    });
    await check('نوع غير صالح → 400 بلا أثر على العدّادات', async () => {
      const before = await stats(A, admin);
      assert.equal((await reg(gate1, 'vip', 'x')).status, 400);
      assert.deepEqual(await stats(A, admin), before);
    });
    await check('البوابة ترى خيار النوع مفعّلًا (guestVisitTypeSupported=true)', async () => {
      assert.equal((await A.call(gate1, 'GET', '/api/state')).data.guestVisitTypeSupported, true);
    });
  } finally { A.srv.kill(); }

  /* ------------------------------------------------------------ B */
  console.log('\nB) قاعدة قديمة بلا عمود visit_type (migration 002 غير مُطبَّق)');
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-gs-b-'));
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(path.join(dirB, 'gate-log.db'));
  old.exec(`CREATE TABLE guest_visits (id TEXT PRIMARY KEY, vehicle_desc TEXT NOT NULL, purpose TEXT NOT NULL,
            date_in TEXT NOT NULL, time_in TEXT NOT NULL, date_out TEXT, time_out TEXT,
            status TEXT NOT NULL CHECK (status IN ('in','out')), created_by TEXT);
            INSERT INTO guest_visits VALUES ('g-old1','سيارة قديمة','مورّد','2026-01-01','08:00',NULL,NULL,'in','بوابة');`);
  old.close();
  const B = await startServer(8894, dirB);
  try {
    const admin = await B.login('admin', ADMIN_PW);
    const gate = await B.login('بوابة', B.pwOf('بوابة'));
    await check('الإقلاع يعمل ولا يضيف العمود تلقائيًا (لا تعديل على المخطط)', async () => {
      const chk = new DatabaseSync(path.join(dirB, 'gate-log.db'));
      const cols = chk.prepare(`SELECT name FROM pragma_table_info('guest_visits')`).all().map(c => c.name);
      chk.close();
      assert.ok(!cols.includes('visit_type'));
    });
    await check('الإحصاءات تعمل: السجل القديم = ضيف، الزبائن 0، typeSupported=false', async () => {
      const s = await stats(B, admin);
      assert.deepEqual([s.customers, s.guests, s.typeSupported], [0, 1, false]);
    });
    await check('تسجيل ضيف (السلوك القديم، بلا نوع) ما زال يعمل ويظهر عند الأدمن', async () => {
      const r = await B.call(gate, 'POST', '/api/guests', { vehicleDesc: 'جديد', purpose: 'y', dateIn: today(), timeIn: '09:00' });
      assert.equal(r.status, 201);
      assert.equal((await stats(B, admin)).guests, 2);
    });
    await check('تسجيل «زبون» يُرفض 409 برسالة واضحة ولا يُسجَّل ضيفًا بصمت', async () => {
      const r = await B.call(gate, 'POST', '/api/guests', { vehicleDesc: 'زبون', purpose: 'z', dateIn: today(), timeIn: '09:30', visitType: 'customer' });
      assert.equal(r.status, 409);
      assert.match(r.data.error || r.text, /002/);
      assert.equal((await stats(B, admin)).guests, 2);
    });
    await check('البوابة لا ترى خيار النوع (guestVisitTypeSupported=false)', async () => {
      assert.equal((await B.call(gate, 'GET', '/api/state')).data.guestVisitTypeSupported, false);
    });
  } finally { B.srv.kill(); }

  console.log(`\n${pass} نجح، ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
