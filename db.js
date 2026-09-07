/**
 * db.js — يختار محرّك قاعدة البيانات.
 *
 * المحرّكات الثلاثة تقدّم نفس الواجهة بالضبط، والخادم ينتظر (await) كل
 * النداءات، فلا يعرف — ولا يحتاج أن يعرف — أيّها يعمل تحته.
 *
 *   mssql   (الافتراضي)  →  db-mssql.js   — SQL Server على سيرفر الشركة
 *   mongo                →  db-mongo.js   — MongoDB محلية أو Atlas
 *   sqlite               →  db-sqlite.js  — ملف واحد، بلا خادم قواعد بيانات
 *
 * يُضبط من "driver" في gatelog.config.json أو من متغيّر البيئة GATE_LOG_DB.
 */

'use strict';

const config = require('./config');

const DRIVERS = {
  mssql:  './db-mssql',
  mongo:  './db-mongo',
  sqlite: './db-sqlite'
};

const driverName = config.driver;

if (!DRIVERS[driverName]) {
  console.error(`\n  ✗ قيمة driver غير معروفة: «${driverName}»`);
  console.error('    القيم المقبولة: ' + Object.keys(DRIVERS).join(' أو '));
  console.error('    المصدر: ' + config.configSource + '\n');
  process.exit(1);
}

const driver = require(DRIVERS[driverName]);

/**
 * خيارات الإقلاع الخاصة بكل محرّك، مجمّعة هنا حتى يبقى نداء init في
 * الخادم سطرًا واحدًا مهما تعدّدت المحرّكات.
 */
function initOptions(extra) {
  const base = Object.assign({ dataDir: config.dataDir, adminPassword: config.adminPassword }, extra || {});
  if (driverName === 'mongo') {
    return Object.assign(base, {
      uri: config.mongoUri, dbName: config.mongoDb, isCloud: config.isCloud
    });
  }
  if (driverName === 'mssql') {
    return Object.assign(base, config.mssql);
  }
  return base;
}

module.exports = Object.assign({ driverName, initOptions }, driver);
