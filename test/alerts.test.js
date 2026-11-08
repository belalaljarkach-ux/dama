/**
 * alerts.test.js — تنبيهات تجاوز المسافة: حدّ الكيلومترات، التبرير، وانتقال التنبيه بين الأدوار.
 *
 * خادم حقيقي على SQLite مؤقتة (لا يلمس قاعدة الإنتاج ولا يطبّق أي migration):
 *  A) الحد بالكيلومتر (لا نسبة): التنبيه عند مسافة > الحد فقط، تعديل الحد بلا تعديل كود، صلاحية الضبط.
 *  B) التبرير: إلزامي (فارغ/مسافات → 400)، مرتبط بالتنبيه والسائق والآلية والتاريخ، زر الحفظ = POST.
 *  C) الانتقال: مدير الآليات يرى المعلّق ← بعد الحفظ يختفي من قائمته ← يظهر للأدمن مع التبرير
 *     واسم المدير ووقت الإدخال ← يبقى للأدمن؛ لا حذف ولا استبدال؛ تدوين في audit.
 *  D) الصلاحيات في الخادم (403/401) لكل الأدوار.
 *  E) قاعدة قديمة بلا جدول التبريرات (migration 003 لم يُطبَّق): لا إنشاء تلقائي، رفض واضح 409.
 *
 *   node test/alerts.test.js
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

const ADMIN_PW = 'alerts-test-pw-1';
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
    const r = await fetch(base + url, { method, headers: Object.assign(cookie ? { cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
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
  const roles = {
    admin: await login('admin', ADMIN_PW),
    gate: await login('بوابة', pwOf('بوابة')),
    manager: await login('مدير_الاليات', pwOf('مدير_الاليات')),
    coordinator: await login('منسق_حركة_الاليات', pwOf('منسق_حركة_الاليات')),
    fuel: await login('المازوت', pwOf('المازوت')),
    hr: await login('مسؤول_الموارد_البشرية', pwOf('مسؤول_الموارد_البشرية'))
  };
  return { srv, call, roles };
}
const today = new Date().toISOString().slice(0, 10);
const D = '/api/alerts/distance';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-al-a-'));
  const S = await startServer(8897, dir);
  const { call, roles: R } = S;
  const ids = {};
  try {
    // آلية بكيلومتراج 0، ثلاث رحلات: مسافات 40 و120 و60 كم (أعمدة: 40 → 160 → 220).
    assert.equal((await call(R.admin, 'POST', '/api/vehicles', { name: 'جبالة 7', baselineKm: 0, type: 'gabbala' })).status, 201);
    let time = 6;
    for (const [tag, km] of [['A', 40], ['B', 160], ['C', 220]]) {
      const hh = String(time++).padStart(2, '0');
      const e = await call(R.gate, 'POST', '/api/entries', { vehicle: 'جبالة 7', driver: 'سائق ' + tag, customer: 'زبون ' + tag, dateKey: today, departTime: hh + ':00', loadQty: 5 });
      assert.equal(e.status, 201, e.text);
      const r = await call(R.gate, 'POST', `/api/entries/${e.data.entry.id}/return`, { returnDate: today, returnTime: hh + ':45', km });
      assert.equal(r.status, 200, r.text);
      ids[tag] = e.data.entry.id;
    }

    console.log('\nA) الحد بالكيلومتر');
    await check('بلا حد محدَّد: لا تنبيهات مسافة (limitKm=null) حتى للرحلات الكبيرة', async () => {
      const r = await call(R.manager, 'GET', D);
      assert.equal(r.status, 200);
      assert.equal(r.data.limitKm, null);
      assert.deepEqual(r.data.pending, []);
    });
    await check('حدّ غير صالح (0، سالب، نص، فارغ) → 400 ولا يُحفظ', async () => {
      for (const v of [0, -5, 'abc', null, 1e9]) assert.equal((await call(R.manager, 'PUT', D + '-limit', { limitKm: v })).status, 400);
      assert.equal((await call(R.manager, 'GET', D)).data.limitKm, null);
    });
    await check('مدير الآليات يضبط الحد 50 كم → 200 ويظهر في /api/state', async () => {
      assert.equal((await call(R.manager, 'PUT', D + '-limit', { limitKm: 50 })).status, 200);
      assert.equal((await call(R.manager, 'GET', '/api/state')).data.alertDistanceLimitKm, 50);
    });
    await check('التنبيه فقط للمسافة > الحد: B (120) وC (60) لا A (40) — لا نسبة ولا متوسط', async () => {
      const p = (await call(R.manager, 'GET', D)).data.pending;
      assert.deepEqual(p.map(a => a.entryId).sort(), [ids.B, ids.C].sort());
      const b = p.find(a => a.entryId === ids.B);
      assert.equal(b.distance, 120); assert.equal(b.limitKm, 50); assert.equal(b.excess, 70);
      assert.equal(b.kmStart, 40); assert.equal(b.kmEnd, 160); assert.equal(b.status, 'pending');
      assert.equal(b.vehicle, 'جبالة 7'); assert.equal(b.driver, 'سائق B'); assert.equal(b.dateKey, today);
    });
    await check('الحد قابل للتعديل بلا كود: رفعه إلى 100 يُسقط C ويُبقي B', async () => {
      await call(R.manager, 'PUT', D + '-limit', { limitKm: 100 });
      assert.deepEqual((await call(R.manager, 'GET', D)).data.pending.map(a => a.entryId), [ids.B]);
      await call(R.manager, 'PUT', D + '-limit', { limitKm: 50 });
      assert.equal((await call(R.manager, 'GET', D)).data.pending.length, 2);
    });
    await check('تغيير الحد مُدوَّن في audit بالقيمة قبل/بعد ومن غيّره', async () => {
      const rows = (await call(R.admin, 'GET', '/api/audit')).data;
      const list = Array.isArray(rows) ? rows : (rows.audit || rows.rows || []);
      const hit = list.filter(x => x.action === 'alert_limit_set');
      assert.ok(hit.length >= 3, 'عدد السجلات ' + hit.length);
      const d = JSON.parse(hit[0].detail);
      assert.ok('before' in d && 'after' in d);
      assert.equal(hit[0].username, 'مدير_الاليات');
    });

    console.log('\nD) الصلاحيات في الخادم');
    await check('ضبط الحد: المنسق والأدمن والبوابة والمازوت والموارد البشرية → 403، بلا جلسة → 401', async () => {
      for (const k of ['coordinator', 'admin', 'gate', 'fuel', 'hr']) assert.equal((await call(R[k], 'PUT', D + '-limit', { limitKm: 5 })).status, 403, k);
      assert.equal((await call(null, 'PUT', D + '-limit', { limitKm: 5 })).status, 401);
      assert.equal((await call(R.manager, 'GET', D)).data.limitKm, 50);
    });
    await check('قراءة التنبيهات: مدير/منسق/أدمن فقط (البوابة والمازوت والموارد البشرية 403)', async () => {
      for (const k of ['manager', 'coordinator', 'admin']) assert.equal((await call(R[k], 'GET', D)).status, 200, k);
      for (const k of ['gate', 'fuel', 'hr']) assert.equal((await call(R[k], 'GET', D)).status, 403, k);
    });
    await check('كتابة التبرير: المنسق والأدمن والبوابة → 403 ولا أثر', async () => {
      for (const k of ['coordinator', 'admin', 'gate', 'hr']) {
        assert.equal((await call(R[k], 'POST', `${D}/${ids.B}/justify`, { justification: 'محاولة' })).status, 403, k);
      }
      assert.equal((await call(R.admin, 'GET', D)).data.justified.length, 0);
    });
    await check('permissions: setAlertLimit/justifyAlerts للمدير وحده', async () => {
      const p = async k => (await call(R[k], 'GET', '/api/state')).data.permissions;
      assert.deepEqual([(await p('manager')).setAlertLimit, (await p('manager')).justifyAlerts], [true, true]);
      for (const k of ['coordinator', 'admin', 'gate']) assert.deepEqual([(await p(k)).setAlertLimit, (await p(k)).justifyAlerts], [false, false], k);
    });
    await check('الحد لا يُكشف للبوابة في /api/state', async () => {
      assert.equal((await call(R.gate, 'GET', '/api/state')).data.alertDistanceLimitKm, null);
    });

    console.log('\nB) التبرير الإلزامي');
    await check('تبرير فارغ أو مسافات فقط أو غير موجود → 400 ولا يُحفظ', async () => {
      for (const v of ['', '   ', '\n\t', null, undefined]) {
        assert.equal((await call(R.manager, 'POST', `${D}/${ids.B}/justify`, { justification: v })).status, 400);
      }
      assert.equal((await call(R.manager, 'POST', `${D}/${ids.B}/justify`, {})).status, 400);
      assert.equal((await call(R.admin, 'GET', D)).data.justified.length, 0);
    });
    await check('تبرير أطول من 1000 حرف → 400', async () => {
      assert.equal((await call(R.manager, 'POST', `${D}/${ids.B}/justify`, { justification: 'ن'.repeat(1001) })).status, 400);
    });
    await check('رحلة ليست تنبيهًا (A تحت الحد) أو معرّف مجهول → 404', async () => {
      assert.equal((await call(R.manager, 'POST', `${D}/${ids.A}/justify`, { justification: 'سبب' })).status, 404);
      assert.equal((await call(R.manager, 'POST', `${D}/nope-123/justify`, { justification: 'سبب' })).status, 404);
    });

    console.log('\nC) الانتقال من مدير الآليات إلى الأدمن');
    let rec;
    await check('مدير الآليات يحفظ تبرير B → 201 مرتبطًا بالتنبيه والسائق والآلية والتاريخ', async () => {
      const r = await call(R.manager, 'POST', `${D}/${ids.B}/justify`, { justification: '  توصيل إضافي لموقع بعيد بطلب الإدارة  ' });
      assert.equal(r.status, 201, r.text);
      rec = r.data.record;
      assert.equal(rec.entryId, ids.B); assert.equal(rec.status, 'justified'); assert.equal(rec.alertType, 'distance');
      assert.equal(rec.vehicle, 'جبالة 7'); assert.equal(rec.driver, 'سائق B'); assert.equal(rec.dateKey, today);
      assert.equal(rec.distance, 120); assert.equal(rec.limitKm, 50);
      assert.equal(rec.justification, 'توصيل إضافي لموقع بعيد بطلب الإدارة');
      assert.equal(rec.justifiedBy, 'مدير_الاليات'); assert.ok(!isNaN(Date.parse(rec.justifiedAt)));
    });
    await check('يختفي B من قائمة المعلّق عند مدير الآليات (وC باقٍ) ولا يرى المبرَّر', async () => {
      const r = (await call(R.manager, 'GET', D)).data;
      assert.deepEqual(r.pending.map(a => a.entryId), [ids.C]);
      assert.equal(r.justified, undefined);
    });
    await check('المنسق أيضًا لا يرى B معلّقًا بعد التبرير', async () => {
      assert.deepEqual((await call(R.coordinator, 'GET', D)).data.pending.map(a => a.entryId), [ids.C]);
    });
    await check('الأدمن يرى B مبرَّرًا مع التفاصيل والتبرير واسم المدير ووقت الإدخال، وعدد المعلّق=1', async () => {
      const r = (await call(R.admin, 'GET', D)).data;
      assert.equal(r.pendingCount, 1); assert.equal(r.pending, undefined);
      assert.equal(r.justified.length, 1);
      const j = r.justified[0];
      assert.deepEqual([j.entryId, j.vehicle, j.driver, j.customer, j.dateKey, j.distance, j.limitKm, j.justifiedBy],
        [ids.B, 'جبالة 7', 'سائق B', 'زبون B', today, 120, 50, 'مدير_الاليات']);
      assert.equal(j.justification, rec.justification); assert.equal(j.justifiedAt, rec.justifiedAt);
      assert.ok(j.returnTime && j.departTime);
    });
    await check('تبرير ثانٍ لنفس التنبيه → 409 ولا يُستبدل الأول', async () => {
      const r = await call(R.manager, 'POST', `${D}/${ids.B}/justify`, { justification: 'نص جديد يحاول الاستبدال' });
      assert.equal(r.status, 409);
      assert.equal((await call(R.admin, 'GET', D)).data.justified[0].justification, rec.justification);
    });
    await check('السجل يبقى في قاعدة البيانات ولو تغيّر الحد (رفعه فوق المسافة يُبقي B عند الأدمن بلقطته)', async () => {
      await call(R.manager, 'PUT', D + '-limit', { limitKm: 500 });
      const r = (await call(R.admin, 'GET', D)).data;
      assert.equal(r.justified.length, 1); assert.equal(r.justified[0].limitKm, 50); assert.equal(r.pendingCount, 0);
      assert.deepEqual((await call(R.manager, 'GET', D)).data.pending, []);
      await call(R.manager, 'PUT', D + '-limit', { limitKm: 50 });
    });
    await check('تدوين في audit: alert_justify بالتبرير والمسافة والحد ومن كتبه', async () => {
      const rows = (await call(R.admin, 'GET', '/api/audit')).data;
      const list = Array.isArray(rows) ? rows : (rows.audit || rows.rows || []);
      const hit = list.filter(x => x.action === 'alert_justify');
      assert.equal(hit.length, 1);
      const d = JSON.parse(hit[0].detail);
      assert.equal(d.justification, rec.justification); assert.equal(d.distance, 120); assert.equal(d.limitKm, 50);
      assert.equal(hit[0].username, 'مدير_الاليات'); assert.equal(hit[0].entity_id, ids.B);
    });
    await check('تبرير C ثم لا تنبيهات معلّقة ولا عدّ مزدوج (مبرَّران عند الأدمن، 0 معلّق)', async () => {
      assert.equal((await call(R.manager, 'POST', `${D}/${ids.C}/justify`, { justification: 'مسار بديل بسبب إغلاق الطريق' })).status, 201);
      assert.deepEqual((await call(R.manager, 'GET', D)).data.pending, []);
      const r = (await call(R.admin, 'GET', D)).data;
      assert.equal(r.justified.length, 2); assert.equal(new Set(r.justified.map(j => j.entryId)).size, 2); assert.equal(r.pendingCount, 0);
    });
    await check('العمليات نفسها لم تُمَسّ (الرحلات الثلاث ما زالت في السجل بكيلومتراتها)', async () => {
      const es = (await call(R.manager, 'GET', '/api/state')).data.entries;
      assert.deepEqual(['A', 'B', 'C'].map(t => es.find(e => e.id === ids[t]).km), [40, 160, 220]);
    });
  } finally { S.srv.kill(); }

  console.log('\nE) قاعدة قديمة بلا جدول التبريرات (migration 003 غير مُطبَّق)');
  const { DatabaseSync } = require('node:sqlite');
  const dirE = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-al-e-'));
  let S1 = await startServer(8898, dirE);
  S1.srv.kill(); await new Promise(r => setTimeout(r, 400));
  const dbE = new DatabaseSync(path.join(dirE, 'gate-log.db'));
  dbE.exec('DROP TABLE alert_justifications');
  dbE.close();
  const E = await startServer(8898, dirE);
  try {
    const { call: c, roles: Q } = E;
    await c(Q.admin, 'POST', '/api/vehicles', { name: 'جبالة 9', baselineKm: 0, type: 'gabbala' });
    const e = await c(Q.gate, 'POST', '/api/entries', { vehicle: 'جبالة 9', driver: 'س', customer: 'ز', dateKey: today, departTime: '07:00', loadQty: 1 });
    await c(Q.gate, 'POST', `/api/entries/${e.data.entry.id}/return`, { returnDate: today, returnTime: '08:00', km: 300 });
    await c(Q.manager, 'PUT', D + '-limit', { limitKm: 100 });
    await check('الإقلاع لا ينشئ الجدول تلقائيًا (لا تعديل على المخطط)', async () => {
      const chk = new DatabaseSync(path.join(dirE, 'gate-log.db'));
      const t = chk.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='alert_justifications'`).get();
      chk.close();
      assert.equal(t, undefined);
    });
    await check('الحد والقائمة المعلّقة يعملان، supported=false', async () => {
      const r = (await c(Q.manager, 'GET', D)).data;
      assert.equal(r.supported, false); assert.equal(r.pending.length, 1); assert.equal(r.limitKm, 100);
    });
    await check('حفظ التبرير يُرفض 409 برسالة تذكر migration 003 ويبقى التنبيه معلّقًا', async () => {
      const r = await c(Q.manager, 'POST', `${D}/${e.data.entry.id}/justify`, { justification: 'سبب' });
      assert.equal(r.status, 409); assert.match(r.data.error || r.text, /003/);
      assert.equal((await c(Q.manager, 'GET', D)).data.pending.length, 1);
    });
  } finally { E.srv.kill(); }

  console.log(`\n${pass} نجح، ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
