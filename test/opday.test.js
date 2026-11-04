/**
 * opday.test.js — اختبار اليوم التشغيلي (03:00) وعدّادات لوحة التحكم.
 *
 * لا يحتاج قاعدة بيانات ولا خادمًا للجزء الأول: يستخرج كتلة OPDAY من
 * public/index.html نفسها (الكود الذي يعمل فعلًا في المتصفح) وينفّذها هنا.
 * الجزء الثاني يشغّل الخادم على SQLite مؤقتة (لا يلمس قاعدة الإنتاج) ليتحقّق
 * أن /api/state يرسل dayStartHour من الإعدادات.
 *
 *   node test/opday.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

/* ---------- تحميل الكود الحقيقي من الصفحة ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const m = html.match(/\/\* OPDAY-BEGIN \*\/([\s\S]*?)\/\* OPDAY-END \*\//);
if (!m) { console.error('كتلة OPDAY غير موجودة في index.html'); process.exit(1); }
const api = new Function('pad',
  m[1] + '; return { opDayOf, currentOpDay, opDayOfEntry, opDayOfReturn, computeDashboardStats, shiftDateKey,' +
         ' setHour: h => { DAY_START_HOUR = h; } };')(n => String(n).padStart(2, '0'));
const { opDayOf, currentOpDay, opDayOfEntry, opDayOfReturn, computeDashboardStats, shiftDateKey, setHour } = api;

const at = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);

console.log('\nحدود اليوم التشغيلي (03:00)');
check('02:59 ينتمي لليوم السابق', () => assert.equal(opDayOf('2026-11-02', '02:59'), '2026-11-01'));
check('03:00 يبدأ يومًا جديدًا', () => assert.equal(opDayOf('2026-11-02', '03:00'), '2026-11-02'));
check('00:00 ينتمي لليوم السابق', () => assert.equal(opDayOf('2026-11-02', '00:00'), '2026-11-01'));
check('23:59 ينتمي لنفس اليوم', () => assert.equal(opDayOf('2026-11-02', '23:59'), '2026-11-02'));
check('عبور الشهر: 1 مارس 01:00 → 28 فبراير', () => assert.equal(opDayOf('2026-03-01', '01:00'), '2026-02-28'));
check('سنة كبيسة: 1 مارس 2028 00:10 → 29 فبراير', () => assert.equal(opDayOf('2028-03-01', '00:10'), '2028-02-29'));
check('عبور السنة: 1 يناير 02:00 → 31 ديسمبر', () => assert.equal(opDayOf('2027-01-01', '02:00'), '2026-12-31'));
check('بلا وقت: يبقى التاريخ كما هو', () => assert.equal(opDayOf('2026-11-02', ''), '2026-11-02'));
check('currentOpDay عند 02:59:59 = أمس', () => assert.equal(currentOpDay(at(2026, 11, 2, 2, 59, 59)), '2026-11-01'));
check('currentOpDay عند 03:00:00 = اليوم', () => assert.equal(currentOpDay(at(2026, 11, 2, 3, 0, 0)), '2026-11-02'));
check('currentOpDay عند 23:59:59 = اليوم', () => assert.equal(currentOpDay(at(2026, 11, 2, 23, 59, 59)), '2026-11-02'));

/* ---------- بيانات اختبار ---------- */
const vehicles = [
  { name: 'جبالة 1', type: 'gabbala' }, { name: 'جبالة 2', type: 'gabbala' },
  { name: 'خدمة 1', type: 'service' },
  { name: 'سيلو 1', type: 'silo' },
  { name: 'مضخة 1', type: 'pump' }, { name: 'مضخة 2', type: 'pump' },
  { name: 'قديمة 9', type: null }                     // آلية قديمة بلا نوع
];
const E = (id, vehicle, status, dateKey, departTime, extra = {}) =>
  Object.assign({ id, vehicle, driver: 'س' + id, customer: 'ز' + id, status, dateKey, departTime }, extra);

