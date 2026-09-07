/**
 * config.js — إعدادات التطبيق.
 *
 * الأولوية: متغيّرات البيئة  ثم  ملف gatelog.config.json  ثم  القيم الافتراضية.
 *
 * سبب وجود ملف الإعدادات: رابط اتصال MongoDB Atlas يحتوي كلمة المرور داخله.
 * تمريره في سطر الأوامر يجعله ظاهرًا لأي مستخدم على السيرفر عبر قائمة
 * العمليات (Get-Process / Task Manager)، ووضعه في متغيّر بيئة على مستوى
 * الجهاز يجعله مقروءًا لكل الحسابات. الملف أسلم، بشرط تقييد صلاحياته:
 *
 *   icacls gatelog.config.json /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)"
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = process.env.GATE_LOG_CONFIG ||
                    path.join(__dirname, 'gatelog.config.json');

let fileConfig = {};
let configSource = 'القيم الافتراضية';

if (fs.existsSync(CONFIG_FILE)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    configSource = CONFIG_FILE;
  } catch (err) {
    console.error('');
    console.error('  ✗ ملف الإعدادات موجود لكن تعذّرت قراءته:');
    console.error('    ' + CONFIG_FILE);
    console.error('    ' + err.message);
    console.error('');
    console.error('    تحقّق من صحة صيغة JSON — الفاصلة الزائدة بعد آخر عنصر خطأ شائع.');
    console.error('');
    process.exit(1);
  }
}

function pick(envName, fileKey, fallback) {
  if (process.env[envName] !== undefined && process.env[envName] !== '') {
    return process.env[envName];
  }
  if (fileConfig[fileKey] !== undefined && fileConfig[fileKey] !== '') {
    return fileConfig[fileKey];
  }
  return fallback;
}

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test(String(v));
}

const config = {
  configSource,
  driver:     String(pick('GATE_LOG_DB',   'driver',   'mssql')).toLowerCase(),

  // MongoDB
  mongoUri:   pick('MONGODB_URI',          'mongoUri', 'mongodb://127.0.0.1:27017'),
  mongoDb:    pick('MONGODB_DB',           'mongoDb',  'gate_log'),

  // SQL Server
  mssql: {
    connectionString: pick('MSSQL_CONNECTION_STRING', 'mssqlConnectionString', ''),
    server:       pick('MSSQL_SERVER',   'mssqlServer',   '127.0.0.1'),
    port:         Number(pick('MSSQL_PORT', 'mssqlPort',  1433)),
    database:     pick('MSSQL_DATABASE', 'mssqlDatabase', 'gate_log'),
    user:         pick('MSSQL_USER',     'mssqlUser',     ''),
    password:     pick('MSSQL_PASSWORD', 'mssqlPassword', ''),
    // اسم النسخة المُسمّاة، مثل SQLEXPRESS. اتركه فارغًا للنسخة الافتراضية.
    instanceName: pick('MSSQL_INSTANCE', 'mssqlInstance', ''),
    encrypt:      bool(pick('MSSQL_ENCRYPT', 'mssqlEncrypt', undefined), true),
    // سيرفرات الشركات الداخلية تستخدم شهادة ذاتية التوقيع غالبًا.
    trustServerCertificate:
      bool(pick('MSSQL_TRUST_CERT', 'mssqlTrustServerCertificate', undefined), true)
  },

  // كلمة مرور حساب الأدمن الافتراضية — ثابتة في الكود لتبقى معروفة دائمًا
  // كخط رجوع، وقابلة للتجاوز من الإعدادات لمن يريد كلمة مختلفة.
  adminPassword: pick('ADMIN_PASSWORD', 'adminPassword', 'sald2024'),

  port:       Number(pick('PORT',          'port',     8787)),
  host:       pick('HOST',                 'host',     '0.0.0.0'),
  dataDir:    pick('GATE_LOG_DATA',        'dataDir',  path.join(__dirname, 'data')),
  windowDays: Number(pick('GATE_LOG_WINDOW_DAYS', 'windowDays', 120))
};

if (!config.mssql.instanceName) delete config.mssql.instanceName;
if (!config.mssql.connectionString) delete config.mssql.connectionString;

// هل الاتصال بقاعدة سحابية؟ يغيّر ذلك مهل الانتظار ورسائل التشخيص.
config.isCloud = /^mongodb\+srv:\/\//i.test(config.mongoUri) ||
                 /mongodb\.net/i.test(config.mongoUri);

// نسخة آمنة للعرض في السجلات — بلا كلمة المرور.
config.safeMongoUri = String(config.mongoUri).replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:****@');

config.safeMssql = config.mssql.connectionString
  ? String(config.mssql.connectionString).replace(/(Password\s*=\s*)[^;]+/i, '$1****')
  : config.mssql.server +
    (config.mssql.instanceName ? '\\' + config.mssql.instanceName : '') +
    ':' + config.mssql.port + ' → ' + config.mssql.database +
    (config.mssql.user ? '  (المستخدم ' + config.mssql.user + ')' : '');

// وصف موحّد لقاعدة البيانات المستخدمة، يظهر عند الإقلاع وعند الفشل.
config.describeDb = () =>
  config.driver === 'mssql'  ? 'SQL Server  →  ' + config.safeMssql :
  config.driver === 'mongo'  ? 'MongoDB  →  ' + config.safeMongoUri + '/' + config.mongoDb :
                               'SQLite';

module.exports = config;
