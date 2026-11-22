/**
 * setup-contact-distance.test.js — بيانات تواصل الزبون (اسم التواصل + الهاتف) وبُعد المسافة للمحضر (كم).
 *
 * خادم حقيقي على SQLite مؤقتة:
 *  1) قاعدة جديدة: الدعم true، إضافة/تعديل/تفريغ بيانات التواصل، والتحقق من الهاتف في الخادم،
 *     ولا يرى غير الأدمن بيانات التواصل في /api/state.
 *  2) بُعد المسافة: رقم > 0 يقبل الكسور (والأرقام العربية والفاصلة)، فارغ = بلا قيمة، رفض الصفر والسالب والنص،
 *     التعديل بلا الحقل لا يغيّره، ومدير الآليات/المنسق يضيفان محضرًا ببُعد، وكل الأدوار ترى القيمة.
 *  3) قاعدة قائمة قبل migration 006: السلوك القديم كما هو، وإدخال قيمة جديدة مرفوض (409)، والبيانات القديمة سليمة؛
 *     وبعد تطبيق الـ migration يدويًا يعمل الحقلان وتبقى السجلات القديمة بلا قيم.
 *
 *   node test/setup-contact-distance.test.js
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

const PORT = 8907, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'contact-pw-1';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-cd-'));
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
    const dbOpen = () => new DatabaseSync(path.join(dir, 'gate-log.db'));

    const g = await call(R.admin, 'POST', '/api/regions', { name: 'الشمال' });
    const g2 = await call(R.admin, 'POST', '/api/regions', { name: 'الجنوب' });
    const regionId = g.data.region.id, regionId2 = g2.data.region.id;

    console.log('— الدعم وبيانات التواصل');
    await check('الدعم true على قاعدة جديدة', async () => {
      const st = await state(R.admin);
      assert.equal(st.customerContactSupported, true);
      assert.equal(st.muhdarDistanceSupported, true);
    });
    let cust;
    await check('إضافة زبون ببيانات تواصل وتُعاد بعد القراءة', async () => {
      const r = await call(R.admin, 'POST', '/api/customers', { name: 'شركة الأمل', contactPerson: ' أحمد سالم ', phone: '0555 123 456' });
      assert.equal(r.status, 201, r.text);
      cust = r.data.customer;
      assert.equal(cust.contactPerson, 'أحمد سالم');
      assert.equal(cust.phone, '0555 123 456');
      const st = await state(R.admin);
      const row = st.customers.find(c => c.id === cust.id);
      assert.equal(row.contactPerson, 'أحمد سالم'); assert.equal(row.phone, '0555 123 456');
    });
    await check('زبون بلا بيانات تواصل (اختيارية) يُقبل وتظهر فارغة', async () => {
      const r = await call(R.admin, 'POST', '/api/customers', { name: 'زبون بسيط' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.customer.contactPerson, ''); assert.equal(r.data.customer.phone, '');
    });
    await check('الهاتف: أرقام عربية تُحوَّل، و+ و- مقبولة', async () => {
      const r = await call(R.admin, 'POST', '/api/customers', { name: 'زبون هاتف', phone: '+٩٦٣ ٩٣-١٢٣٤٥٦' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.customer.phone, '+963 93-123456');
    });
    for (const bad of ['abc', '12', '555-ABC-1234', '1'.repeat(25), '<b>1234567</b>']) {
      await check(`هاتف غير صالح «${bad}» → 400`, async () => {
        const r = await call(R.admin, 'POST', '/api/customers', { name: 'سيء ' + bad.length, phone: bad });
        assert.equal(r.status, 400, r.text);
      });
    }
    await check('تعديل بيانات التواصل بلا تغيير الاسم', async () => {
      const r = await call(R.admin, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل', contactPerson: 'خالد', phone: '0999 000 111' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.customer.contactPerson, 'خالد'); assert.equal(r.data.customer.phone, '0999 000 111');
    });
    await check('PUT بلا حقلَي التواصل لا يغيّرهما', async () => {
      const r = await call(R.admin, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.customer.contactPerson, 'خالد'); assert.equal(r.data.customer.phone, '0999 000 111');
    });
    await check('إرسال قيم فارغة يفرّغ بيانات التواصل', async () => {
      const r = await call(R.admin, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل', contactPerson: '', phone: '' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.customer.contactPerson, ''); assert.equal(r.data.customer.phone, '');
      await call(R.admin, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل', contactPerson: 'خالد', phone: '0999 000 111' });
    });
    await check('الإدارة للأدمن وحده: مدير الآليات والبوابة لا يعدّلان بيانات التواصل', async () => {
      for (const c of [R.manager, R.coord, R.gate]) {
        const r = await call(c, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل', phone: '0111 111 111' });
        assert.equal(r.status, 403);
      }
    });
    await check('بيانات التواصل ظاهرة للأدمن فقط في /api/state (الباقون: الاسم فقط)', async () => {
      for (const c of [R.manager, R.coord, R.gate]) {
        const row = (await state(c)).customers.find(x => x.id === cust.id);
        assert.ok(row && row.name === 'شركة الأمل');
        assert.equal(row.phone, undefined); assert.equal(row.contactPerson, undefined);
      }
    });

    console.log('— بُعد المسافة للمحضر');
    const mh = body => call(R.admin, 'POST', '/api/muhdars', Object.assign({ customerId: cust.id, regionId }, body));
    let m1;
    await check('إضافة محضر ببُعد كسري', async () => {
      const r = await mh({ name: 'محضر 1', distanceKm: 12.5 });
      assert.equal(r.status, 201, r.text);
      m1 = r.data.muhdar; assert.equal(m1.distanceKm, 12.5);
    });
    await check('بُعد صحيح، وسلسلة بفاصلة عربية وأرقام عربية', async () => {
      const a = await mh({ name: 'محضر 2', distanceKm: 40 });
      assert.equal(a.data.muhdar.distanceKm, 40);
      const b = await mh({ name: 'محضر 3', distanceKm: '٧,٥' });
      assert.equal(b.status, 201, b.text); assert.equal(b.data.muhdar.distanceKm, 7.5);
    });
    await check('بلا بُعد أو فارغ → null (اختياري)', async () => {
      const a = await mh({ name: 'محضر 4' });
      assert.equal(a.status, 201, a.text); assert.equal(a.data.muhdar.distanceKm, null);
      const b = await mh({ name: 'محضر 5', distanceKm: '' });
      assert.equal(b.status, 201, b.text); assert.equal(b.data.muhdar.distanceKm, null);
    });
    for (const bad of [0, -3, 'abc', 100001, '1e9x']) {
      await check(`بُعد غير صالح «${bad}» → 400`, async () => {
        const r = await mh({ name: 'سيء ' + String(bad), distanceKm: bad });
        assert.equal(r.status, 400, r.text);
      });
    }
    await check('تعديل المحضر: بلا الحقل يُبقي القيمة، وبقيمة جديدة يغيّرها، وبفارغ يفرّغها', async () => {
      let r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId: regionId2 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.muhdar.distanceKm, 12.5);
      assert.equal(r.data.muhdar.regionName, 'الجنوب');
      r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId, distanceKm: 99.25 });
      assert.equal(r.data.muhdar.distanceKm, 99.25);
      r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId, distanceKm: '' });
      assert.equal(r.data.muhdar.distanceKm, null);
      r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId, distanceKm: 12.5 });
      assert.equal(r.data.muhdar.distanceKm, 12.5);
    });
    await check('مدير الآليات والمنسق يضيفان محضرًا ببُعد؛ والبوابة ترى القيمة', async () => {
      const a = await call(R.manager, 'POST', '/api/muhdars', { name: 'محضر المدير', customerId: cust.id, regionId, distanceKm: 3 });
      assert.equal(a.status, 201, a.text); assert.equal(a.data.muhdar.distanceKm, 3);
      const b = await call(R.coord, 'POST', '/api/muhdars', { name: 'محضر المنسق', customerId: cust.id, regionId, distanceKm: 4.5 });
      assert.equal(b.status, 201, b.text);
      const row = (await state(R.gate)).muhdars.find(x => x.name === 'محضر المنسق');
      assert.equal(row.distanceKm, 4.5);
    });
    await check('تعديل محضر للأدمن وحده (مدير الآليات 403)', async () => {
      const r = await call(R.manager, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId, distanceKm: 1 });
      assert.equal(r.status, 403);
    });
    await check('العلاقات سليمة: المحضر ما زال مرتبطًا بالزبون والمنطقة بعد الدمج', async () => {
      const m = (await state(R.admin)).muhdars.find(x => x.id === m1.id);
      assert.equal(m.customerName, 'شركة الأمل'); assert.equal(m.regionName, 'الشمال');
      assert.equal((await call(R.admin, 'DELETE', `/api/regions/${regionId}`)).status, 409);
      assert.equal((await call(R.admin, 'DELETE', `/api/customers/${cust.id}`)).status, 409);
    });

    console.log('— حفظ واحد: المحضر مع منطقته (regionName)');
    const regionCount = async () => (await state(R.admin)).regions.length;
    await check('الأدمن: منطقة جديدة بالاسم تُنشأ مع المحضر في طلب واحد', async () => {
      const before = await regionCount();
      const r = await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر منطقة جديدة', customerId: cust.id, regionName: '  الشرق  ', distanceKm: 2 });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.muhdar.regionName, 'الشرق');
      assert.equal(await regionCount(), before + 1);
    });
    await check('اسم منطقة موجودة يُستعمل ولا تتكرر', async () => {
      const before = await regionCount();
      const r = await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر منطقة موجودة', customerId: cust.id, regionName: 'الشمال' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.muhdar.regionId, regionId);
      assert.equal(await regionCount(), before);
    });
    await check('محضر مكرر مع منطقة جديدة → 409 ولا تُنشأ منطقة يتيمة', async () => {
      const before = await regionCount();
      const r = await call(R.admin, 'POST', '/api/muhdars', { name: 'محضر 1', customerId: cust.id, regionName: 'منطقة يتيمة' });
      assert.equal(r.status, 409, r.text);
      assert.equal(await regionCount(), before);
    });
    await check('تعديل محضر إلى منطقة جديدة بالاسم', async () => {
      const r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionName: 'الوسط' });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.muhdar.regionName, 'الوسط');
      const back = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId });
      assert.equal(back.status, 200, back.text);
    });
    await check('بلا منطقة (لا regionId ولا regionName) → 400', async () => {
      const r = await call(R.admin, 'POST', '/api/muhdars', { name: 'بلا منطقة', customerId: cust.id });
      assert.equal(r.status, 400, r.text);
    });
    await check('مدير الآليات/المنسق: لا ينشئان منطقة جديدة بالاسم، ويستعملان الموجودة', async () => {
      const before = await regionCount();
      for (const c of [R.manager, R.coord]) {
        const bad = await call(c, 'POST', '/api/muhdars', { name: 'محضر غير مسموح', customerId: cust.id, regionName: 'منطقة من المدير' });
        assert.equal(bad.status, 400, bad.text);
      }
      assert.equal(await regionCount(), before);
      const okr = await call(R.manager, 'POST', '/api/muhdars', { name: 'محضر باسم موجود', customerId: cust.id, regionName: 'الشمال' });
      assert.equal(okr.status, 201, okr.text);
    });

    console.log('— قاعدة قائمة قبل migration 006');
    await stop();
    {
      const d = dbOpen();
      d.exec(`ALTER TABLE customers DROP COLUMN contact_person; ALTER TABLE customers DROP COLUMN phone;
              ALTER TABLE muhdars DROP COLUMN distance_km;`);
      d.close();
    }
    await start(dir); await logins();
    await check('الدعم false والبيانات القديمة سليمة بلا قيم جديدة', async () => {
      const st = await state(R.admin);
      assert.equal(st.customerContactSupported, false); assert.equal(st.muhdarDistanceSupported, false);
      assert.equal(st.muhdarSupported, true);
      const c = st.customers.find(x => x.id === cust.id);
      assert.equal(c.name, 'شركة الأمل'); assert.equal(c.contactPerson, ''); assert.equal(c.phone, '');
      const m = st.muhdars.find(x => x.id === m1.id);
      assert.equal(m.name, 'محضر 1'); assert.equal(m.customerName, 'شركة الأمل'); assert.equal(m.distanceKm, null);
    });
    await check('إضافة زبون/محضر بلا الحقول الجديدة تعمل كما قبل', async () => {
      assert.equal((await call(R.admin, 'POST', '/api/customers', { name: 'زبون قديم النمط' })).status, 201);
      assert.equal((await mh({ name: 'محضر قديم النمط' })).status, 201);
      assert.equal((await call(R.admin, 'POST', '/api/customers', { name: 'تفريغ', contactPerson: '', phone: '' })).status, 201);
    });
    await check('إدخال تواصل أو بُعد قبل الـ migration → 409 يذكر migration 006', async () => {
      let r = await call(R.admin, 'POST', '/api/customers', { name: 'ب', contactPerson: 'س' });
      assert.equal(r.status, 409); assert.match(r.text, /006/);
      r = await call(R.admin, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل', phone: '0555 111 222' });
      assert.equal(r.status, 409); assert.match(r.text, /006/);
      r = await mh({ name: 'محضر ببُعد', distanceKm: 5 });
      assert.equal(r.status, 409); assert.match(r.text, /006/);
    });
    await check('تعديل اسم/منطقة محضر لا يتأثر قبل الـ migration', async () => {
      const r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId: regionId2 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.muhdar.regionName, 'الجنوب');
    });

    console.log('— بعد تطبيق migration 006 يدويًا');
    await stop();
    {
      const d = dbOpen();
      d.exec(`ALTER TABLE customers ADD COLUMN contact_person TEXT; ALTER TABLE customers ADD COLUMN phone TEXT;
              ALTER TABLE muhdars ADD COLUMN distance_km REAL;`);
      d.close();
    }
    await start(dir); await logins();
    await check('الدعم true والسجلات القديمة بلا قيم، والتعديل يعمل', async () => {
      const st = await state(R.admin);
      assert.equal(st.customerContactSupported, true); assert.equal(st.muhdarDistanceSupported, true);
      assert.equal(st.customers.find(x => x.id === cust.id).phone, '');
      assert.equal(st.muhdars.find(x => x.id === m1.id).distanceKm, null);
      let r = await call(R.admin, 'PUT', `/api/customers/${cust.id}`, { name: 'شركة الأمل', contactPerson: 'سامر', phone: '0777 888 999' });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.customer.phone, '0777 888 999');
      r = await call(R.admin, 'PUT', `/api/muhdars/${m1.id}`, { name: 'محضر 1', customerId: cust.id, regionId: regionId2, distanceKm: 18 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.muhdar.distanceKm, 18);
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