console.log('\nإعادة الاحتساب عند 03:00 وبقاء السجلات');
const hist = [
  E('a1', 'جبالة 1', 'done', '2026-11-01', '09:00', { returnDate: '2026-11-01', returnTime: '12:00', customer: 'زبون أ' }),
  E('a2', 'جبالة 2', 'done', '2026-11-01', '10:00', { returnDate: '2026-11-01', returnTime: '13:00', customer: 'زبون ب' }),
  E('a3', 'خدمة 1', 'done', '2026-11-02', '01:30', { returnDate: '2026-11-02', returnTime: '02:10', customer: 'زبون أ' }), // يوم 11-01
  E('a4', 'جبالة 1', 'done', '2026-11-02', '03:05', { returnDate: '2026-11-02', returnTime: '06:00', customer: 'زبون ج' }), // يوم 11-02
  E('a5', 'سيلو 1', 'done', '2026-10-15', '08:00', { returnDate: '2026-10-15', returnTime: '10:00', customer: 'زبون قديم' })
];
const frozen = JSON.parse(JSON.stringify(hist)); hist.forEach(Object.freeze);
const alerts = new Set(['a1', 'a3', 'a4', 'a5']);
const s0259 = computeDashboardStats(hist, vehicles, alerts, at(2026, 11, 2, 2, 59, 59));
const s0300 = computeDashboardStats(hist, vehicles, alerts, at(2026, 11, 2, 3, 0, 0));
check('02:59:59 → اليوم التشغيلي 11-01', () => assert.equal(s0259.day, '2026-11-01'));
check('عمليات 11-01 = 3 (a1,a2,a3) قبل الإغلاق', () => assert.equal(s0259.tripsToday, 3));
check('03:00:00 → اليوم التشغيلي 11-02 وعمليات اليوم = 1 (a4)', () => { assert.equal(s0300.day, '2026-11-02'); assert.equal(s0300.tripsToday, 1); });
check('عداد الزبائن اليومي يتصفّر ولا يجمع الأمس', () => { assert.equal(s0259.customersToday, 2); assert.equal(s0300.customersToday, 1); });
check('التنبيهات اليومية لا تجمع الأيام السابقة', () => { assert.equal(s0300.alertsToday, 1); /* a4 فقط */ });
check('السجلات التاريخية لم تتغيّر إطلاقًا بعد الإغلاق', () => assert.deepEqual(JSON.parse(JSON.stringify(hist)), frozen));
check('مجموع عمليات الأيام = عدد السجلات (لا ضياع ولا تكرار)', () => {
  const days = {}; hist.forEach(e => { const d = opDayOfEntry(e); days[d] = (days[d] || 0) + 1; });
  assert.equal(Object.values(days).reduce((a, b) => a + b, 0), hist.length);
});

console.log('\nرحلة تعبر الساعة 03:00');
const cross = [E('x1', 'جبالة 1', 'done', '2026-11-02', '02:00', { returnDate: '2026-11-02', returnTime: '04:30' })];
const aX = new Set(['x1']);
check('تُحتسب عملية في يوم المغادرة (11-01) فقط', () => {
  assert.equal(computeDashboardStats(cross, vehicles, aX, at(2026, 11, 1, 20)).tripsToday, 1);
  assert.equal(computeDashboardStats(cross, vehicles, aX, at(2026, 11, 2, 10)).tripsToday, 0);
});
check('ويُحتسب تنبيهها في يوم العودة (11-02) فقط — مرة واحدة', () => {
  assert.equal(computeDashboardStats(cross, vehicles, aX, at(2026, 11, 1, 20)).alertsToday, 0);
  assert.equal(computeDashboardStats(cross, vehicles, aX, at(2026, 11, 2, 10)).alertsToday, 1);
});
check('رحلة مفتوحة عبرت 03:00 تبقى في «الخارج الآن» ولا تُحتسب عملية اليوم الجديد', () => {
  const open = [E('o1', 'مضخة 1', 'out', '2026-11-02', '01:00')];
  const s = computeDashboardStats(open, vehicles, new Set(), at(2026, 11, 2, 9));
  assert.equal(s.outTotal, 1); assert.equal(s.tripsToday, 0);
});
check('opDayOfReturn: بلا عودة ← يوم المغادرة', () => assert.equal(opDayOfReturn(E('z', 'v', 'out', '2026-11-02', '01:00')), '2026-11-01'));

