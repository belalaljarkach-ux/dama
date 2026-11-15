/**
 * pump-length.test.js — حقل «طول المضخة (متر)» عند تسجيل الآلية.
 *
 * خادم حقيقي على SQLite مؤقتة:
 *  1) قاعدة جديدة: العمود موجود و/api/state يعلن الدعم.
 *  2) مضخة: الطول إلزامي؛ يُرفض الفارغ والحروف والصفر والسالب والمبالغ فيه؛ يُقبل 36.5 و42؛ يُحفظ ويُعاد في القائمة والتعديل.
 *  3) الأنواع الأخرى (جبالة/خدمة/سيلو): لا يُطلب الطول، ويُهمَل لو أُرسل (null).
 *  4) التعديل: تعديل طول المضخة، وتغيير النوع بعيدًا عن مضخة يمسح الطول.
 *  5) الصلاحيات: التسجيل/التعديل للأدمن فقط كما كان.
 *  6) قاعدة قائمة بلا العمود (قبل الـ migration): السلوك القديم كما هو (لا طلب ولا حفظ ولا خطأ) والبيانات سليمة؛
 *     وبعد تطبيق الـ migration يدويًا يظهر الدعم وتبقى السجلات القديمة (طولها null).
 *
 *   node test/pump-length.test.js
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

const PORT = 8902, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'pump-len-pw-1';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-pl-'));
  try {
    await start(dir);
    const pwPath = path.join(dir, 'كلمات-المرور-الأولية.txt');
    for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
    const pwFile = fs.readFileSync(pwPath, 'utf8');
    const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];
    let admin = await login('admin', ADMIN_PW);
    const manager = await login('مدير_الاليات', pwOf('مدير_الاليات'));
    const gate = await login('بوابة', pwOf('بوابة'));
    const mk = (cookie, o) => call(cookie, 'POST', '/api/vehicles', Object.assign({ baselineKm: 10 }, o));
    const state = async c => (await call(c, 'GET', '/api/state')).data;

    console.log('— قاعدة جديدة');
    await check('الدعم معلَن في /api/state', async () => {
      assert.equal((await state(admin)).vehiclePumpLengthSupported, true);
    });

    console.log('— مضخة: التحقق');
    await check('طول مفقود → 400', async () => {
      const r = await mk(admin, { name: 'مضخة 1', type: 'pump' });
      assert.equal(r.status, 400, r.text);
    });
    for (const bad of ['', '   ', 'abc', '12abc', 'ثلاثون', '1e3', '-5', -5, 0, '0', '0.0', null, 1001, '1e9', {}, [], true]) {
      await check('طول غير صالح مرفوض: ' + JSON.stringify(bad), async () => {
        const r = await mk(admin, { name: 'مضخة سيئة', type: 'pump', pumpLengthM: bad });
        assert.equal(r.status, 400, r.text);
      });
    }
    await check('لا آلية تُنشأ بعد الرفض', async () => {
      assert.equal((await state(admin)).vehicles.filter(v => v.name.startsWith('مضخة')).length, 0);
    });

    console.log('— مضخة: القبول والحفظ');
    let pump36, pump42;
    await check('36.5 (رقم) يُقبل ويُحفظ', async () => {
      const r = await mk(admin, { name: 'مضخة 36', type: 'pump', pumpLengthM: 36.5 });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.vehicle.pumpLengthM, 36.5); pump36 = r.data.vehicle.id;
    });
    await check('"42" (نص رقمي) يُقبل ويُحفظ 42', async () => {
      const r = await mk(admin, { name: 'مضخة 42', type: 'pump', pumpLengthM: '42' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.vehicle.pumpLengthM, 42); pump42 = r.data.vehicle.id;
    });
    await check('القائمة تُرجع الطول المرتبط بكل آلية', async () => {
      const vs = (await state(admin)).vehicles;
      assert.equal(vs.find(v => v.id === pump36).pumpLengthM, 36.5);
      assert.equal(vs.find(v => v.id === pump42).pumpLengthM, 42);
    });

    console.log('— الأنواع الأخرى لا تتأثر');
    for (const t of ['gabbala', 'service', 'silo']) {
      await check(`${t}: بلا طول → 201 وpumpLengthM=null`, async () => {
        const r = await mk(admin, { name: 'آلية ' + t, type: t });
        assert.equal(r.status, 201, r.text);
        assert.equal(r.data.vehicle.pumpLengthM, null);
      });
      await check(`${t}: طول مُرسَل يُهمَل`, async () => {
        const r = await mk(admin, { name: 'آلية ' + t + ' 2', type: t, pumpLengthM: 55 });
        assert.equal(r.status, 201, r.text);
        assert.equal(r.data.vehicle.pumpLengthM, null);
      });
      await check(`${t}: طول غير صالح لا يمنع التسجيل`, async () => {
        const r = await mk(admin, { name: 'آلية ' + t + ' 3', type: t, pumpLengthM: 'abc' });
        assert.equal(r.status, 201, r.text);
      });
    }
    await check('حقول الآلية الأخرى (مازوت/ساعات) تُحفظ كما كانت', async () => {
      const r = await mk(admin, { name: 'مضخة كاملة', type: 'pump', pumpLengthM: 28, fuelTankQty: 120, workHoursBaseline: 300 });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.data.vehicle.fuelTankQty, 120); assert.equal(r.data.vehicle.workHoursBaseline, 300);
      assert.equal(r.data.vehicle.pumpLengthM, 28);
    });

    console.log('— التعديل');
    await check('تعديل الطول', async () => {
      const r = await call(admin, 'PUT', '/api/vehicles/' + pump36, { name: 'مضخة 36', baselineKm: 10, type: 'pump', pumpLengthM: 40.25 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.vehicle.pumpLengthM, 40.25);
    });
    await check('تعديل مضخة بلا طول → 400 والقيمة القديمة محفوظة', async () => {
      const r = await call(admin, 'PUT', '/api/vehicles/' + pump36, { name: 'مضخة 36', baselineKm: 10, type: 'pump' });
      assert.equal(r.status, 400, r.text);
      assert.equal((await state(admin)).vehicles.find(v => v.id === pump36).pumpLengthM, 40.25);
    });
    await check('تعديل بطول سالب → 400', async () => {
      const r = await call(admin, 'PUT', '/api/vehicles/' + pump36, { name: 'مضخة 36', baselineKm: 10, type: 'pump', pumpLengthM: -1 });
      assert.equal(r.status, 400, r.text);
    });
    await check('تغيير النوع بعيدًا عن مضخة يمسح الطول', async () => {
      const r = await call(admin, 'PUT', '/api/vehicles/' + pump42, { name: 'مضخة 42', baselineKm: 10, type: 'service' });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.vehicle.pumpLengthM, null);
    });
    await check('تعديل آلية غير مضخة بلا طول يعمل', async () => {
      const id = (await state(admin)).vehicles.find(v => v.name === 'آلية silo').id;
      const r = await call(admin, 'PUT', '/api/vehicles/' + id, { name: 'آلية silo', baselineKm: 11, type: 'silo' });
      assert.equal(r.status, 200, r.text);
    });
    await check('إعادة تسمية مضخة تُبقي طولها', async () => {
      const r = await call(admin, 'PUT', '/api/vehicles/' + pump36, { name: 'مضخة 36 جديدة', baselineKm: 10, type: 'pump', pumpLengthM: 40.25 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.vehicle.pumpLengthM, 40.25);
    });

    console.log('— الصلاحيات');
    await check('مدير الآليات والبوابة لا يسجّلان آلية (403)', async () => {
      assert.equal((await mk(manager, { name: 'م1', type: 'pump', pumpLengthM: 5 })).status, 403);
      assert.equal((await mk(gate, { name: 'م2', type: 'pump', pumpLengthM: 5 })).status, 403);
    });
    await check('بلا جلسة 401', async () => {
      assert.equal((await mk(null, { name: 'م3', type: 'pump', pumpLengthM: 5 })).status, 401);
    });

    console.log('— قاعدة قائمة بلا العمود (قبل الـ migration)');
    await stop();
    {
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      d.exec('ALTER TABLE vehicles DROP COLUMN pump_length_m');
      d.close();
    }
    await start(dir);
    admin = await login('admin', ADMIN_PW);
    await check('الدعم false والآليات القديمة سليمة', async () => {
      const st = await state(admin);
      assert.equal(st.vehiclePumpLengthSupported, false);
      assert.ok(st.vehicles.find(v => v.name === 'مضخة كاملة'), 'السجل القديم موجود');
      assert.equal(st.vehicles.find(v => v.name === 'مضخة كاملة').pumpLengthM, null);
    });
    await check('تسجيل مضخة بلا طول يعمل كما قبل (201) دون خطأ', async () => {
      const r = await mk(admin, { name: 'مضخة قديمة', type: 'pump' });
      assert.equal(r.status, 201, r.text); assert.equal(r.data.vehicle.pumpLengthM, null);
    });
    await check('إرسال طول لا يكسر شيئًا ولا يُحفظ', async () => {
      const r = await mk(admin, { name: 'مضخة قديمة 2', type: 'pump', pumpLengthM: 33 });
      assert.equal(r.status, 201, r.text); assert.equal(r.data.vehicle.pumpLengthM, null);
    });
    await check('التعديل يعمل كما قبل', async () => {
      const id = (await state(admin)).vehicles.find(v => v.name === 'مضخة قديمة').id;
      const r = await call(admin, 'PUT', '/api/vehicles/' + id, { name: 'مضخة قديمة', baselineKm: 99, type: 'pump', fuelTankQty: 5 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.vehicle.baselineKm, 99);
    });
    await check('الخادم لم يُضِف العمود تلقائيًا', async () => {
      await stop();
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      const has = d.prepare(`SELECT name FROM pragma_table_info('vehicles')`).all().some(c => c.name === 'pump_length_m');
      d.close();
      assert.equal(has, false);
    });

    console.log('— بعد تطبيق الـ migration يدويًا');
    {
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      d.exec('ALTER TABLE vehicles ADD COLUMN pump_length_m REAL');
      d.close();
    }
    await start(dir);
    admin = await login('admin', ADMIN_PW);
    await check('الدعم true والسجلات القديمة محفوظة بطول null', async () => {
      const st = await state(admin);
      assert.equal(st.vehiclePumpLengthSupported, true);
      assert.equal(st.vehicles.find(v => v.name === 'مضخة قديمة').pumpLengthM, null);
      assert.equal(st.vehicles.find(v => v.name === 'مضخة كاملة').fuelTankQty, 120);
    });
    await check('مضخة قديمة بلا طول: التعديل يتطلب الطول ثم يُحفظ', async () => {
      const id = (await state(admin)).vehicles.find(v => v.name === 'مضخة قديمة').id;
      assert.equal((await call(admin, 'PUT', '/api/vehicles/' + id, { name: 'مضخة قديمة', baselineKm: 99, type: 'pump' })).status, 400);
      const r = await call(admin, 'PUT', '/api/vehicles/' + id, { name: 'مضخة قديمة', baselineKm: 99, type: 'pump', pumpLengthM: 31 });
      assert.equal(r.status, 200, r.text); assert.equal(r.data.vehicle.pumpLengthM, 31);
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
