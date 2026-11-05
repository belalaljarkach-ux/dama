/**
 * reports.test.js — تقارير الفترة والتنبيهات (اليوم التشغيلي 03:00).
 *
 * الجزء 1: وحدات reports-core.js (دوال نقية).
 * الجزء 2: خادم حقيقي على SQLite مؤقتة، يُملأ عبر الـ API نفسه ببيانات اختبارية
 *          بتواريخ ثابتة، ثم تُفحص /api/reports/period: اليوم الحالي، يوم سابق،
 *          نطاق، حدّ 03:00، عدم التكرار، الفترة الفارغة، التحقق والصلاحيات.
 *
 *   node test/reports.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const core = require('../reports-core');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

/* ======================= الجزء 1: الوحدات ======================= */
console.log('\nاليوم التشغيلي في reports-core');
check('02:59 → اليوم السابق / 03:00 → نفس اليوم', () => {
  assert.equal(core.opDayOf('2026-03-11', '02:59', 3), '2026-03-10');
  assert.equal(core.opDayOf('2026-03-11', '03:00', 3), '2026-03-11');
});
check('عبور الشهر والسنة الكبيسة', () => {
  assert.equal(core.opDayOf('2026-03-01', '01:00', 3), '2026-02-28');
  assert.equal(core.opDayOf('2028-03-01', '00:10', 3), '2028-02-29');
  assert.equal(core.opDayOf('2027-01-01', '02:00', 3), '2026-12-31');
});
check('ساعة بداية مخصّصة (5) وصفر', () => {
  assert.equal(core.opDayOf('2026-03-11', '04:59', 5), '2026-03-10');
  assert.equal(core.opDayOf('2026-03-11', '00:00', 0), '2026-03-11');
});
check('تطابق تام مع كتلة OPDAY الفعلية في الصفحة', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = html.match(/\/\* OPDAY-BEGIN \*\/([\s\S]*?)\/\* OPDAY-END \*\//);
  const page = new Function('pad', m[1] + '; return { opDayOf, opDayOfReturn };')(n => String(n).padStart(2, '0'));
  const samples = [['2026-03-11','00:00'],['2026-03-11','02:59'],['2026-03-11','03:00'],['2026-03-01','01:00'],['2027-01-01','02:30'],['2026-03-11','23:59'],['2026-03-11','']];
  samples.forEach(([d, t]) => assert.equal(core.opDayOf(d, t, 3), page.opDayOf(d, t)));
  const e = { dateKey:'2026-03-11', departTime:'02:30', returnDate:'2026-03-11', returnTime:'04:30' };
  assert.equal(core.opDayOfReturn(e, 3), page.opDayOfReturn(e));
});
check('validatePeriod: صيغة/ترتيب/طول', () => {
  assert.equal(core.validatePeriod('2026-03-10', '2026-03-10'), null);
  assert.ok(core.validatePeriod('2026-3-10', '2026-03-10'));
  assert.ok(core.validatePeriod('2026-02-30', '2026-03-10'));
  assert.ok(core.validatePeriod('2026-03-11', '2026-03-10'));
  assert.ok(core.validatePeriod('2025-01-01', '2026-03-10'));       // > 400 يوم
});

console.log('\nإثراء الرحلات وبناء التقرير');
const V = [{ name: 'ج1', type: 'gabbala', baselineKm: 100, registeredAt: '2026-01-01T00:00:00Z' }];
const mk = (id, dateKey, dep, retDate, ret, km, customer = 'زبون') =>
  ({ id, vehicle: 'ج1', driver: 'س', customer, status: 'done', dateKey, departTime: dep, returnDate: retDate, returnTime: ret, km, loadQty: 8 });
const E1 = [mk('a', '2026-03-10', '08:00', '2026-03-10', '10:00', 140), mk('b', '2026-03-11', '02:30', '2026-03-11', '04:30', 190),
            mk('c', '2026-03-11', '09:00', '2026-03-11', '10:00', 180)];   // عدّاد أقل من السابق
