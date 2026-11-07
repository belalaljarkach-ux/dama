/**
 * roles.test.js — دور «منسق حركة الآليات» (fleet_coordinator) وصلاحية «تعديل السجل الكامل».
 *
 * خادم حقيقي على SQLite مؤقتة (لا يلمس قاعدة الإنتاج):
 *  1) إنشاء المستخدم الجديد بالدور الجديد وتعديل دوره، وتسجيل دخوله والتحقق من جلسته.
 *  2) مصفوفة الصلاحيات في الخادم لكل الأدوار على كل مسارات مدير الآليات.
 *  3) المنسق = مدير الآليات في كل المسارات عدا «تعديل السجل الكامل» و«حذف العملية» (للمدير وحده).
 *  4) تعديل السجل الكامل: كل الحقول، التدقيق (من ومتى وقبل/بعد)، 403 لغير المدير دون أثر.
 *  5) بقية الأدوار والبيانات السابقة بلا تغيير.
 *
 *   node test/roles.test.js
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

const PORT = 8892, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'roles-test-pw-1', COORD_PW = 'coord-test-pw-1';
async function login(user, pw) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
  if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await r.json() };
}
async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ cookie }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* ليس JSON (CSV مثلًا) */ }
  return { status: r.status, data, text };
}
const ok = async (...a) => { const r = await call(...a); if (r.status >= 400) throw new Error(`${a[1]} ${a[2]} → ${r.status} ${r.text.slice(0, 120)}`); return r; };

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-roles-'));
  const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dataDir,
    GATE_LOG_CONFIG: path.join(dataDir, 'none.json'), ADMIN_PASSWORD: ADMIN_PW });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
      srv.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); res(); } });
      srv.on('exit', c => rej(new Error('الخادم توقّف ' + c)));
    });
    const pwPath = path.join(dataDir, 'كلمات-المرور-الأولية.txt');
    for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
    const pwFile = fs.readFileSync(pwPath, 'utf8');
    const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];

    const admin = (await login('admin', ADMIN_PW)).cookie;
    const J = {};   // role → cookie
    J.gate = (await login('بوابة', pwOf('بوابة'))).cookie;
    J.fleet_manager = (await login('مدير_الاليات', pwOf('مدير_الاليات'))).cookie;
    J.fuel = (await login('المازوت', pwOf('المازوت'))).cookie;
    J.fuel_warehouse_manager = (await login('مدير_مستودع_المازوت', pwOf('مدير_مستودع_المازوت'))).cookie;
    J.hr = (await login('مسؤول_الموارد_البشرية', pwOf('مسؤول_الموارد_البشرية'))).cookie;
    J.admin = admin;

    console.log('\nحساب المنسق الجاهز عند التثبيت الأول');
    await check('كلمة مرور الحساب الجاهز «منسق_حركة_الاليات» مطبوعة في ملف كلمات المرور الأولية', async () =>
      assert.ok(pwOf('منسق_حركة_الاليات'), 'غير موجودة'));
    await check('الحساب الجاهز يسجّل الدخول بدور fleet_coordinator ولا يملك تعديل السجل ولا الحذف', async () => {
      const l = await login('منسق_حركة_الاليات', pwOf('منسق_حركة_الاليات'));
      assert.equal(l.body.role, 'fleet_coordinator');
      const p = (await ok(l.cookie, 'GET', '/api/state')).data.permissions;
      assert.equal(p.editFullRecord, false); assert.equal(p.deleteEntry, false); });
    await check('يظهر في قائمة المستخدمين الفعّالين بالاسم الكامل «منسق حركة الآليات»', async () => {
      const u = (await ok(admin, 'GET', '/api/users')).data.users.find(x => x.username === 'منسق_حركة_الاليات');
      assert.equal(u.role, 'fleet_coordinator'); assert.equal(u.fullName, 'منسق حركة الآليات'); assert.equal(u.active, true); });

    console.log('\nإنشاء المستخدم الجديد وتسجيل الدخول');
    let coordUser;
    await check('الدور يُقبل عند إنشاء مستخدم (POST /api/users → 201)', async () => {
      const r = await ok(admin, 'POST', '/api/users', { username: 'منسق_حركة', fullName: 'منسق حركة الآليات', role: 'fleet_coordinator', password: COORD_PW });
      assert.equal(r.status, 201); assert.equal(r.data.user.role, 'fleet_coordinator'); coordUser = r.data.user;
    });
    await check('دور غير معروف ما زال مرفوضًا (400)', async () =>
      assert.equal((await call(admin, 'POST', '/api/users', { username: 'x1', role: 'fleet_boss', password: 'abcdef' })).status, 400));
    await check('الدور يظهر في قائمة المستخدمين', async () => {
      const u = (await ok(admin, 'GET', '/api/users')).data.users.find(x => x.username === 'منسق_حركة'); assert.equal(u.role, 'fleet_coordinator'); });
    let coord;
    await check('تسجيل دخول المنسق ينجح ويعيد الدور الصحيح', async () => {
      const l = await login('منسق_حركة', COORD_PW); coord = l.cookie; assert.equal(l.body.role, 'fleet_coordinator'); });
    await check('/api/me و/api/state يعيدان الدور نفسه من الجلسة', async () => {
      assert.equal((await ok(coord, 'GET', '/api/me')).data.role, 'fleet_coordinator');
      assert.equal((await ok(coord, 'GET', '/api/state')).data.role, 'fleet_coordinator'); });
    await check('كلمة مرور خاطئة للمنسق مرفوضة', async () => {
      const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'منسق_حركة', password: 'wrong-pw-1' }) });
      assert.notEqual(r.status, 200); });
    await check('تعديل دور مستخدم (PUT /api/users/:id) إلى المنسق وإعادته', async () => {
      const u = (await ok(admin, 'POST', '/api/users', { username: 'مؤقت', role: 'gate', password: 'abcdef1' })).data.user;
      assert.equal((await ok(admin, 'PUT', '/api/users/' + u.id, { fullName: 'مؤقت', role: 'fleet_coordinator' })).data.user.role, 'fleet_coordinator');
      assert.equal((await ok(admin, 'PUT', '/api/users/' + u.id, { fullName: 'مؤقت', role: 'gate' })).data.user.role, 'gate'); });
    J.fleet_coordinator = coord;

    console.log('\nالأذونات في /api/state (تقرؤها الواجهة)');
    for (const [role, expected] of [['fleet_manager', true], ['fleet_coordinator', false], ['admin', false], ['gate', false], ['fuel', false], ['hr', false], ['fuel_warehouse_manager', false]]) {
      await check(`${role}: editFullRecord = deleteEntry = ${expected}`, async () => {
        const perms = (await ok(J[role], 'GET', '/api/state')).data.permissions;
        assert.equal(perms.editFullRecord, expected); assert.equal(perms.deleteEntry, expected); });
    }

    // بيانات اختبار
    for (const [name, type] of [['جبالة 1', 'gabbala'], ['جبالة 2', 'gabbala'], ['خدمة 1', 'service'], ['جبالة 3', 'gabbala'], ['جبالة 4', 'gabbala']])
      await ok(admin, 'POST', '/api/vehicles', { name, baselineKm: 0, type });
    const dep = async (vehicle, extra) => (await ok(J.gate, 'POST', '/api/entries',
      Object.assign({ vehicle, driver: 'سائق ' + vehicle, customer: 'زبون', dateKey: '2026-03-10', departTime: '08:00', loadQty: 8 }, extra))).data.entry;
    const ret = async (e, km) => (await ok(J.gate, 'POST', `/api/entries/${e.id}/return`, { returnDate: '2026-03-10', returnTime: '10:00', km })).data.entry;
    const eMain = await ret(await dep('جبالة 1'), 40);                       // للتعديل
    const eOther = await ret(await dep('جبالة 2'), 40);                      // يجب أن يبقى كما هو
    const eDelC = await ret(await dep('جبالة 3'), 40);                       // يحاول المنسق حذفه فيفشل
    const eDelM = await ret(await dep('جبالة 4'), 40);                       // يحذفه المدير
    const eOpen = await dep('جبالة 1', { dateKey: '2026-03-11', departTime: '09:00' });   // مفتوحة
    const snapshot = async id => (await ok(admin, 'GET', '/api/state?days=0')).data.entries.find(e => e.id === id);
    const otherBefore = JSON.stringify(await snapshot(eOther.id));
    const body = Object.assign({}, eMain, { returnDate: eMain.returnDate, returnTime: eMain.returnTime, km: eMain.km });

    console.log('\nمصفوفة الصلاحيات في الخادم (PUT = تعديل السجل الكامل)');
    const allRoles = ['gate', 'fleet_manager', 'fleet_coordinator', 'fuel', 'fuel_warehouse_manager', 'hr', 'admin'];
    for (const role of allRoles) {
      await check(`PUT /api/entries/:id — ${role}: ${role === 'fleet_manager' ? 'مسموح' : '403'}`, async () => {
        const r = await call(J[role], 'PUT', '/api/entries/' + eMain.id, Object.assign({}, body, { notesOut: 'by ' + role }));
        assert.equal(r.status, role === 'fleet_manager' ? 200 : 403, r.text.slice(0, 100)); });
    }
    await check('محاولات المنسق وغيره المرفوضة لم تغيّر السجل (ملاحظة المدير فقط)', async () =>
      assert.equal((await snapshot(eMain.id)).notesOut, 'by fleet_manager'));
    await check('بلا جلسة → 401', async () => assert.equal((await call('', 'PUT', '/api/entries/' + eMain.id, body)).status, 401));

    console.log('\nالمنسق = مدير الآليات في كل المسارات عدا التعديل والحذف');
    const probes = [
      ['GET', '/api/state'], ['GET', '/api/reports/period?from=2026-03-10&to=2026-03-10'], ['GET', '/api/export/entries.csv'],
      ['POST', '/api/export/pdf', { title: 't', columns: ['a'], rows: [['1']] }],
      ['GET', '/api/users'], ['GET', '/api/audit'], ['POST', '/api/backup'],
      ['POST', '/api/vehicles', { name: 'م', baselineKm: 0, type: 'service' }],
      ['POST', '/api/entries', { vehicle: 'خدمة 1', driver: 'س', customer: 'ز', departTime: '08:00' }],
      ['POST', '/api/fuel/fills', { vehicle: 'خدمة 1', km: 1, qty: 1, tank: 'tank1', time: '08:00' }],
      ['POST', '/api/fuel/baseline', { tank: 'tank1', initialQty: 1, initialMeter: 1 }]
    ];
    for (const [m, u, b] of probes) {
      await check(`${m} ${u.split('?')[0]}: حالة المنسق = حالة المدير`, async () => {
        const mgrR = await call(J.fleet_manager, m, u, b), coR = await call(J.fleet_coordinator, m, u, b);
        assert.equal(coR.status, mgrR.status, `منسق ${coR.status} / مدير ${mgrR.status}`); });
    }
    await check('المنسق يصل إلى مسارات الإدارة المسموحة للمدير (تقارير/CSV/PDF = 200)', async () => {
      for (const [m, u, b] of probes.slice(1, 4)) assert.equal((await call(J.fleet_coordinator, m, u, b)).status, 200, u); });
    await check('المنسق ممنوع من مسارات الأدمن والبوابة والمازوت (403)', async () => {
      for (const [m, u, b] of [probes[4], probes[5], probes[6], probes[7], probes[8], probes[9], probes[10]]) assert.equal((await call(J.fleet_coordinator, m, u, b)).status, 403, u); });
    await check('حذف عملية: المنسق ممنوع (403) والسجل باقٍ', async () => {
      assert.equal((await call(J.fleet_coordinator, 'DELETE', '/api/entries/' + eDelC.id)).status, 403);
      assert.ok(await snapshot(eDelC.id), 'السجل حُذف رغم المنع'); });
    await check('حذف عملية: المدير مسموح', async () => {
      assert.equal((await call(J.fleet_manager, 'DELETE', '/api/entries/' + eDelM.id)).status, 200);
      assert.equal(await snapshot(eDelM.id), undefined); });
    await check('حذف عملية: بقية الأدوار 403 (بوابة، مازوت، موارد بشرية، مدير المستودع، أدمن)', async () => {
      for (const role of ['gate', 'fuel', 'hr', 'fuel_warehouse_manager', 'admin'])
        assert.equal((await call(J[role], 'DELETE', '/api/entries/' + eDelC.id)).status, 403, role);
      assert.ok(await snapshot(eDelC.id)); });
    await check('تصدير CSV: المدير والمنسق 200 — بقية الأدوار 403', async () => {
      for (const role of ['fleet_manager', 'fleet_coordinator']) assert.equal((await call(J[role], 'GET', '/api/export/entries.csv')).status, 200, role);
      for (const role of ['gate', 'fuel', 'hr', 'fuel_warehouse_manager', 'admin']) assert.equal((await call(J[role], 'GET', '/api/export/entries.csv')).status, 403, role); });
    await check('التقارير: المدير والمنسق والأدمن 200 — البوابة والمازوت والموارد 403', async () => {
      for (const role of ['fleet_manager', 'fleet_coordinator', 'admin']) assert.equal((await call(J[role], 'GET', '/api/reports/period')).status, 200, role);
      for (const role of ['gate', 'fuel', 'hr', 'fuel_warehouse_manager']) assert.equal((await call(J[role], 'GET', '/api/reports/period')).status, 403, role); });

    console.log('\nتعديل السجل الكامل (مدير الآليات): كل الحقول + التدقيق');
    const full = { vehicle: 'جبالة 1', driver: 'سائق جديد', customer: 'زبون جديد', dateKey: '2026-03-09', departTime: '07:15',
      notesOut: 'ملاحظة خروج', notesIn: 'ملاحظة عودة', loadQty: 12.5, manualPour: true, returnDate: '2026-03-09', returnTime: '11:45', km: 77.5 };
    let edited;
    await check('المدير يعدّل كل الحقول دفعة واحدة', async () => {
      edited = (await ok(J.fleet_manager, 'PUT', '/api/entries/' + eMain.id, full)).data.entry;
      for (const k of Object.keys(full)) assert.equal(edited[k], full[k], k); });
    await check('التعديل محفوظ فعليًا في قاعدة البيانات وبقي المعرّف وتاريخ الإنشاء', async () => {
      const s = await snapshot(eMain.id);
      assert.equal(s.driver, 'سائق جديد'); assert.equal(s.id, eMain.id); assert.equal(s.createdAt, eMain.createdAt); assert.equal(s.status, 'done'); });
    await check('التدقيق: سجل edit_entry بالمستخدم والدور والوقت وقبل/بعد', async () => {
      const rows = (await ok(admin, 'GET', '/api/audit?limit=500')).data.rows.filter(r => r.action === 'edit_entry' && r.entityId === eMain.id || r.action === 'edit_entry' && r.entity_id === eMain.id);
      const mine = rows.find(r => (r.username || '') === 'مدير_الاليات');
      assert.ok(mine, 'لا سجل تدقيق للمدير'); assert.equal(mine.role, 'fleet_manager');
      assert.ok(!isNaN(new Date(mine.at).getTime()), 'وقت غير صالح');
      const d = typeof mine.detail === 'string' ? JSON.parse(mine.detail) : mine.detail;
      assert.equal(d.before.driver, 'سائق ' + 'جبالة 1'); assert.equal(d.after.driver, 'سائق جديد'); });
    await check('محاولة المنسق المرفوضة لا تُنشئ سجل تعديل بحسابه', async () => {
      const rows = (await ok(admin, 'GET', '/api/audit?limit=500')).data.rows;
      assert.ok(!rows.some(r => r.action === 'edit_entry' && (r.username === 'منسق_حركة' || r.role === 'fleet_coordinator'))); });
    await check('ملاحظة العودة لا تضيع عند تعديل سجل غير مكتمل', async () => {
      const r = (await ok(J.fleet_manager, 'PUT', '/api/entries/' + eOpen.id, Object.assign({}, eOpen, { notesIn: 'تبقى', returnTime: null, km: null }))).data.entry;
      assert.equal(r.status, 'out'); assert.equal(r.notesIn, 'تبقى'); });
    await check('إبقاء سجل «في الخارج» لآلية لها رحلة مفتوحة أخرى → 409 واضحة (لا 500)', async () => {
      const r = await call(J.fleet_manager, 'PUT', '/api/entries/' + eMain.id, Object.assign({}, full, { returnTime: null, km: null }));
      assert.equal(r.status, 409, r.text.slice(0, 100)); assert.match(r.data.error, /في الخارج/);
      assert.equal((await snapshot(eMain.id)).status, 'done'); });
    await check('حقول إلزامية ما زالت تُتحقَّق (الزبون الفارغ → 400)', async () =>
      assert.equal((await call(J.fleet_manager, 'PUT', '/api/entries/' + eMain.id, Object.assign({}, full, { customer: '' }))).status, 400));

    console.log('\nبقية البيانات والأدوار بلا تغيير');
    await check('سجل آخر لم يُعدَّل بقي كما هو حرفيًا', async () => assert.equal(JSON.stringify(await snapshot(eOther.id)), otherBefore));
    await check('الأدوار القديمة ما زالت تسجّل الدخول وتحصل على أدوارها', async () => {
      for (const [u, r] of [['بوابة', 'gate'], ['مدير_الاليات', 'fleet_manager'], ['المازوت', 'fuel'], ['مدير_مستودع_المازوت', 'fuel_warehouse_manager'], ['مسؤول_الموارد_البشرية', 'hr']])
        assert.equal((await login(u, pwOf(u))).body.role, r); });
    await check('البوابة ما زالت تسجّل مغادرة، والأدمن ما زال يدير المستخدمين', async () => {
      assert.equal((await call(J.gate, 'POST', '/api/entries', { vehicle: 'خدمة 1', driver: 'س', customer: 'ز', dateKey: '2026-03-12', departTime: '08:00' })).status, 201);
      assert.equal((await call(admin, 'GET', '/api/users')).status, 200); });

    console.log('\nترقية قاعدة قائمة (بلا حساب منسق) ثم إعادة التشغيل');
    srv.kill(); await new Promise(r => setTimeout(r, 600));
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = path.join(dataDir, 'gate-log.db');
    const raw = new DatabaseSync(dbFile);
    const usersBefore = raw.prepare("SELECT username, password_hash, role FROM users WHERE role <> 'fleet_coordinator' ORDER BY username").all();
    raw.prepare("DELETE FROM users WHERE role = 'fleet_coordinator'").run();   // قاعدة قديمة سبقت الدور
    raw.close();
    const pwFileBefore = fs.readFileSync(pwPath, 'utf8');
    const boot = () => new Promise((res, rej) => {
      const c = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
      c.stdout.on('data', d => { out += d; if (String(d).includes('الخادم يعمل')) { clearTimeout(t); setTimeout(() => res({ c, out }), 300); } });
      c.on('exit', code => rej(new Error('توقّف ' + code)));
    });
    let r2 = await boot();
    await check('إعادة التشغيل تزرع حساب المنسق الجاهز مرة واحدة وتطبع كلمة مروره', async () => {
      assert.match(r2.out, /منسق_حركة_الاليات\s*:\s*\S+/); });
    await check('كلمات المرور الأولية القديمة في الملف لم تُمسح (إضافة لا استبدال)', async () => {
      const after = fs.readFileSync(pwPath, 'utf8');
      assert.ok(after.includes(pwOf('بوابة')) && after.length > pwFileBefore.length); });
    const newPw = (r2.out.match(/منسق_حركة_الاليات\s*:\s*(\S+)/) || [])[1];
    await check('الحساب المزروع يعمل بكلمة المرور المطبوعة بدور المنسق', async () => {
      assert.equal((await login('منسق_حركة_الاليات', newPw)).body.role, 'fleet_coordinator'); });
    await check('بقية الحسابات (كلمات المرور والأدوار) لم تُمس إطلاقًا', async () => {
      const r3 = new DatabaseSync(dbFile, { readOnly: true });
      const now = r3.prepare("SELECT username, password_hash, role FROM users WHERE role <> 'fleet_coordinator' ORDER BY username").all(); r3.close();
      assert.deepEqual(now, usersBefore); });
    r2.c.kill(); await new Promise(r => setTimeout(r, 600));
    r2 = await boot();
    await check('إعادة تشغيل ثانية لا تنشئ حسابًا ولا كلمة مرور جديدة', async () => {
      assert.ok(!/منسق_حركة_الاليات\s*:/.test(r2.out));
      assert.equal((await login('منسق_حركة_الاليات', newPw)).body.role, 'fleet_coordinator'); });
    r2.c.kill();
  } catch (e) { fail++; console.log('  ✗ فشل الإعداد: ' + e.message); }
  finally { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  console.log(`\nالنتيجة: ${pass} نجح، ${fail} فشل\n`);
  process.exit(fail ? 1 : 0);
})();
