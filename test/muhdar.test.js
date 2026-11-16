/**
 * muhdar.test.js — المحاضر + اختيار السائق والزبون فقط (لا كتابة حرة، مفروض في الخادم).
 *
 * خادم حقيقي على SQLite مؤقتة:
 *  1) الصلاحيات: إدارة الزبائن والمناطق والمحاضر للأدمن وحده (الخادم يفرضها).
 *  2) زبائن ومناطق ومحاضر: إضافة، تكرار 409، تحقق، تعديل، علاقات (محضر ← زبون + منطقة)، وحمايات الحذف.
 *  3) خروج آلية: المحضر إلزامي، والزبون يُشتقّ منه في الخادم (نص الزبون المُرسَل يُتجاهل)، ومحضر مجهول/زبون حر/سائق غير مسجّل → 400.
 *  4) تعديل السجل: لا زبون حر ولا سائق غير مسجّل، لكن السجل القديم يبقى قابلًا للتعديل دون تغيير اسميه، ولا تتغير بقية السجلات.
 *  5) سائق/زبون يُضافان من الإعداد الأولي يظهران في /api/state ويُقبلان.
 *  6) قاعدة قائمة قبل migration 005: الزبون يبقى نصًا كما كان، السائق غير المسجّل مرفوض، والبيانات القديمة سليمة؛
 *     وبعد تطبيق الـ migration يدويًا يظهر الدعم وتبقى السجلات القديمة بلا محضر.
 *
 *   node test/muhdar.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

const PORT = 8906, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'muhdar-pw-1';
const call = async (cookie, method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: Object.assign(cookie ? { cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* */ }
  return { status: r.status, data, text };
};
const login = async (user, pw) => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
  if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
};