const en = core.enrichTrips(E1, V, '2025-11-10');
const byId = Object.fromEntries(en.map(e => [e.id, e]));
check('المسافة من كيلومتراج التسجيل ثم من السابقة', () => { assert.equal(byId.a._distance, 40); assert.equal(byId.b._distance, 50); });
check('عدّاد أقل من السابق = مسافة غير متاحة + _chainBroken', () => { assert.equal(byId.c._distance, null); assert.equal(byId.c._chainBroken, true); });
check('المدة بالدقائق', () => assert.equal(byId.b._durationMin, 120));
check('آلية سُجّلت قبل بداية النافذة: أول رحلة بلا مرجع (لا رقم مضلِّل)', () => {
  const r = core.enrichTrips([mk('z', '2026-03-10', '08:00', '2026-03-10', '10:00', 5000)], V, '2026-02-01');
  assert.equal(r[0]._distance, null); assert.equal(r[0]._chainBroken, false);
});
check('buildPeriodReport: يوم المغادرة مقابل يوم العودة + عدم التكرار', () => {
  const dup = E1.concat([E1[0]]);                                      // سجل مكرّر عمدًا
  const r = core.buildPeriodReport({ from: '2026-03-11', to: '2026-03-11', entries: dup, fuelFills: [], vehicles: V, lookbackFrom: '2025-11-10', startHour: 3 });
  const ids = r.trips.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);                         // لا تكرار
  assert.deepEqual(r.trips.filter(t => t.opDay === '2026-03-11').map(t => t.id), ['c']);
  assert.deepEqual(r.trips.filter(t => t.returnOpDay === '2026-03-11').map(t => t.id).sort(), ['b', 'c']);
});
check('خط الأساس «حتى نهاية الفترة»: رحلة لاحقة لا تدخل متوسط يوم سابق', () => {
  const r = core.buildPeriodReport({ from: '2026-03-10', to: '2026-03-10', entries: E1, fuelFills: [], vehicles: V, lookbackFrom: '2025-11-10', startHour: 3 });
  assert.equal(r.baselines['زبون'].nT, 2);                              // a و b فقط (b يوم 03-10 تشغيليًا)
});
check('تعبئات المازوت تُفرز بيوم تشغيلي (01:00 → اليوم السابق)', () => {
  const f = [{ id: 'f1', vehicle: 'ج1', dateKey: '2026-03-11', time: '01:00', qty: 5 }, { id: 'f2', vehicle: 'ج1', dateKey: '2026-03-11', time: '03:00', qty: 7 }];
  const r = core.buildPeriodReport({ from: '2026-03-10', to: '2026-03-10', entries: [], fuelFills: f, vehicles: V, lookbackFrom: '2025-11-10', startHour: 3 });
  assert.deepEqual(r.fuelFills.map(x => x.id), ['f1']);
});

