/**
 * drivers.test.js — يتحقّق أن المحرّكات الثلاثة تقدّم واجهة واحدة متطابقة.
 *
 * لا يحتاج أي قاعدة بيانات: يفحص البنية لا السلوك. الغرض منه أن يكشف فورًا
 * أي دالة نُسيت في محرّك جديد، بدل أن ينكشف ذلك عطلًا في السيرفر بعد النشر.
 *
 *   node test/drivers.test.js
 */

'use strict';

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

// الواجهة التي يعتمد عليها server.js. أي نقص هنا عطل عند التشغيل.
const REQUIRED = [
  'init', 'close', 'backupTo',
  'hashPassword', 'verifyPassword',
  'insertUser', 'getUserByUsername', 'getUser', 'listUsers', 'updateUser', 'setUserActive', 'changeUserPassword',
  'login', 'logout', 'sessionUser', 'purgeExpiredSessions',
  'checkLockout', 'noteLoginFailure', 'clearLoginFailures',
  'audit', 'listAudit',
  'listVehicles', 'listEntries', 'getEntry', 'getEntryByClientRef', 'getVehicle', 'getVehicleByName',
  'lastKmForVehicle', 'vehicleIsOut', 'countEntriesForVehicle',
  'insertEntry', 'closeEntry', 'updateEntry', 'deleteEntry',
  'insertVehicle', 'updateVehicle', 'deleteVehicle',
  'listDrivers', 'getDriverByName', 'insertDriver', 'updateDriver', 'deleteDriver',
  'insertFuelFill', 'listFuelFills', 'insertFuelSupply', 'listFuelSupply',
  'lastFuelMeterReading', 'getFuelBaseline', 'setFuelBaseline'
];

const drivers = {
  'db-sqlite': require(path.join(ROOT, 'db-sqlite.js')),
  'db-mongo':  require(path.join(ROOT, 'db-mongo.js')),
  'db-mssql':  require(path.join(ROOT, 'db-mssql.js'))
};

console.log('\n── وجود كل دوال الواجهة في كل محرّك ──');
for (const [name, drv] of Object.entries(drivers)) {
  const missing = REQUIRED.filter(fn => typeof drv[fn] !== 'function');
  ok(name + ' يوفّر الدوال الـ' + REQUIRED.length + ' كلها',
     missing.length === 0, missing.join(', '));
}

console.log('\n── لا دوال زائدة غير معلنة في الواجهة ──');
for (const [name, drv] of Object.entries(drivers)) {
  const extra = Object.keys(drv).filter(k => !REQUIRED.includes(k));
  ok(name + ' لا يصدّر شيئًا خارج الواجهة', extra.length === 0, extra.join(', '));
}

console.log('\n── تطابق عدد المعاملات (arity) بين المحرّكات ──');
const base = drivers['db-sqlite'];
for (const [name, drv] of Object.entries(drivers)) {
  if (name === 'db-sqlite') continue;
  const mismatched = REQUIRED.filter(fn => drv[fn].length !== base[fn].length)
    .map(fn => `${fn}(${base[fn].length} مقابل ${drv[fn].length})`);
  ok(name + ' يطابق db-sqlite في عدد المعاملات', mismatched.length === 0,
     mismatched.join(', '));
}

console.log('\n── تجزئة كلمات المرور متطابقة عبر المحرّكات ──');
// كلمة المرور المُجزّأة بمحرّك يجب أن تتحقّق بأي محرّك آخر، وإلا استحال
// تبديل المحرّك على قاعدة بيانات مُرحَّلة.
const PW = 'kalimat-sirr-123';
for (const [nameA, a] of Object.entries(drivers)) {
  const hash = a.hashPassword(PW);
  const crossOk = Object.entries(drivers).every(([, b]) => b.verifyPassword(PW, hash));
  const rejects = Object.entries(drivers).every(([, b]) => !b.verifyPassword('كلمة-خاطئة', hash));
  ok('تجزئة ' + nameA + ' يقبلها الجميع ويرفضون الخطأ', crossOk && rejects);
  ok('صيغة تجزئة ' + nameA + ' هي pbkdf2', /^pbkdf2\$120000\$/.test(hash), hash.slice(0, 20));
}

console.log('\n── اختيار المحرّك من الإعدادات ──');
const config = require(path.join(ROOT, 'config.js'));
// لا نؤكّد على قيمة بعينها: وجود gatelog.config.json يغيّرها بشكل مشروع.
// المهم أن القيمة الفعّالة محرّك موجود، وأن مصدرها واضح.
ok('المحرّك الفعّال معروف: ' + config.driver,
   Object.keys(drivers).map(d => d.replace('db-', '')).includes(config.driver),
   config.driver);
console.log('    المصدر: ' + config.configSource);
ok('describeDb يعمل ولا يكشف كلمة مرور',
   typeof config.describeDb() === 'string' && !/password\s*=\s*[^*]/i.test(config.describeDb()),
   config.describeDb());

console.log(`\n══ النتيجة: ${pass} ناجح، ${fail} فاشل ══\n`);
process.exit(fail ? 1 : 0);