let srv = null;
async function start(dir) {
  const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dir,
    GATE_LOG_CONFIG: path.join(dir, 'none.json'), ADMIN_PASSWORD: ADMIN_PW });
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
    srv.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); res(); } });
    srv.on('exit', c => rej(new Error('الخادم توقّف ' + c)));
  });
}
async function stop() {
  if (!srv) return;
  const s = srv; srv = null;
  await new Promise(r => { s.removeAllListeners('exit'); s.on('exit', r); s.kill(); });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-mh-'));
  try {
    await start(dir);
    const pwPath = path.join(dir, 'كلمات-المرور-الأولية.txt');
    for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
    const pwFile = fs.readFileSync(pwPath, 'utf8');
    const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];
    let R = {};
    const logins = async () => {
      R = { admin: await login('admin', ADMIN_PW), gate: await login('بوابة', pwOf('بوابة')),
        manager: await login('مدير_الاليات', pwOf('مدير_الاليات')), coord: await login('منسق_حركة_الاليات', pwOf('منسق_حركة_الاليات')) };
    };
    await logins();
    const state = async c => (await call(c, 'GET', '/api/state')).data;
    // قراءة مباشرة من القاعدة (السجل القديم خارج نافذة أيام /api/state).
    const rowOf = id => { const d = new DatabaseSync(path.join(dir, 'gate-log.db')); const r = d.prepare('SELECT * FROM entries WHERE id = ?').get(id); d.close(); return r; };
    const dep = (o) => call(R.gate, 'POST', '/api/entries', Object.assign({ vehicle: 'خدمة 1', dateKey: '2026-03-10', departTime: '08:00' }, o));

    await call(R.admin, 'POST', '/api/vehicles', { name: 'خدمة 1', baselineKm: 0, type: 'service' });
    await call(R.admin, 'POST', '/api/vehicles', { name: 'خدمة 2', baselineKm: 0, type: 'service' });

    console.log('— الدعم والقوائم الفارغة');
    await check('muhdarSupported=true والقوائم فارغة على قاعدة جديدة', async () => {
      const st = await state(R.admin);
      assert.equal(st.muhdarSupported, true);
      assert.deepEqual([st.customers, st.regions, st.muhdars], [[], [], []]);
    });

    console.log('— الصلاحيات (الخادم)');
    for (const [url, body] of [['/api/customers', { name: 'ز' }], ['/api/regions', { name: 'م' }]]) {
      await check(`POST ${url}: الأدمن وحده`, async () => {
        assert.equal((await call(R.manager, 'POST', url, body)).status, 403);
        assert.equal((await call(R.coord, 'POST', url, body)).status, 403);
        assert.equal((await call(R.gate, 'POST', url, body)).status, 403);
        assert.equal((await call(null, 'POST', url, body)).status, 401);
      });
    }

    await check('POST /api/muhdars: الأدمن ومدير الآليات والمنسق فقط (البوابة والمجهول مرفوضان)', async () => {
      const body = { name: 'ح', customerId: 'x', regionId: 'y' };
      assert.equal((await call(R.gate, 'POST', '/api/muhdars', body)).status, 403);
      assert.equal((await call(null, 'POST', '/api/muhdars', body)).status, 401);
      // مدير الآليات والمنسق يمرّان من الصلاحية فيصلان للتحقق (400 لا 403)
      assert.equal((await call(R.manager, 'POST', '/api/muhdars', body)).status, 400);
      assert.equal((await call(R.coord, 'POST', '/api/muhdars', body)).status, 400);
    });
    await check('/api/state يعلن الصلاحية addMuhdar للأدوار الثلاثة فقط', async () => {
      assert.equal((await state(R.admin)).permissions.addMuhdar, true);
      assert.equal((await state(R.manager)).permissions.addMuhdar, true);
      assert.equal((await state(R.coord)).permissions.addMuhdar, true);
      assert.equal((await state(R.gate)).permissions.addMuhdar, false);
    });

    console.log('— الزبائن والمناطق');
    let cA, cB, rN, rS;
    await check('إضافة زبون ومنطقة', async () => {
      const a = await call(R.admin, 'POST', '/api/customers', { name: 'شركة الأمل' }); assert.equal(a.status, 201, a.text); cA = a.data.customer.id;
      const b = await call(R.admin, 'POST', '/api/customers', { name: 'شركة النور' }); assert.equal(b.status, 201); cB = b.data.customer.id;
      const n = await call(R.admin, 'POST', '/api/regions', { name: 'الشمال' }); assert.equal(n.status, 201, n.text); rN = n.data.region.id;
      const s = await call(R.admin, 'POST', '/api/regions', { name: 'الجنوب' }); assert.equal(s.status, 201); rS = s.data.region.id;
    });
    await check('اسم مكرر 409، وفارغ 400', async () => {
      assert.equal((await call(R.admin, 'POST', '/api/customers', { name: 'شركة الأمل' })).status, 409);
      assert.equal((await call(R.admin, 'POST', '/api/regions', { name: 'الشمال' })).status, 409);
      assert.equal((await call(R.admin, 'POST', '/api/customers', { name: '   ' })).status, 400);
    });
    await check('الزبائن والمناطق تظهر في /api/state لكل الأدوار (أسماء فقط)', async () => {
      for (const c of [R.gate, R.manager, R.admin]) {
        const st = await state(c);
        assert.deepEqual(st.customers.map(x => x.name).sort(), ['شركة الأمل', 'شركة النور'].sort());
        assert.deepEqual(st.regions.map(x => x.name).sort(), ['الجنوب', 'الشمال'].sort());
      }
    });

    console.log('— المحاضر');
    let mh1, mh2;
    await check('إضافة محضر مرتبط بزبون ومنطقة', async () => {
      const r = await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر 101', customerId: cA, regionId: rN });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.muhdar.customerName, 'شركة الأمل'); assert.equal(r.data.muhdar.regionName, 'الشمال');
      mh1 = r.data.muhdar.id;
      const r2 = await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر 102', customerId: cB, regionId: rS });
      assert.equal(r2.status, 201); mh2 = r2.data.muhdar.id;
    });
    await check('تحقق: اسم مكرر 409، زبون/منطقة مجهولان 400، حقول ناقصة 400', async () => {
      assert.equal((await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر 101', customerId: cA, regionId: rN })).status, 409);
      assert.equal((await call(R.admin, 'POST', '/api/muhdars', { name: 'م', customerId: 'zzz', regionId: rN })).status, 400);
      assert.equal((await call(R.admin, 'POST', '/api/muhdars', { name: 'م', customerId: cA, regionId: 'zzz' })).status, 400);
      assert.equal((await call(R.admin, 'POST', '/api/muhdars', { name: 'م', customerId: cA })).status, 400);
      assert.equal((await call(R.admin, 'POST', '/api/muhdars', { name: '', customerId: cA, regionId: rN })).status, 400);
    });
    await check('المحاضر تظهر في /api/state لكل الأدوار', async () => {
      const st = await state(R.gate);
      assert.deepEqual(st.muhdars.map(m => [m.name, m.customerName, m.regionName]).sort(),
        [['محضر 101', 'شركة الأمل', 'الشمال'], ['محضر 102', 'شركة النور', 'الجنوب']].sort());
    });
    await check('تعديل محضر (الاسم والزبون والمنطقة)', async () => {
      const r = await call(R.admin, 'PUT', '/api/muhdars/' + mh2, { name: 'محضر 102 ب', customerId: cA, regionId: rN });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.muhdar.customerName, 'شركة الأمل'); assert.equal(r.data.muhdar.name, 'محضر 102 ب');
      assert.equal((await call(R.admin, 'PUT', '/api/muhdars/' + mh2, { name: 'محضر 101', customerId: cA, regionId: rN })).status, 409);
      assert.equal((await call(R.manager, 'PUT', '/api/muhdars/' + mh2, { name: 'x', customerId: cA, regionId: rN })).status, 403);
      assert.equal((await call(R.admin, 'PUT', '/api/muhdars/' + mh2, { name: 'محضر 102', customerId: cB, regionId: rS })).status, 200);
    });
    await check('مدير الآليات والمنسق يضيفان محضرًا؛ والتعديل والحذف للأدمن وحده', async () => {
      const a = await call(R.manager, 'POST', '/api/muhdars', { name: 'محضر المدير', customerId: cA, regionId: rN });
      assert.equal(a.status, 201, a.text); assert.equal(a.data.muhdar.customerName, 'شركة الأمل');
      const b = await call(R.coord, 'POST', '/api/muhdars', { name: 'محضر المنسق', customerId: cB, regionId: rS });
      assert.equal(b.status, 201, b.text);
      // نفس التحقق للجميع: تكرار 409، وزبون مجهول 400
      assert.equal((await call(R.coord, 'POST', '/api/muhdars', { name: 'محضر المنسق', customerId: cB, regionId: rS })).status, 409);
      assert.equal((await call(R.manager, 'POST', '/api/muhdars', { name: 'م9', customerId: 'zzz', regionId: rS })).status, 400);
      for (const c of [R.manager, R.coord]) {
        assert.equal((await call(c, 'PUT', '/api/muhdars/' + a.data.muhdar.id, { name: 'x', customerId: cA, regionId: rN })).status, 403);
        assert.equal((await call(c, 'DELETE', '/api/muhdars/' + a.data.muhdar.id)).status, 403);
      }
      assert.ok((await state(R.gate)).muhdars.some(m => m.name === 'محضر المنسق'));
      // الزبون يظهر تلقائيًا عند الخروج بمحضر أضافه المنسق
      await call(R.admin, 'POST', '/api/drivers', { name: 'سائق مؤقت', allowedTypes: [] });
      const e = await dep({ vehicle: 'خدمة 2', driver: 'سائق مؤقت', muhdarId: b.data.muhdar.id, dateKey: '2026-03-09' });
      assert.equal(e.status, 201, e.text); assert.equal(e.data.entry.customer, 'شركة النور');
      await call(R.gate, 'POST', `/api/entries/${e.data.entry.id}/return`, { returnDate: '2026-03-09', returnTime: '09:00', km: 1 });
      // التدقيق يسجّل من أضاف
      const au = (await call(R.admin, 'GET', '/api/audit')).data;
      const rows = (au.audit || au.rows || au.entries || []);
      assert.ok(rows.some(r => r.action === 'add_muhdar' && (r.role === 'fleet_coordinator')), 'سجل التدقيق لا يحوي إضافة المنسق');
    });
    await check('حذف زبون/منطقة مرتبطين بمحاضر مرفوض 409', async () => {
      assert.equal((await call(R.admin, 'DELETE', '/api/customers/' + cA)).status, 409);
      assert.equal((await call(R.admin, 'DELETE', '/api/regions/' + rN)).status, 409);
    });

    console.log('— خروج آلية: السائق والمحضر والزبون');
    await call(R.admin, 'POST', '/api/drivers', { name: 'سائق أ', allowedTypes: [] });
    let entry1;
    await check('بلا محضر → 400', async () => {
      const r = await dep({ driver: 'سائق أ', customer: 'شركة الأمل' });
      assert.equal(r.status, 400, r.text); assert.ok(r.data.error.includes('المحضر'));
    });
    await check('زبون جديد مكتوب يدويًا (بلا محضر) → 400', async () => {
      assert.equal((await dep({ driver: 'سائق أ', customer: 'زبون مخترَع' })).status, 400);
    });
    await check('محضر مجهول → 400', async () => {
      assert.equal((await dep({ driver: 'سائق أ', muhdarId: 'nope' })).status, 400);
    });
    await check('سائق غير مسجّل (مكتوب يدويًا) → 400 حتى مع محضر صحيح', async () => {
      const r = await dep({ driver: 'سائق مخترَع', muhdarId: mh1 });
      assert.equal(r.status, 400, r.text); assert.ok(r.data.error.includes('السائق'));
    });
    await check('محضر صحيح: الزبون يُشتقّ من المحضر ويُتجاهل النص المُرسَل', async () => {
      const r = await dep({ driver: 'سائق أ', muhdarId: mh1, customer: 'زبون مخترَع' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.entry.customer, 'شركة الأمل'); assert.equal(r.data.entry.muhdarId, mh1); assert.equal(r.data.entry.driver, 'سائق أ');
      entry1 = r.data.entry;
    });
    await check('المحضر الثاني → الزبون الثاني تلقائيًا', async () => {
      const r = await dep({ vehicle: 'خدمة 2', driver: 'سائق أ', muhdarId: mh2 });
      assert.equal(r.status, 201, r.text); assert.equal(r.data.entry.customer, 'شركة النور');
    });
    await check('سائق يُضاف من الإعداد الأولي يظهر في القائمة ويُقبل', async () => {
      assert.ok(!(await state(R.gate)).drivers.some(d => d.name === 'سائق ب'));
      assert.equal((await call(R.admin, 'POST', '/api/drivers', { name: 'سائق ب', allowedTypes: [] })).status, 201);
      assert.ok((await state(R.gate)).drivers.some(d => d.name === 'سائق ب'));
      await call(R.gate, 'POST', `/api/entries/${entry1.id}/return`, { returnDate: '2026-03-10', returnTime: '09:00', km: 10 });
      const r = await dep({ driver: 'سائق ب', muhdarId: mh1, dateKey: '2026-03-11' });
      assert.equal(r.status, 201, r.text);
    });
    await check('زبون يُضاف من الإعداد الأولي بمحضر يظهر ويُستعمل', async () => {
      const c = await call(R.admin, 'POST', '/api/customers', { name: 'شركة الفجر' });
      const m = await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر 103', customerId: c.data.customer.id, regionId: rN });
      assert.equal(m.status, 201);
      assert.ok((await state(R.gate)).customers.some(x => x.name === 'شركة الفجر'));
      assert.ok((await state(R.gate)).muhdars.some(x => x.name === 'محضر 103' && x.customerName === 'شركة الفجر'));
    });

    console.log('— حماية البيانات السابقة');
    await check('زبون له سجلات: تعديل الاسم والحذف مرفوضان 409', async () => {
      assert.equal((await call(R.admin, 'PUT', '/api/customers/' + cA, { name: 'اسم جديد' })).status, 409);
      assert.equal((await call(R.admin, 'DELETE', '/api/customers/' + cA)).status, 409);
    });
    await check('محضر مستخدم في سجلات: الحذف مرفوض 409', async () => {
      assert.equal((await call(R.admin, 'DELETE', '/api/muhdars/' + mh1)).status, 409);
    });
    await check('منطقة وزبون بلا ارتباطات: يُعدَّلان ويُحذفان', async () => {
      const g = await call(R.admin, 'POST', '/api/regions', { name: 'مؤقتة' });
      assert.equal((await call(R.admin, 'PUT', '/api/regions/' + g.data.region.id, { name: 'مؤقتة 2' })).status, 200);
      assert.equal((await call(R.admin, 'DELETE', '/api/regions/' + g.data.region.id)).status, 200);
      const c = await call(R.admin, 'POST', '/api/customers', { name: 'مؤقت' });
      assert.equal((await call(R.admin, 'PUT', '/api/customers/' + c.data.customer.id, { name: 'مؤقت 2' })).status, 200);
      assert.equal((await call(R.admin, 'DELETE', '/api/customers/' + c.data.customer.id)).status, 200);
    });

    console.log('— تعديل السجل (مدير الآليات) وسجلات قديمة');
    {
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      d.prepare(`INSERT INTO entries (id, date_key, vehicle, driver, customer, depart_time, notes_out, return_date, return_time, km, notes_in, status, created_at, updated_at)
                 VALUES ('told1','2026-01-05','خدمة 1','سائق قديم','زبون قديم','07:00','', '2026-01-05','08:00',5,'','done','2026-01-05T07:00:00Z','2026-01-05T08:00:00Z')`).run();
      d.close();
    }
    const edit = (id, o) => call(R.manager, 'PUT', '/api/entries/' + id, Object.assign({ vehicle: 'خدمة 1', dateKey: '2026-01-05', departTime: '07:00', returnDate: '2026-01-05', returnTime: '08:00', km: 5 }, o));
    await check('السجل القديم يُعدَّل بلا تغيير سائقه وزبونه (لا يُكسر)', async () => {
      const r = await edit('told1', { driver: 'سائق قديم', customer: 'زبون قديم', notesOut: 'ملاحظة' });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.entry.driver, 'سائق قديم'); assert.equal(r.data.entry.customer, 'زبون قديم'); assert.equal(r.data.entry.muhdarId, null);
    });
    await check('تغيير السائق إلى اسم غير مسجّل → 400', async () => {
      assert.equal((await edit('told1', { driver: 'سائق مخترَع', customer: 'زبون قديم' })).status, 400);
    });
    await check('تغيير الزبون إلى اسم غير مسجّل → 400', async () => {
      assert.equal((await edit('told1', { driver: 'سائق قديم', customer: 'زبون مخترَع' })).status, 400);
    });
    await check('تغيير الزبون إلى زبون مسجّل (بلا محضر) → 200', async () => {
      const r = await edit('told1', { driver: 'سائق أ', customer: 'شركة النور' });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.entry.customer, 'شركة النور'); assert.equal(r.data.entry.muhdarId, null);
    });
    await check('تعديل بمحضر: الزبون يُشتقّ منه', async () => {
      const r = await edit('told1', { driver: 'سائق أ', customer: 'أي شيء', muhdarId: mh1 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.entry.customer, 'شركة الأمل'); assert.equal(r.data.entry.muhdarId, mh1);
    });
    await check('المنسق لا يعدّل السجل الكامل (الصلاحيات كما كانت)', async () => {
      assert.equal((await call(R.coord, 'PUT', '/api/entries/told1', { vehicle: 'خدمة 1' })).status, 403);
    });

    console.log('— قاعدة قائمة قبل migration 005');
    await stop();
    {
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      d.exec('DROP INDEX ix_entries_muhdar; ALTER TABLE entries DROP COLUMN muhdar_id; DROP TABLE muhdars; DROP TABLE regions; DROP TABLE customers;');
      d.close();
    }
    await start(dir); await logins();
    await check('الدعم false والقوائم فارغة والبيانات القديمة سليمة', async () => {
      const st = await state(R.admin);
      assert.equal(st.muhdarSupported, false);
      assert.deepEqual([st.customers, st.regions, st.muhdars], [[], [], []]);
      const e = rowOf('told1');
      assert.equal(e.customer, 'شركة الأمل'); assert.equal(e.driver, 'سائق أ');
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      const n = d.prepare('SELECT COUNT(*) AS n FROM entries').get().n; d.close();
      assert.ok(n >= 4, 'السجلات السابقة محفوظة: ' + n);
    });
    await check('الزبون يبقى نصًا حرًّا كما كان (لا فرض بلا جداول)', async () => {
      await call(R.admin, 'POST', '/api/vehicles', { name: 'خدمة 3', baselineKm: 0, type: 'service' });
      const r = await dep({ vehicle: 'خدمة 3', driver: 'سائق أ', customer: 'زبون نصي', dateKey: '2026-03-15' });
      assert.equal(r.status, 201, r.text); assert.equal(r.data.entry.customer, 'زبون نصي');
    });
    await check('السائق غير المسجّل مرفوض حتى بلا migration (جدول drivers موجود)', async () => {
      assert.equal((await dep({ driver: 'سائق مخترَع', customer: 'ز', dateKey: '2026-03-20' })).status, 400);
    });
    await check('إدارة الزبائن والمحاضر تُرفض 409 وتذكر migration 005', async () => {
      const r = await call(R.admin, 'POST', '/api/customers', { name: 'x' });
      assert.equal(r.status, 409); assert.ok(r.data.error.includes('005'));
      assert.equal((await call(R.admin, 'POST', '/api/muhdars', { name: 'x', customerId: 'a', regionId: 'b' })).status, 409);
    });
    await check('الخادم لم ينشئ الجداول تلقائيًا', async () => {
      await stop();
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      const names = d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
      const hasCol = d.prepare(`SELECT name FROM pragma_table_info('entries')`).all().some(c => c.name === 'muhdar_id');
      d.close();
      assert.ok(!names.includes('customers') && !names.includes('muhdars') && !names.includes('regions') && !hasCol);
    });

    console.log('— بعد تطبيق الـ migration يدويًا');
    {
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      d.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
              CREATE TABLE regions (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
              CREATE TABLE muhdars (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL, region_id TEXT NOT NULL, created_at TEXT NOT NULL);
              ALTER TABLE entries ADD COLUMN muhdar_id TEXT;
              INSERT INTO customers (id, name, created_at) SELECT 'c' || rowid, customer, '2026-01-01' FROM (SELECT customer, MIN(rowid) AS rowid FROM entries GROUP BY customer);`);
      d.close();
    }
    await start(dir); await logins();
    await check('الدعم true، والزبائن مُلئت من السجلات، والسجلات القديمة بلا محضر وبلا تغيير', async () => {
      const st = await state(R.admin);
      assert.equal(st.muhdarSupported, true);
      assert.ok(st.customers.some(c => c.name === 'زبون نصي'));
      const e = rowOf('told1');
      assert.equal(e.customer, 'شركة الأمل'); assert.equal(e.muhdar_id, null);
    });
    await check('الآن المحضر إلزامي وزبون الكتابة الحرة مرفوض', async () => {
      const r = await dep({ vehicle: 'خدمة 3', driver: 'سائق أ', customer: 'زبون نصي', dateKey: '2026-04-01' });
      assert.equal(r.status, 400, r.text);
    });
  } catch (e) {
    fail++; console.log('  ✗ فشل غير متوقع: ' + e.stack);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} نجح، ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})();