/* ======================= الجزء 2: الخادم ======================= */
const PORT = 8894, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'reports-test-pw-1';
async function login(user, pw) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
  if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ cookie }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* غير JSON */ }
  if (r.status >= 400 && !call.allowFail) throw new Error(`${method} ${url} → ${r.status} ${text.slice(0, 120)}`);
  return { status: r.status, data };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-reports-'));
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
    const admin = await login('admin', ADMIN_PW);
    const gate = await login('بوابة', pwOf('بوابة'));
    const mgr = await login('مدير_الاليات', pwOf('مدير_الاليات'));
    const fuel = await login('المازوت', pwOf('المازوت'));

    for (const [name, type] of [['جبالة 1', 'gabbala'], ['جبالة 2', 'gabbala'], ['مضخة 1', 'pump']])
      await call(admin, 'POST', '/api/vehicles', { name, baselineKm: 0, type });
    const km = {};
    async function trip(vehicle, customer, dateKey, dep, retDate, ret, kmv) {
      const b = { vehicle, driver: 'سائق ' + vehicle, customer, dateKey, departTime: dep };
      if (vehicle.startsWith('جبالة')) b.loadQty = 8;
      if (vehicle.startsWith('مضخة')) { b.technicianName = 'فني'; b.technicianAssistant = 'مساعد'; }
      const { data } = await call(gate, 'POST', '/api/entries', b);
      if (ret) { km[vehicle] = kmv; await call(gate, 'POST', `/api/entries/${data.entry.id}/return`, { returnDate: retDate, returnTime: ret, km: kmv }); }
      return data.entry;
    }
    // الأيام التشغيلية: 03-10 / 03-11 / 03-12
    const t1 = await trip('جبالة 1', 'زبون أ', '2026-03-10', '08:00', '2026-03-10', '10:00', 40);   // 120د
    const t2 = await trip('جبالة 2', 'زبون أ', '2026-03-10', '08:00', '2026-03-10', '10:00', 40);   // 120د
    const t3 = await trip('جبالة 1', 'زبون أ', '2026-03-11', '02:30', '2026-03-11', '04:30', 80);   // يوم مغادرة 03-10، يوم عودة 03-11
    const t4 = await trip('جبالة 2', 'زبون أ', '2026-03-11', '08:00', '2026-03-11', '18:00', 80);   // 600د ← تنبيه وقت
    const t5 = await trip('مضخة 1', 'زبون ب', '2026-03-12', '09:00', '2026-03-12', '10:00', 30);
    await call(fuel, 'POST', '/api/fuel/fills', { vehicle: 'جبالة 1', km: 80, qty: 50, tank: 'tank1', dateKey: '2026-03-11', time: '01:00' });   // يوم 03-10
    await call(fuel, 'POST', '/api/fuel/fills', { vehicle: 'جبالة 1', km: 90, qty: 30, tank: 'tank1', dateKey: '2026-03-11', time: '09:00' });   // يوم 03-11

    const rep = async (qs, cookie = admin) => (await call(cookie, 'GET', '/api/reports/period' + qs)).data;
    const byDepart = (r, d) => r.trips.filter(t => t.opDay === d).map(t => t.id);

    console.log('\nتحميل يوم سابق (03-10)');
    const r10 = await rep('?from=2026-03-10&to=2026-03-10');
    await checkAsync('رحلات يوم المغادرة 03-10 = t1,t2,t3 (t3 غادرت 02:30 فتتبع اليوم السابق)', async () =>
      assert.deepEqual(byDepart(r10, '2026-03-10').sort(), [t1.id, t2.id, t3.id].sort()));
    await checkAsync('t4 وt5 غير موجودتين في فترة 03-10', async () => {
      const ids = r10.trips.map(t => t.id); assert.ok(!ids.includes(t4.id) && !ids.includes(t5.id)); });
    await checkAsync('t3 تُعاد أيضًا لأن عودتها 03-11 لا 03-10 → ليست ضمن تنبيهات 03-10', async () =>
      assert.equal(r10.trips.find(t => t.id === t3.id).returnOpDay, '2026-03-11'));
    await checkAsync('خط الأساس لـ«زبون أ» حتى 03-10 فقط: 3 رحلات متوسطها 120', async () => {
      const b = r10.baselines['زبون أ']; assert.equal(b.nT, 3); assert.equal(Math.round(b.avgT), 120); });
    await checkAsync('تعبئة 01:00 تتبع 03-10 وتعبئة 09:00 لا', async () => {
      assert.equal(r10.fuelFills.length, 1); assert.equal(r10.fuelFills[0].qty, 50); });

    console.log('\nيوم 03-11 والتنبيه');
    const r11 = await rep('?from=2026-03-11&to=2026-03-11');
    await checkAsync('رحلات 03-11 بيوم المغادرة = t4 فقط', async () => assert.deepEqual(byDepart(r11, '2026-03-11'), [t4.id]));
    await checkAsync('رحلات يوم عودتها 03-11 = t3,t4', async () =>
      assert.deepEqual(r11.trips.filter(t => t.returnOpDay === '2026-03-11').map(t => t.id).sort(), [t3.id, t4.id].sort()));
    await checkAsync('خط الأساس يشمل رحلات الأيام السابقة (4 رحلات، متوسط 240) رغم تحميل يوم واحد', async () => {
      const b = r11.baselines['زبون أ']; assert.equal(b.nT, 4); assert.equal(Math.round(b.avgT), 240); });
    await checkAsync('t4 تتجاوز المتوسط بأكثر من 20% (600 > 288) و t3 لا تتجاوز', async () => {
      const b = r11.baselines['زبون أ']; const lim = b.avgT * 1.2;
      assert.ok(r11.trips.find(t => t.id === t4.id)._durationMin > lim);
      assert.ok(!(r11.trips.find(t => t.id === t3.id)._durationMin > lim)); });
    await checkAsync('المسافة: t3=40 و t4=40 من السلسلة', async () => {
      assert.equal(r11.trips.find(t => t.id === t3.id)._distance, 40);
      assert.equal(r11.trips.find(t => t.id === t4.id)._distance, 40); });

    console.log('\nنطاق من–إلى وعدم التكرار');
    const rr = await rep('?from=2026-03-10&to=2026-03-12');
    await checkAsync('5 رحلات بمعرّفات فريدة، ومجموع الرحلات بيوم المغادرة = 5 (لا ضياع ولا عدّ مزدوج)', async () => {
      const ids = rr.trips.map(t => t.id); assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
      const perDay = ['2026-03-10', '2026-03-11', '2026-03-12'].map(d => byDepart(rr, d).length);
      assert.deepEqual(perDay, [3, 1, 1]); });
    await checkAsync('تعبئتان ضمن النطاق', async () => assert.equal(rr.fuelFills.length, 2));
    await checkAsync('الفترة الفارغة: لا رحلات ولا خط أساس', async () => {
      const e = await rep('?from=2026-03-20&to=2026-03-20');
      assert.equal(e.trips.length, 0); assert.deepEqual(e.baselines, {}); assert.equal(e.fuelFills.length, 0); });

    console.log('\nاليوم الحالي (الافتراضي)');
    const today = core.currentOpDay(new Date(), 3);
    const tToday = await trip('مضخة 1', 'زبون اليوم', today, '12:00', null, null, null);
    const todayRep = await rep('');
    await checkAsync('بلا معاملات = اليوم التشغيلي الحالي من الخادم', async () => {
      assert.equal(todayRep.from, today); assert.equal(todayRep.to, today); assert.equal(todayRep.today, today); });
    await checkAsync('رحلة اليوم المفتوحة (لم تعد) لا تظهر في التقارير المكتملة', async () => assert.equal(todayRep.trips.length, 0));
    await checkAsync('أيام سابقة لا تتسرّب إلى «اليوم»', async () => assert.ok(!todayRep.trips.some(t => t.dateKey === '2026-03-10')));
    await call(gate, 'POST', `/api/entries/${tToday.id}/return`, { returnDate: today, returnTime: '13:00', km: 31 });
    await checkAsync('بعد تسجيل العودة تظهر رحلة اليوم فورًا', async () => {
      const r = await rep(''); assert.deepEqual(r.trips.map(t => t.id), [tToday.id]); });

    console.log('\nالتحقق والصلاحيات');
    call.allowFail = true;
    await checkAsync('البوابة ممنوعة (403)', async () => assert.equal((await call(gate, 'GET', '/api/reports/period')).status, 403));
    await checkAsync('المازوت ممنوع (403)', async () => assert.equal((await call(fuel, 'GET', '/api/reports/period')).status, 403));
    await checkAsync('بلا جلسة (401)', async () => assert.equal((await call('', 'GET', '/api/reports/period')).status, 401));
    await checkAsync('مدير الآليات مسموح (200)', async () => assert.equal((await call(mgr, 'GET', '/api/reports/period?from=2026-03-10&to=2026-03-10')).status, 200));
    await checkAsync('من بعد إلى → 400', async () => assert.equal((await call(admin, 'GET', '/api/reports/period?from=2026-03-12&to=2026-03-10')).status, 400));
    await checkAsync('تاريخ غير صالح → 400', async () => assert.equal((await call(admin, 'GET', '/api/reports/period?from=abc&to=2026-03-10')).status, 400));
    await checkAsync('فترة أطول من 400 يوم → 400', async () => assert.equal((await call(admin, 'GET', '/api/reports/period?from=2024-01-01&to=2026-03-10')).status, 400));
    call.allowFail = false;
    await checkAsync('القراءة فقط: عدد العمليات في /api/state لم يتغيّر بعد الاستعلامات', async () => {
      const st = (await call(admin, 'GET', '/api/state?days=0')).data; assert.equal(st.entries.length, 6); });
  } catch (e) { fail++; console.log('  ✗ فشل الإعداد: ' + e.message); }
  finally { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  console.log(`\nالنتيجة: ${pass} نجح، ${fail} فشل\n`);
  process.exit(fail ? 1 : 0);
})();