console.log('\nأنواع الآليات في الخارج الآن');
const outs = [
  E('g1', 'جبالة 1', 'out', '2026-11-02', '08:00'),
  E('g2', 'جبالة 2', 'out', '2026-10-30', '08:00'),           // خرجت قبل أيام ولم تعد
  E('s1', 'خدمة 1', 'out', '2026-11-02', '08:10'),
  E('si1', 'سيلو 1', 'out', '2026-11-02', '08:20'),
  E('p1', 'مضخة 1', 'out', '2026-11-02', '08:30'),
  E('u1', 'قديمة 9', 'out', '2026-11-02', '08:40'),            // بلا نوع
  E('d1', ' جبالة 1 ', 'out', '2026-11-02', '08:50'),          // سجل مكرّر لنفس الآلية (مسافة زائدة)
  E('d2', 'مضخة 2', 'done', '2026-11-02', '07:00', { returnTime: '08:00', returnDate: '2026-11-02' })
];
const so = computeDashboardStats(outs, vehicles, new Set(), at(2026, 11, 2, 12));
check('جبالات = 2 (g1,g2) رغم التكرار', () => assert.equal(so.outByType.gabbala, 2));
check('سيارات الخدمة = 1', () => assert.equal(so.outByType.service, 1));
check('سيلوهات = 1', () => assert.equal(so.outByType.silo, 1));
check('مضخات = 1 (المضخة العائدة لا تُحتسب)', () => assert.equal(so.outByType.pump, 1));
check('آلية بلا نوع = 1 في «other» ولا يُفترض لها نوع', () => assert.equal(so.outByType.other, 1));
check('الإجمالي = 6 = مجموع الأنواع + بلا نوع', () => {
  assert.equal(so.outTotal, 6);
  assert.equal(Object.values(so.outByType).reduce((a, b) => a + b, 0), so.outTotal);
});
check('المسجّل لكل نوع صحيح (للعرض x/y)', () => {
  assert.deepEqual(so.registeredByType, { gabbala: 2, service: 1, silo: 1, pump: 2, other: 1 });
});
check('الخروج يزيد العدد فورًا والعودة تُنقصه', () => {
  const before = computeDashboardStats(outs, vehicles, new Set(), at(2026, 11, 2, 12));
  const withNew = outs.concat([E('n1', 'مضخة 2', 'out', '2026-11-02', '11:00')]);
  const afterOut = computeDashboardStats(withNew, vehicles, new Set(), at(2026, 11, 2, 12));
  assert.equal(afterOut.outTotal, before.outTotal + 1); assert.equal(afterOut.outByType.pump, 2);
  const closed = withNew.map(e => e.id === 'n1' ? Object.assign({}, e, { status: 'done' }) : e);
  assert.equal(computeDashboardStats(closed, vehicles, new Set(), at(2026, 11, 2, 12)).outTotal, before.outTotal);
});

console.log('\nإعداد ساعة البداية');
check('DAY_START_HOUR=5: 04:59 ينتمي للأمس و05:00 لليوم', () => {
  setHour(5);
  assert.equal(opDayOf('2026-11-02', '04:59'), '2026-11-01');
  assert.equal(opDayOf('2026-11-02', '05:00'), '2026-11-02');
  setHour(0);
  assert.equal(opDayOf('2026-11-02', '00:00'), '2026-11-02');     // 0 = اليوم الميلادي العادي
  setHour(3);
});

/* ---------- الجزء الثاني: الخادم ---------- */
function runServer(port, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-opday-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dataDir,
    GATE_LOG_CONFIG: path.join(dataDir, 'none.json'), ADMIN_PASSWORD: 'opday-test-pw-1'
  }, extraEnv || {});
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill(); reject(new Error('الخادم لم يبدأ')); }, 15000);
    child.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); resolve({ child, dataDir }); } });
    child.on('exit', c => { clearTimeout(t); reject(new Error('الخادم توقّف برمز ' + c)); });
  });
}
async function stateOf(port) {
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'opday-test-pw-1' })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie } });
  return res.json();
}

(async () => {
  console.log('\nالخادم: /api/state يرسل dayStartHour');
  for (const [port, env, expected] of [[8897, {}, 3], [8896, { GATE_LOG_DAY_START_HOUR: '5' }, 5], [8895, { GATE_LOG_DAY_START_HOUR: '99' }, 3]]) {
    let srv;
    try {
      srv = await runServer(port, env);
      await checkAsync(`GATE_LOG_DAY_START_HOUR=${env.GATE_LOG_DAY_START_HOUR || '(افتراضي)'} → ${expected}`, async () => {
        const st = await stateOf(port);
        assert.equal(st.dayStartHour, expected);
        assert.ok(Array.isArray(st.entries) && Array.isArray(st.vehicles));   // باقي الحالة سليم
      });
    } catch (e) { fail++; console.log('  ✗ تعذّر تشغيل الخادم: ' + e.message); }
    finally { if (srv) { srv.child.kill(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); } }
  }
  console.log(`\nالنتيجة: ${pass} نجح، ${fail} فشل\n`);
  process.exit(fail ? 1 : 0);
})();
