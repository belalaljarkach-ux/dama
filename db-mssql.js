/**
 * db-mssql.js — محرّك Microsoft SQL Server لتطبيق سجل بوابة المجبل.
 *
 * يقدّم نفس واجهة db-mongo.js و db-sqlite.js بالضبط.
 *
 * ثلاثة قرارات تقنية تستحق الشرح:
 *
 * 1) كل الأعمدة النصية من نوع NVARCHAR لا VARCHAR. VARCHAR يخزّن بترميز
 *    الصفحة الافتراضية للخادم، وعليها تتحوّل الأسماء العربية إلى «؟؟؟؟»
 *    إن لم تكن ترتيبية الخادم عربية. NVARCHAR يخزّن Unicode دائمًا، فيعمل
 *    مهما كانت إعدادات الخادم. وكل معامل يُمرَّر بنوع NVarChar صراحةً.
 *
 * 2) التواريخ والأوقات تُخزَّن نصوصًا (NVARCHAR) لا DATE/TIME. هذا مقصود:
 *    استخدام أنواع زمنية يُعيد مشكلة انزياح التوقيت التي أفسدت حسابات المدة
 *    في نسخة Google Sheets، لأن المحرّك يفسّرها حسب منطقة زمنية.
 *
 * 3) كل الاستعلامات مُعامَلة (parameterized). لا يُبنى أي استعلام بدمج نصوص،
 *    فلا مجال لحقن SQL حتى لو كتب الحارس اسم آلية فيه علامات اقتباس.
 */

'use strict';

const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

let sql;
try {
  sql = require('mssql');
} catch (err) {
  console.error('');
  console.error('  ✗ حزمة mssql غير مثبّتة.');
  console.error('    ثبّتها بالأمر:  npm install mssql');
  console.error('');
  process.exit(1);
}

const SESSION_HOURS = 12;
const LOCKOUT_TRIES = 8;
const LOCKOUT_MIN   = 10;

// أرقام أخطاء SQL Server لخرق القيود الفريدة.
const ERR_DUPLICATE = [2601, 2627];

let pool = null;
let heartbeatWarned = false;

/* -------------------------------------------------------- أدوات الاستعلام */

const NV  = n => sql.NVarChar(n);
const FLT = sql.Float;

/**
 * تنفيذ استعلام مُعامَل. `params` مصفوفة [اسم, نوع, قيمة].
 * كل نداءات هذا الملف تمر من هنا — لا استعلام مبنيّ بدمج نصوص.
 */
async function q(text, params, tx) {
  const req = tx ? new sql.Request(tx) : pool.request();
  (params || []).forEach(([name, type, value]) => req.input(name, type, value));
  return req.query(text);
}

async function one(text, params, tx) {
  const r = await q(text, params, tx);
  return r.recordset && r.recordset.length ? r.recordset[0] : null;
}

async function all(text, params, tx) {
  const r = await q(text, params, tx);
  return r.recordset || [];
}

function isDuplicateError(err) {
  return ERR_DUPLICATE.includes(err && err.number) ||
         (err && err.originalError && ERR_DUPLICATE.includes(err.originalError.number));
}

/* --------------------------------------------------- تشخيص أخطاء الاتصال */

function explainConnectionError(err) {
  const msg = String(err && err.message || err);
  const num = err && (err.number || (err.originalError && err.originalError.number));
  // tedious يغلّف أخطاء الشبكة برمز ESOCKET ورسالة لا تحتوي ECONNREFUSED،
  // فنعتمد على الرمز لا على نص الرسالة وحده.
  const code = err && (err.code || (err.originalError && err.originalError.code));

  if (/Login failed/i.test(msg) || num === 18456) {
    return {
      cause: 'فشل تسجيل الدخول إلى SQL Server — المستخدم أو كلمة المرور غير صحيحة.',
      fix: ['تأكّد من اسم المستخدم وكلمة المرور في ملف الإعدادات.',
            'تأكّد أن الخادم يقبل «SQL Server Authentication» لا Windows فقط:',
            'خصائص الخادم في SSMS → Security → SQL Server and Windows Authentication mode.']
    };
  }
  if (/Cannot open database/i.test(msg) || num === 4060) {
    return {
      cause: 'قاعدة البيانات غير موجودة، أو المستخدم لا يملك صلاحية فتحها.',
      fix: ['اطلب من الـ IT إنشاء القاعدة ومنح المستخدم صلاحية db_owner عليها:',
            "  CREATE DATABASE gate_log;",
            "  CREATE USER gatelog_app FOR LOGIN gatelog_app;",
            "  ALTER ROLE db_owner ADD MEMBER gatelog_app;"]
    };
  }
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(msg)) {
    return {
      cause: 'تعذّر العثور على السيرفر بهذا الاسم.',
      fix: ['راجع قيمة mssqlServer في ملف الإعدادات.',
            'جرّب عنوان IP بدل الاسم للتأكد من أن المشكلة في DNS.']
    };
  }
  if (code === 'ESOCKET' || /ECONNREFUSED|Could not connect|Failed to connect/i.test(msg)) {
    return {
      cause: 'لا يوجد SQL Server يستمع على هذا العنوان والمنفذ.',
      fix: ['تأكّد من تشغيل الخدمة:  Get-Service MSSQL*',
            'فعّل بروتوكول TCP/IP — وهو **معطّل افتراضيًا في نسخة Express**:',
            '  SQL Server Configuration Manager → SQL Server Network Configuration',
            '  → Protocols → TCP/IP → Enable، ثم أعد تشغيل الخدمة.',
            'تأكّد أن جدار الحماية يسمح بالمنفذ 1433 وارِدًا على السيرفر.',
            'إن كانت النسخة مُسمّاة مثل SQLEXPRESS، اضبط mssqlInstance في الإعدادات',
            'وشغّل خدمة SQL Server Browser، أو حدّد المنفذ صراحةً في mssqlPort.']
    };
  }
  if (code === 'ETIMEOUT' || /ETIMEOUT|timed out/i.test(msg)) {
    return {
      cause: 'انتهت مهلة الاتصال بـ SQL Server.',
      fix: ['تأكّد أن جدار الحماية يسمح بالمنفذ 1433 على السيرفر.',
            'إن كانت النسخة مُسمّاة (named instance) فعّل خدمة SQL Server Browser،',
            'أو حدّد المنفذ صراحةً في mssqlPort.']
    };
  }
  if (/self.signed certificate|certificate/i.test(msg)) {
    return {
      cause: 'شهادة TLS الخاصة بالسيرفر غير موثوقة.',
      fix: ['أضف "mssqlTrustServerCertificate": true في ملف الإعدادات',
            'إن كان السيرفر داخل الشبكة المحلية بشهادة ذاتية التوقيع.']
    };
  }
  return { cause: msg, fix: [] };
}

/* ------------------------------------------------------------- الإعداد */

function buildConfig(options) {
  const o = options || {};

  // رابط اتصال جاهز إن وُجد، وإلا نبني الإعداد من الحقول المنفصلة.
  if (o.connectionString) return o.connectionString;

  return {
    server:   o.server   || '127.0.0.1',
    port:     Number(o.port || 1433),
    database: o.database || 'gate_log',
    user:     o.user,
    password: o.password,
    options: {
      // اسم النسخة المُسمّاة إن وُجد (مثل SQLEXPRESS)
      instanceName: o.instanceName || undefined,
      encrypt: o.encrypt !== undefined ? !!o.encrypt : true,
      // سيرفرات الشركات الداخلية تستخدم شهادة ذاتية التوقيع غالبًا.
      trustServerCertificate: o.trustServerCertificate !== undefined
        ? !!o.trustServerCertificate : true,
      enableArithAbort: true
    },
    pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
    connectionTimeout: 20000,
    requestTimeout: 30000
  };
}

async function init(options) {
  const cfg = buildConfig(options);

  try {
    pool = new sql.ConnectionPool(cfg);
    pool.on('error', err => {
      if (!heartbeatWarned) {
        heartbeatWarned = true;
        console.warn('  ⚠ خطأ في اتصال SQL Server: ' + String(err.message).slice(0, 120));
      }
    });
    await pool.connect();
    await pool.request().query('SELECT 1 AS ok');
  } catch (err) {
    const { cause, fix } = explainConnectionError(err);
    const e = new Error(cause);
    e.fixSteps = fix;
    throw e;
  }

  await createSchema();

  // لا يوجد نظام migration عام هنا: الجداول القديمة (sessions، audit) قد تكون
  // أُنشئت قبل إضافة نموذج المستخدمين الشخصي، فنضيف الأعمدة الناقصة يدويًا.
  // sessions و audit عمليّتان لا تحملان بيانات عمل جوهرية (الجلسات مؤقتة، والتدقيق
  // إضافي)، فالإضافة الآمنة بعمود جديد تكفي، بلا حاجة لإعادة بناء الجدول.
  await ensureColumn('sessions', 'user_id', 'user_id NVARCHAR(64) NULL');
  await ensureColumn('sessions', 'username', 'username NVARCHAR(120) NULL');
  await ensureColumn('audit', 'username', "username NVARCHAR(120) NOT NULL CONSTRAINT df_audit_username DEFAULT N'-'");
  await ensureColumn('vehicles', 'type', 'type NVARCHAR(32) NULL');
  await ensureColumn('vehicles', 'fuel_tank_qty', 'fuel_tank_qty FLOAT NULL');
  await ensureColumn('entries', 'load_qty', 'load_qty FLOAT NULL');
  await ensureColumn('vehicles', 'work_hours_baseline', 'work_hours_baseline FLOAT NULL');
  await ensureColumn('entries', 'technician_name', 'technician_name NVARCHAR(200) NULL');
  await ensureColumn('entries', 'technician_assistant', 'technician_assistant NVARCHAR(200) NULL');
  await ensureColumn('entries', 'manual_pour', 'manual_pour BIT NULL');

  // 3 خزانات مازوت ثابتة (tank1/tank2/tank3) بدل خزان واحد — كل تعبئة آلية أو
  // تعبئة خزان تحدَّد بخزانها؛ السجلّات القديمة تُنسَب افتراضيًا لأول خزان.
  // عدّاد الكازية (dispenser_meter) عدّاد تراكمي عام للمحطة كلها، منفصل عن
  // كمية التعبئة اليدوية، يُستخدَم للتصالح لاحقًا فقط.
  await ensureColumn('fuel_fills', 'tank', "tank NVARCHAR(16) NOT NULL CONSTRAINT df_fuel_fills_tank DEFAULT N'tank1'");
  await ensureColumn('fuel_fills', 'dispenser_meter', 'dispenser_meter FLOAT NULL');
  await ensureColumn('fuel_supply', 'tank', "tank NVARCHAR(16) NOT NULL CONSTRAINT df_fuel_supply_tank DEFAULT N'tank1'");

  // مفاتيح تعريف لكل نماذج الإدخال — تسمح بإعادة الإرسال الآمنة بعد انقطاع
  // الشبكة (نفس مبدأ client_ref في entries) لشاشات الآليات والسائقين والمازوت.
  await ensureColumn('vehicles', 'client_ref', 'client_ref NVARCHAR(64) NULL');
  await ensureColumn('drivers', 'client_ref', 'client_ref NVARCHAR(64) NULL');
  await ensureColumn('fuel_fills', 'client_ref', 'client_ref NVARCHAR(64) NULL');
  await ensureColumn('fuel_supply', 'client_ref', 'client_ref NVARCHAR(64) NULL');
  await pool.request().query(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_vehicles_client_ref' AND object_id=OBJECT_ID('dbo.vehicles'))
     CREATE UNIQUE INDEX ux_vehicles_client_ref ON dbo.vehicles(client_ref) WHERE client_ref IS NOT NULL`);
  await pool.request().query(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_drivers_client_ref' AND object_id=OBJECT_ID('dbo.drivers'))
     CREATE UNIQUE INDEX ux_drivers_client_ref ON dbo.drivers(client_ref) WHERE client_ref IS NOT NULL`);
  await pool.request().query(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_fuel_fills_client_ref' AND object_id=OBJECT_ID('dbo.fuel_fills'))
     CREATE UNIQUE INDEX ux_fuel_fills_client_ref ON dbo.fuel_fills(client_ref) WHERE client_ref IS NOT NULL`);
  await pool.request().query(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_fuel_supply_client_ref' AND object_id=OBJECT_ID('dbo.fuel_supply'))
     CREATE UNIQUE INDEX ux_fuel_supply_client_ref ON dbo.fuel_supply(client_ref) WHERE client_ref IS NOT NULL`);

  const initialPasswords = await seedUsers(options && options.adminPassword);
  const dbName = (typeof cfg === 'string') ? '(من رابط الاتصال)' : cfg.database;
  const server = (typeof cfg === 'string') ? '(من رابط الاتصال)'
                : cfg.server + (cfg.options.instanceName ? '\\' + cfg.options.instanceName : '') + ':' + cfg.port;
  return { location: server + ' → ' + dbName, initialPasswords };
}

async function createSchema() {
  // كل عبارة على حدة: SQL Server يرفض CREATE TABLE مع عبارات أخرى في دفعة
  // واحدة دون GO، و batch واحد هنا أوضح للتشخيص عند الفشل.
  const statements = [
    `IF OBJECT_ID('dbo.vehicles','U') IS NULL
     CREATE TABLE dbo.vehicles (
       id            NVARCHAR(64)  NOT NULL PRIMARY KEY,
       name          NVARCHAR(120) NOT NULL,
       baseline_km   FLOAT         NOT NULL,
       registered_at NVARCHAR(40)  NOT NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_vehicles_name' AND object_id=OBJECT_ID('dbo.vehicles'))
     CREATE UNIQUE INDEX ux_vehicles_name ON dbo.vehicles(name)`,

    `IF OBJECT_ID('dbo.entries','U') IS NULL
     CREATE TABLE dbo.entries (
       id          NVARCHAR(64)  NOT NULL PRIMARY KEY,
       date_key    NVARCHAR(10)  NOT NULL,
       vehicle     NVARCHAR(120) NOT NULL,
       driver      NVARCHAR(120) NOT NULL,
       customer    NVARCHAR(120) NOT NULL,
       depart_time NVARCHAR(5)   NOT NULL,
       notes_out   NVARCHAR(400) NOT NULL CONSTRAINT df_notes_out DEFAULT N'',
       return_date NVARCHAR(10)  NULL,
       return_time NVARCHAR(5)   NULL,
       km          FLOAT         NULL,
       notes_in    NVARCHAR(400) NOT NULL CONSTRAINT df_notes_in DEFAULT N'',
       status      NVARCHAR(8)   NOT NULL CONSTRAINT ck_status CHECK (status IN (N'out', N'done')),
       created_at  NVARCHAR(40)  NOT NULL,
       updated_at  NVARCHAR(40)  NOT NULL,
       client_ref        NVARCHAR(64) NULL,
       return_client_ref NVARCHAR(64) NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_entries_status' AND object_id=OBJECT_ID('dbo.entries'))
     CREATE INDEX ix_entries_status ON dbo.entries(status)`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_entries_date' AND object_id=OBJECT_ID('dbo.entries'))
     CREATE INDEX ix_entries_date ON dbo.entries(date_key DESC, depart_time DESC)`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_entries_vehicle' AND object_id=OBJECT_ID('dbo.entries'))
     CREATE INDEX ix_entries_vehicle ON dbo.entries(vehicle)`,

    // الفهرس المُرشَّح: رحلة مفتوحة واحدة فقط لكل آلية. هذا ما يمنع فعليًا
    // خروج آلية هي أصلًا في الخارج حين يرسل جهازان الطلب في نفس اللحظة.
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_one_open_trip' AND object_id=OBJECT_ID('dbo.entries'))
     CREATE UNIQUE INDEX ux_one_open_trip ON dbo.entries(vehicle) WHERE status = N'out'`,

    // مفتاح التعريف: يجعل إعادة إرسال الطلب بعد انقطاع الشبكة آمنة.
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_client_ref' AND object_id=OBJECT_ID('dbo.entries'))
     CREATE UNIQUE INDEX ux_client_ref ON dbo.entries(client_ref) WHERE client_ref IS NOT NULL`,

    `IF OBJECT_ID('dbo.settings','U') IS NULL
     CREATE TABLE dbo.settings (
       [key]   NVARCHAR(64)  NOT NULL PRIMARY KEY,
       [value] NVARCHAR(400) NOT NULL
     )`,

    `IF OBJECT_ID('dbo.users','U') IS NULL
     CREATE TABLE dbo.users (
       id            NVARCHAR(64)  NOT NULL PRIMARY KEY,
       username      NVARCHAR(120) NOT NULL,
       password_hash NVARCHAR(200) NOT NULL,
       role          NVARCHAR(32)  NOT NULL,
       full_name     NVARCHAR(200) NOT NULL CONSTRAINT df_users_full_name DEFAULT N'',
       active        BIT           NOT NULL CONSTRAINT df_users_active DEFAULT 1,
       created_at    NVARCHAR(40)  NOT NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_users_username' AND object_id=OBJECT_ID('dbo.users'))
     CREATE UNIQUE INDEX ux_users_username ON dbo.users(username)`,

    `IF OBJECT_ID('dbo.sessions','U') IS NULL
     CREATE TABLE dbo.sessions (
       token      NVARCHAR(128) NOT NULL PRIMARY KEY,
       role       NVARCHAR(16)  NOT NULL,
       created_at NVARCHAR(40)  NOT NULL,
       expires_at NVARCHAR(40)  NOT NULL
     )`,

    `IF OBJECT_ID('dbo.login_attempts','U') IS NULL
     CREATE TABLE dbo.login_attempts (
       ip           NVARCHAR(64) NOT NULL PRIMARY KEY,
       fails        INT          NOT NULL CONSTRAINT df_fails DEFAULT 0,
       locked_until NVARCHAR(40) NULL
     )`,

    `IF OBJECT_ID('dbo.audit','U') IS NULL
     CREATE TABLE dbo.audit (
       id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
       at        NVARCHAR(40)   NOT NULL,
       role      NVARCHAR(16)   NOT NULL,
       ip        NVARCHAR(64)   NULL,
       action    NVARCHAR(40)   NOT NULL,
       entity_id NVARCHAR(64)   NULL,
       detail    NVARCHAR(MAX)  NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_audit_at' AND object_id=OBJECT_ID('dbo.audit'))
     CREATE INDEX ix_audit_at ON dbo.audit(at DESC)`,

    // سجلّ السائقين. allowed_types نص JSON لمصفوفة رموز الأنواع، استشاري لا
    // يمنع البوابة من كتابة أي اسم سائق. created_at نص ISO لا DATETIME2، اتساقًا
    // مع نفس القرار في users.created_at أعلاه.
    `IF OBJECT_ID('dbo.drivers','U') IS NULL
     CREATE TABLE dbo.drivers (
       id            NVARCHAR(64)  NOT NULL PRIMARY KEY,
       name          NVARCHAR(200) NOT NULL,
       allowed_types NVARCHAR(400) NOT NULL CONSTRAINT df_drivers_allowed_types DEFAULT N'[]',
       created_at    NVARCHAR(40)  NOT NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ux_drivers_name' AND object_id=OBJECT_ID('dbo.drivers'))
     CREATE UNIQUE INDEX ux_drivers_name ON dbo.drivers(name)`,

    // تعبئة آلية من المازوت: قراءة توضيحية لا تُفرض عليها قاعدة عدم النقصان
    // (كيلومتراج الآلية الحقيقي يُتتبَّع من جدول entries). عمود الوقت يُحاط
    // بأقواس مربّعة لأن TIME اسم نوع بيانات في SQL Server، اتساقًا مع نفس
    // الاحتراز على [key]/[value] في جدول settings أعلاه.
    `IF OBJECT_ID('dbo.fuel_fills','U') IS NULL
     CREATE TABLE dbo.fuel_fills (
       id         NVARCHAR(64)  NOT NULL PRIMARY KEY,
       vehicle    NVARCHAR(200) NOT NULL,
       km         FLOAT         NOT NULL,
       qty        FLOAT         NOT NULL,
       work_hours FLOAT         NULL,
       date_key   NVARCHAR(10)  NOT NULL,
       [time]     NVARCHAR(5)   NOT NULL,
       created_at NVARCHAR(40)  NOT NULL,
       created_by NVARCHAR(120) NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_fuel_fills_date' AND object_id=OBJECT_ID('dbo.fuel_fills'))
     CREATE INDEX ix_fuel_fills_date ON dbo.fuel_fills(date_key DESC, [time] DESC)`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_fuel_fills_vehicle' AND object_id=OBJECT_ID('dbo.fuel_fills'))
     CREATE INDEX ix_fuel_fills_vehicle ON dbo.fuel_fills(vehicle)`,

    // تعبئة الخزان الرئيسي: قراءة عدّاد تراكمي واحدة للمنشأة كلها، بنفس مبدأ
    // كيلومتراج الآليات — تُخزَّن القراءة المطلقة لا الفرق، والفرق يُحسَب عند
    // الحاجة (التقارير) من الفرق عن آخر قراءة أو عن الرصيد الابتدائي.
    `IF OBJECT_ID('dbo.fuel_supply','U') IS NULL
     CREATE TABLE dbo.fuel_supply (
       id            NVARCHAR(64)  NOT NULL PRIMARY KEY,
       meter_reading FLOAT         NOT NULL,
       date_key      NVARCHAR(10)  NOT NULL,
       [time]        NVARCHAR(5)   NOT NULL,
       created_at    NVARCHAR(40)  NOT NULL,
       created_by    NVARCHAR(120) NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_fuel_supply_date' AND object_id=OBJECT_ID('dbo.fuel_supply'))
     CREATE INDEX ix_fuel_supply_date ON dbo.fuel_supply(date_key DESC, [time] DESC)`,

    // سجلّ آليات ضيوف: دخول/خروج مبسّط بلا كيلومتراج ولا زبون ثابت — الهدف
    // معرفة من بالموقع الآن فقط.
    `IF OBJECT_ID('dbo.guest_visits','U') IS NULL
     CREATE TABLE dbo.guest_visits (
       id           NVARCHAR(64)  NOT NULL PRIMARY KEY,
       vehicle_desc NVARCHAR(200) NOT NULL,
       purpose      NVARCHAR(300) NOT NULL,
       date_in      NVARCHAR(10)  NOT NULL,
       time_in      NVARCHAR(5)   NOT NULL,
       date_out     NVARCHAR(10)  NULL,
       time_out     NVARCHAR(5)   NULL,
       status       NVARCHAR(8)   NOT NULL CONSTRAINT ck_guest_visits_status CHECK (status IN (N'in', N'out')),
       created_by   NVARCHAR(120) NULL
     )`,

    `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                    WHERE name='ix_guest_visits_status' AND object_id=OBJECT_ID('dbo.guest_visits'))
     CREATE INDEX ix_guest_visits_status ON dbo.guest_visits(status)`
  ];

  for (const stmt of statements) {
    await pool.request().query(stmt);
  }
}

// إضافة عمود ناقص إلى جدول قائم فعلًا دون كسره — لا يوجد نظام migration عام
// في هذا الملف، فهذا الاستبدال الآمن الوحيد لجدول أُنشئ قبل تغيّر شكله.
async function ensureColumn(table, name, columnDdl) {
  await pool.request().query(
    `IF NOT EXISTS (SELECT 1 FROM sys.columns
                    WHERE object_id = OBJECT_ID('dbo.${table}') AND name = '${name}')
     ALTER TABLE dbo.${table} ADD ${columnDdl}`);
}

async function close() {
  if (pool) { await pool.close(); pool = null; }
}

/* ------------------------------------------------ كلمات المرور والجلسات */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(plain, salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$120000$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const expected = Buffer.from(parts[3], 'hex');
  const actual = crypto.pbkdf2Sync(plain, parts[2], Number(parts[1]), expected.length, 'sha256');
  return crypto.timingSafeEqual(expected, actual);
}

async function getSetting(key) {
  const r = await one('SELECT [value] FROM dbo.settings WHERE [key] = @k', [['k', NV(64), key]]);
  return r ? r.value : null;
}

async function setSetting(key, value) {
  await q(`MERGE dbo.settings AS t
           USING (SELECT @k AS [key], @v AS [value]) AS s
           ON t.[key] = s.[key]
           WHEN MATCHED THEN UPDATE SET [value] = s.[value]
           WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (s.[key], s.[value]);`,
    [['k', NV(64), key], ['v', NV(400), String(value)]]);
}

function randomPassword() {
  const words = ['bawaba', 'majbal', 'qallab', 'sijil', 'harakat', 'aliya', 'saeq', 'raqam'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(10, 100)}`;
}

// الحسابات الافتراضية عند أول تشغيل تمامًا (اسم مستخدم مقروء لكل دور)، تُستخدم
// فقط إن لم يوجد أي مستخدم في القاعدة بعد.
const DEFAULT_ROLE_USERS = [
  { username: 'بوابة',                    role: 'gate',                   fullName: 'حساب البوابة' },
  { username: 'مدير_الاليات',              role: 'fleet_manager',          fullName: 'مدير الآليات' },
  { username: 'المازوت',                   role: 'fuel',                   fullName: 'حساب المازوت' },
  { username: 'مدير_مستودع_المازوت',        role: 'fuel_warehouse_manager', fullName: 'مدير مستودع المازوت' },
  { username: 'مسؤول_الموارد_البشرية',      role: 'hr',                     fullName: 'مسؤول الموارد البشرية' }
];

/**
 * عند أول تشغيل: تُنشأ حسابات شخصية افتراضية بكلمات مرور عشوائية تُعرض مرة واحدة.
 * إن كانت القاعدة تحمل كلمتَي المرور القديمتين (pw_gate/pw_manager من نظام الدورين
 * السابق)، تُنسخ تجزئتاهما مباشرة إلى الحسابين الجديدين المطابقين بدل توليد كلمتي
 * مرور جديدتين — استمرارية بلا إجبار الموظفين على تغيير كلماتهم فور الترقية.
 * حساب الأدمن حالة خاصة دائمًا: كلمة مروره الافتراضية ثابتة في الإعدادات
 * (`sald2024` ما لم يُغيَّرها ADMIN_PASSWORD)، ويُزرع إن لم يوجد بعد حتى لو
 * وُجدت حسابات أخرى مسبقًا.
 */
async function seedUsers(adminPassword) {
  const out = {};
  const countRow = await one('SELECT COUNT(*) AS n FROM dbo.users');
  const noUsersYet = (countRow ? countRow.n : 0) === 0;
  if (noUsersYet) {
    const legacy = { gate: await getSetting('pw_gate'), fleet_manager: await getSetting('pw_manager') };
    for (const def of DEFAULT_ROLE_USERS) {
      const legacyHash = legacy[def.role];
      if (legacyHash) {
        await insertUser({ username: def.username, passwordHash: legacyHash, role: def.role, fullName: def.fullName });
      } else {
        const plain = randomPassword();
        await insertUser({ username: def.username, passwordHash: hashPassword(plain), role: def.role, fullName: def.fullName });
        out[def.username] = plain;
      }
    }
  }
  if (!(await getUserByUsername('admin'))) {
    await insertUser({ username: 'admin', passwordHash: hashPassword(adminPassword || 'sald2024'), role: 'admin', fullName: 'المدير العام' });
  }
  return Object.keys(out).length ? out : null;
}

function userOut(r) {
  if (!r) return null;
  return { id: r.id, username: r.username, role: r.role, fullName: r.full_name, active: !!r.active, createdAt: r.created_at };
}

async function getUser(id) {
  return userOut(await one('SELECT * FROM dbo.users WHERE id = @id', [['id', NV(64), String(id)]]));
}

async function getUserByUsername(username) {
  return userOut(await one('SELECT * FROM dbo.users WHERE username = @u',
    [['u', NV(120), String(username).trim()]]));
}

async function listUsers() {
  return (await all('SELECT * FROM dbo.users ORDER BY role, username')).map(userOut);
}

async function insertUser(data) {
  const id = newId('u');
  try {
    await q(`INSERT INTO dbo.users (id, username, password_hash, role, full_name, active, created_at)
             VALUES (@id,@u,@p,@r,@f,1,@ca)`,
      [['id', NV(64), id], ['u', NV(120), String(data.username).trim()],
       ['p', NV(200), data.passwordHash], ['r', NV(32), data.role],
       ['f', NV(200), data.fullName || ''], ['ca', NV(40), new Date().toISOString()]]);
  } catch (err) {
    if (isDuplicateError(err)) {
      const e = new Error('اسم المستخدم هذا مستخدم بالفعل.');
      e.duplicateUsername = true;
      throw e;
    }
    throw err;
  }
  return getUser(id);
}

async function updateUser(id, data) {
  const existing = await one('SELECT * FROM dbo.users WHERE id = @id', [['id', NV(64), String(id)]]);
  if (!existing) return null;
  await q('UPDATE dbo.users SET full_name = @f, role = @r WHERE id = @id',
    [['f', NV(200), data.fullName !== undefined ? data.fullName : existing.full_name],
     ['r', NV(32), data.role !== undefined ? data.role : existing.role],
     ['id', NV(64), String(id)]]);
  return getUser(id);
}

async function setUserActive(id, active) {
  const r = await q('UPDATE dbo.users SET active = @a WHERE id = @id',
    [['a', sql.Bit, active ? 1 : 0], ['id', NV(64), String(id)]]);
  const changed = (r.rowsAffected && r.rowsAffected[0]) || 0;
  return changed > 0 ? getUser(id) : null;
}

async function changeUserPassword(id, plain) {
  if (typeof plain !== 'string' || plain.length < 6) {
    throw new Error('كلمة المرور يجب أن تكون 6 محارف على الأقل');
  }
  const r = await q('UPDATE dbo.users SET password_hash = @p WHERE id = @id',
    [['p', NV(200), hashPassword(plain)], ['id', NV(64), String(id)]]);
  const changed = (r.rowsAffected && r.rowsAffected[0]) || 0;
  if (changed === 0) throw new Error('المستخدم غير موجود');
}

async function checkLockout(ip) {
  const r = await one('SELECT locked_until FROM dbo.login_attempts WHERE ip = @ip',
    [['ip', NV(64), ip]]);
  if (!r || !r.locked_until) return null;
  const until = new Date(r.locked_until);
  if (until > new Date()) return Math.ceil((until - new Date()) / 60000);
  await q('DELETE FROM dbo.login_attempts WHERE ip = @ip', [['ip', NV(64), ip]]);
  return null;
}

async function noteLoginFailure(ip) {
  await q(`MERGE dbo.login_attempts AS t
           USING (SELECT @ip AS ip) AS s ON t.ip = s.ip
           WHEN MATCHED THEN UPDATE SET fails = t.fails + 1
           WHEN NOT MATCHED THEN INSERT (ip, fails) VALUES (s.ip, 1);`,
    [['ip', NV(64), ip]]);

  const r = await one('SELECT fails FROM dbo.login_attempts WHERE ip = @ip', [['ip', NV(64), ip]]);
  const fails = r ? r.fails : 1;
  if (fails >= LOCKOUT_TRIES) {
    await q('UPDATE dbo.login_attempts SET locked_until = @u WHERE ip = @ip',
      [['u', NV(40), new Date(Date.now() + LOCKOUT_MIN * 60000).toISOString()],
       ['ip', NV(64), ip]]);
  }
  return { fails, remaining: Math.max(0, LOCKOUT_TRIES - fails) };
}

async function clearLoginFailures(ip) {
  await q('DELETE FROM dbo.login_attempts WHERE ip = @ip', [['ip', NV(64), ip]]);
}

async function login(username, password, ip) {
  const row = await one('SELECT * FROM dbo.users WHERE username = @u',
    [['u', NV(120), String(username).trim()]]);
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) return null;
  await clearLoginFailures(ip);
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_HOURS * 3600000);
  await q(`INSERT INTO dbo.sessions (token, user_id, username, role, created_at, expires_at)
           VALUES (@t,@uid,@un,@r,@c,@e)`,
    [['t', NV(128), token], ['uid', NV(64), row.id], ['un', NV(120), row.username],
     ['r', NV(16), row.role], ['c', NV(40), now.toISOString()], ['e', NV(40), exp.toISOString()]]);
  return { token, userId: row.id, username: row.username, role: row.role, expiresAt: exp.toISOString() };
}

async function sessionUser(token) {
  if (!token) return null;
  const r = await one('SELECT user_id, username, role, expires_at FROM dbo.sessions WHERE token = @t',
    [['t', NV(128), token]]);
  if (!r) return null;
  if (new Date(r.expires_at) <= new Date()) {
    await q('DELETE FROM dbo.sessions WHERE token = @t', [['t', NV(128), token]]);
    return null;
  }
  return { userId: r.user_id, username: r.username, role: r.role };
}

async function logout(token) {
  if (token) await q('DELETE FROM dbo.sessions WHERE token = @t', [['t', NV(128), token]]);
}

async function purgeExpiredSessions() {
  await q('DELETE FROM dbo.sessions WHERE expires_at <= @n',
    [['n', NV(40), new Date().toISOString()]]);
}

/* -------------------------------------------------------------- التدقيق */

// actor: {username, role} — أو نص دور مجرّد (توافقًا مع نداءات قديمة محتملة).
async function audit(actor, ip, action, entityId, detail) {
  const username = (actor && actor.username) || '-';
  const role = (actor && actor.role) || actor || '-';
  await q(`INSERT INTO dbo.audit (at, username, role, ip, action, entity_id, detail)
           VALUES (@at,@un,@role,@ip,@action,@eid,@detail)`,
    [['at', NV(40), new Date().toISOString()],
     ['un', NV(120), username],
     ['role', NV(16), role],
     ['ip', NV(64), ip || '-'],
     ['action', NV(40), action],
     ['eid', NV(64), entityId || null],
     ['detail', sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null]]);
}

async function listAudit(limit) {
  const n = Math.min(Number(limit) || 200, 1000);
  return all(`SELECT TOP (@n) id, at, username, role, ip, action, entity_id, detail
              FROM dbo.audit ORDER BY id DESC`, [['n', sql.Int, n]]);
}

/* --------------------------------------------------------- تحويل الصفوف */

function entryOut(r) {
  if (!r) return null;
  return {
    id: r.id, dateKey: r.date_key, vehicle: r.vehicle, driver: r.driver,
    customer: r.customer, departTime: r.depart_time, notesOut: r.notes_out,
    returnDate: r.return_date, returnTime: r.return_time,
    km: r.km === null || r.km === undefined ? null : Number(r.km),
    loadQty: r.load_qty === null || r.load_qty === undefined ? null : Number(r.load_qty),
    technicianName: r.technician_name || null,
    technicianAssistant: r.technician_assistant || null,
    manualPour: !!r.manual_pour,
    notesIn: r.notes_in, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    clientRef: r.client_ref, returnClientRef: r.return_client_ref
  };
}

function vehicleOut(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, baselineKm: Number(r.baseline_km), registeredAt: r.registered_at,
    type: r.type || null,
    fuelTankQty: r.fuel_tank_qty === null || r.fuel_tank_qty === undefined ? null : Number(r.fuel_tank_qty),
    workHoursBaseline: r.work_hours_baseline === null || r.work_hours_baseline === undefined ? null : Number(r.work_hours_baseline)
  };
}

function driverOut(r) {
  if (!r) return null;
  let allowedTypes = [];
  try { allowedTypes = JSON.parse(r.allowed_types || '[]'); } catch (e) { allowedTypes = []; }
  return { id: r.id, name: r.name, allowedTypes, createdAt: r.created_at };
}

/* ---------------------------------------------------------- الاستعلامات */

async function listVehicles() {
  return (await all('SELECT * FROM dbo.vehicles ORDER BY name')).map(vehicleOut);
}

async function listEntries(days) {
  const n = Number(days);
  if (!n || n <= 0) {
    return (await all(`SELECT * FROM dbo.entries
                       ORDER BY date_key DESC, depart_time DESC`)).map(entryOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return (await all(`SELECT * FROM dbo.entries
                     WHERE status = N'out' OR date_key >= @from
                     ORDER BY date_key DESC, depart_time DESC`,
    [['from', NV(10), from]])).map(entryOut);
}

async function getEntry(id) {
  return entryOut(await one('SELECT * FROM dbo.entries WHERE id = @id', [['id', NV(64), String(id)]]));
}

async function getEntryByClientRef(ref) {
  if (!ref) return null;
  return entryOut(await one('SELECT * FROM dbo.entries WHERE client_ref = @r',
    [['r', NV(64), String(ref)]]));
}

async function getVehicle(id) {
  return vehicleOut(await one('SELECT * FROM dbo.vehicles WHERE id = @id', [['id', NV(64), String(id)]]));
}

async function getVehicleByName(name) {
  return vehicleOut(await one('SELECT * FROM dbo.vehicles WHERE name = @n',
    [['n', NV(120), String(name).trim()]]));
}

async function lastKmForVehicle(name) {
  const v = String(name).trim();
  const r = await one(`SELECT TOP 1 km FROM dbo.entries
                       WHERE vehicle = @v AND status = N'done' AND km IS NOT NULL
                       ORDER BY date_key DESC, depart_time DESC`, [['v', NV(120), v]]);
  if (r && r.km !== null && r.km !== undefined) return Number(r.km);
  const veh = await getVehicleByName(v);
  return veh ? veh.baselineKm : null;
}

async function vehicleIsOut(name) {
  const r = await one(`SELECT TOP 1 id, driver, customer, depart_time FROM dbo.entries
                       WHERE vehicle = @v AND status = N'out'`,
    [['v', NV(120), String(name).trim()]]);
  if (!r) return null;
  return { id: r.id, driver: r.driver, customer: r.customer, departTime: r.depart_time };
}

async function countEntriesForVehicle(name) {
  const r = await one('SELECT COUNT(*) AS n FROM dbo.entries WHERE vehicle = @v',
    [['v', NV(120), String(name).trim()]]);
  return r ? r.n : 0;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

/* ------------------------------------------------------- عمليات الكتابة */

async function insertEntry(data) {
  const now = new Date().toISOString();
  const id = newId('t');
  try {
    await q(`INSERT INTO dbo.entries
              (id, date_key, vehicle, driver, customer, depart_time, notes_out,
               return_date, return_time, km, load_qty, technician_name, technician_assistant, manual_pour,
               notes_in, status, created_at, updated_at, client_ref)
             VALUES (@id,@dk,@v,@d,@c,@dt,@no,NULL,NULL,NULL,@lq,@tn,@ta,@mp,N'',N'out',@ca,@ua,@cr)`,
      [['id', NV(64), id], ['dk', NV(10), data.dateKey], ['v', NV(120), data.vehicle],
       ['d', NV(120), data.driver], ['c', NV(120), data.customer],
       ['dt', NV(5), data.departTime], ['no', NV(400), data.notesOut || ''],
       ['lq', FLT, data.loadQty === undefined || data.loadQty === null ? null : Number(data.loadQty)],
       ['tn', NV(200), data.technicianName || null], ['ta', NV(200), data.technicianAssistant || null],
       ['mp', sql.Bit, data.manualPour ? 1 : 0],
       ['ca', NV(40), now], ['ua', NV(40), now],
       ['cr', NV(64), data.clientRef || null]]);
  } catch (err) {
    // خرق الفهرس المُرشَّح = الآلية في الخارج أصلًا. نُعلِّم الخطأ ليترجمه
    // الخادم إلى 409، تمامًا كما يفعل المحرّكان الآخران.
    if (isDuplicateError(err)) {
      // خرق مفتاح التعريف يعني إعادة إرسال لطلب نجح أصلًا — لا خطأ.
      if (/ux_client_ref|client_ref/i.test(String(err.message))) {
        const e = new Error('طلب مُعاد.');
        e.duplicateClientRef = true;
        throw e;
      }
      const e = new Error('الآلية مسجّلة في الخارج بالفعل.');
      e.duplicateOpenTrip = true;
      throw e;
    }
    throw err;
  }
  return getEntry(id);
}

/**
 * تسجيل العودة. الشرط `status = N'out'` داخل جملة UPDATE يجعل العملية ذرّية:
 * إن سجّل جهاز آخر العودة قبل جزء من الثانية، لا يطابق التحديث أي صف
 * (rowsAffected = 0) فيفشل بدل أن يكتب فوق ما سُجِّل.
 */
async function closeEntry(id, data) {
  const existing = await getEntry(id);
  if (!existing) return { error: 'notfound' };

  const r = await q(`UPDATE dbo.entries
                     SET return_date=@rd, return_time=@rt, km=@km, notes_in=@ni,
                         status=N'done', updated_at=@ua, return_client_ref=@cr
                     WHERE id=@id AND status=N'out'`,
    [['rd', NV(10), data.returnDate], ['rt', NV(5), data.returnTime],
     ['km', FLT, Number(data.km)], ['ni', NV(400), data.notesIn || ''],
     ['ua', NV(40), new Date().toISOString()],
     ['cr', NV(64), data.clientRef || null], ['id', NV(64), String(id)]]);

  const changed = (r.rowsAffected && r.rowsAffected[0]) || 0;
  if (changed === 0) return { error: 'already', entry: existing };
  return { entry: await getEntry(id) };
}

async function updateEntry(id, data) {
  const existing = await getEntry(id);
  if (!existing) return null;
  const done = data.returnTime && data.km !== null && data.km !== undefined && data.km !== '';

  await q(`UPDATE dbo.entries
           SET date_key=@dk, vehicle=@v, driver=@d, customer=@c, depart_time=@dt,
               notes_out=@no, load_qty=@lq, technician_name=@tn, technician_assistant=@ta, manual_pour=@mp,
               return_date=@rd, return_time=@rt, km=@km,
               notes_in=@ni, status=@st, updated_at=@ua
           WHERE id=@id`,
    [['dk', NV(10), data.dateKey], ['v', NV(120), data.vehicle],
     ['d', NV(120), data.driver], ['c', NV(120), data.customer],
     ['dt', NV(5), data.departTime], ['no', NV(400), data.notesOut || ''],
     ['lq', FLT, data.loadQty === undefined || data.loadQty === null || data.loadQty === '' ? null : Number(data.loadQty)],
     ['tn', NV(200), data.technicianName || null], ['ta', NV(200), data.technicianAssistant || null],
     ['mp', sql.Bit, data.manualPour ? 1 : 0],
     ['rd', NV(10), done ? (data.returnDate || data.dateKey) : null],
     ['rt', NV(5), done ? data.returnTime : null],
     ['km', FLT, done ? Number(data.km) : null],
     ['ni', NV(400), done ? (data.notesIn || '') : ''],
     ['st', NV(8), done ? 'done' : 'out'],
     ['ua', NV(40), new Date().toISOString()], ['id', NV(64), String(id)]]);

  return getEntry(id);
}

async function deleteEntry(id) {
  const r = await q('DELETE FROM dbo.entries WHERE id = @id', [['id', NV(64), String(id)]]);
  return ((r.rowsAffected && r.rowsAffected[0]) || 0) > 0;
}

async function getVehicleByClientRef(ref) {
  if (!ref) return null;
  return vehicleOut(await one('SELECT * FROM dbo.vehicles WHERE client_ref = @r',
    [['r', NV(64), String(ref)]]));
}

async function insertVehicle(name, baselineKm, type, fuelTankQty, workHoursBaseline, clientRef) {
  const id = newId('v');
  try {
    await q(`INSERT INTO dbo.vehicles (id, name, baseline_km, type, fuel_tank_qty, work_hours_baseline, registered_at, client_ref)
             VALUES (@id,@n,@km,@t,@f,@whb,@r,@cr)`,
      [['id', NV(64), id], ['n', NV(120), String(name).trim()],
       ['km', FLT, Number(baselineKm)], ['t', NV(32), type || null],
       ['f', FLT, fuelTankQty === undefined || fuelTankQty === null || fuelTankQty === '' ? null : Number(fuelTankQty)],
       ['whb', FLT, workHoursBaseline === undefined || workHoursBaseline === null || workHoursBaseline === '' ? null : Number(workHoursBaseline)],
       ['r', NV(40), new Date().toISOString()],
       ['cr', NV(64), clientRef || null]]);
  } catch (err) {
    // خرق فهرس فريد: إمّا الاسم (لا يُتحقَّق منه في هذا الملف اليوم — طبقة
    // server.js تتحقّق سلفًا وتُرجع 409 خاصًا بها، وهذه إضافة احترازية فقط
    // تُماثل سلوك محرّك sqlite الجديد)، أو مفتاح التعريف (إعادة إرسال آمنة).
    if (isDuplicateError(err)) {
      if (await getVehicleByName(name)) {
        const e = new Error('هذه الآلية مسجّلة مسبقًا.');
        e.duplicateName = true;
        throw e;
      }
      const e = new Error('طلب مُعاد.');
      e.duplicateClientRef = true;
      throw e;
    }
    throw err;
  }
  return getVehicle(id);
}

/**
 * تعديل آلية. إعادة التسمية تُحدِّث كل سجلاتها داخل معاملة واحدة، وإلا انفصل
 * تاريخها القديم عن اسمها الجديد وضاعت حسابات المسافة.
 */
async function updateVehicle(id, name, baselineKm, type, fuelTankQty, workHoursBaseline) {
  const old = await one('SELECT * FROM dbo.vehicles WHERE id = @id', [['id', NV(64), String(id)]]);
  if (!old) return null;
  const newName = String(name).trim();

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await q('UPDATE dbo.vehicles SET name=@n, baseline_km=@km, type=@t, fuel_tank_qty=@f, work_hours_baseline=@whb WHERE id=@id',
      [['n', NV(120), newName], ['km', FLT, Number(baselineKm)],
       ['t', NV(32), type || null],
       ['f', FLT, fuelTankQty === undefined || fuelTankQty === null || fuelTankQty === '' ? null : Number(fuelTankQty)],
       ['whb', FLT, workHoursBaseline === undefined || workHoursBaseline === null || workHoursBaseline === '' ? null : Number(workHoursBaseline)],
       ['id', NV(64), String(id)]], tx);
    if (old.name !== newName) {
      await q('UPDATE dbo.entries SET vehicle=@n, updated_at=@ua WHERE vehicle=@o',
        [['n', NV(120), newName], ['ua', NV(40), new Date().toISOString()],
         ['o', NV(120), old.name]], tx);
    }
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch (e) { /* المعاملة أُغلقت أصلًا */ }
    throw err;
  }
  return getVehicle(id);
}

async function deleteVehicle(id) {
  const r = await q('DELETE FROM dbo.vehicles WHERE id = @id', [['id', NV(64), String(id)]]);
  return ((r.rowsAffected && r.rowsAffected[0]) || 0) > 0;
}

/* ---------------------------------------------------------- السائقون */

async function listDrivers() {
  return (await all('SELECT * FROM dbo.drivers ORDER BY name')).map(driverOut);
}

async function getDriverByName(name) {
  return driverOut(await one('SELECT * FROM dbo.drivers WHERE name = @n',
    [['n', NV(200), String(name).trim()]]));
}

async function getDriverByClientRef(ref) {
  if (!ref) return null;
  return driverOut(await one('SELECT * FROM dbo.drivers WHERE client_ref = @r',
    [['r', NV(64), String(ref)]]));
}

async function insertDriver(data) {
  const id = newId('d');
  try {
    await q('INSERT INTO dbo.drivers (id, name, allowed_types, created_at, client_ref) VALUES (@id,@n,@a,@ca,@cr)',
      [['id', NV(64), id], ['n', NV(200), String(data.name).trim()],
       ['a', NV(400), JSON.stringify(data.allowedTypes || [])],
       ['ca', NV(40), new Date().toISOString()],
       ['cr', NV(64), data.clientRef || null]]);
  } catch (err) {
    if (isDuplicateError(err)) {
      if (await getDriverByName(data.name)) {
        const e = new Error('هذا السائق مسجّل مسبقًا.');
        e.duplicateDriverName = true;
        throw e;
      }
      const e = new Error('طلب مُعاد.');
      e.duplicateClientRef = true;
      throw e;
    }
    throw err;
  }
  return driverOut(await one('SELECT * FROM dbo.drivers WHERE id = @id', [['id', NV(64), id]]));
}

async function updateDriver(id, data) {
  const existing = await one('SELECT * FROM dbo.drivers WHERE id = @id', [['id', NV(64), String(id)]]);
  if (!existing) return null;
  const newName = String(data.name).trim();
  try {
    await q('UPDATE dbo.drivers SET name = @n, allowed_types = @a WHERE id = @id',
      [['n', NV(200), newName], ['a', NV(400), JSON.stringify(data.allowedTypes || [])],
       ['id', NV(64), String(id)]]);
  } catch (err) {
    if (isDuplicateError(err)) {
      const e = new Error('يوجد سائق آخر بنفس الاسم.');
      e.duplicateDriverName = true;
      throw e;
    }
    throw err;
  }
  return driverOut(await one('SELECT * FROM dbo.drivers WHERE id = @id', [['id', NV(64), String(id)]]));
}

async function deleteDriver(id) {
  const r = await q('DELETE FROM dbo.drivers WHERE id = @id', [['id', NV(64), String(id)]]);
  return ((r.rowsAffected && r.rowsAffected[0]) || 0) > 0;
}

/* ---------------------------------------------------------- وحدة المازوت */

function fuelFillOut(r) {
  if (!r) return null;
  return {
    id: r.id, vehicle: r.vehicle, km: Number(r.km), qty: Number(r.qty),
    workHours: r.work_hours === null || r.work_hours === undefined ? null : Number(r.work_hours),
    tank: r.tank || 'tank1',
    dispenserMeter: r.dispenser_meter === null || r.dispenser_meter === undefined ? null : Number(r.dispenser_meter),
    dateKey: r.date_key, time: r.time, createdAt: r.created_at, createdBy: r.created_by
  };
}

function fuelSupplyOut(r) {
  if (!r) return null;
  return {
    id: r.id, meterReading: Number(r.meter_reading), tank: r.tank || 'tank1',
    dateKey: r.date_key, time: r.time, createdAt: r.created_at, createdBy: r.created_by
  };
}

async function listFuelFills(days) {
  const n = Number(days);
  if (!n || n <= 0) {
    return (await all(`SELECT * FROM dbo.fuel_fills
                       ORDER BY date_key DESC, [time] DESC`)).map(fuelFillOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return (await all(`SELECT * FROM dbo.fuel_fills
                     WHERE date_key >= @from
                     ORDER BY date_key DESC, [time] DESC`,
    [['from', NV(10), from]])).map(fuelFillOut);
}

async function getFuelFillByClientRef(ref) {
  if (!ref) return null;
  return fuelFillOut(await one('SELECT * FROM dbo.fuel_fills WHERE client_ref = @r',
    [['r', NV(64), String(ref)]]));
}

async function insertFuelFill(data) {
  const id = newId('f');
  try {
    await q(`INSERT INTO dbo.fuel_fills (id, vehicle, km, qty, work_hours, tank, dispenser_meter, date_key, [time], created_at, created_by, client_ref)
             VALUES (@id,@v,@km,@qty,@wh,@tk,@dm,@dk,@t,@ca,@cb,@cr)`,
      [['id', NV(64), id], ['v', NV(200), String(data.vehicle).trim()],
       ['km', FLT, Number(data.km)], ['qty', FLT, Number(data.qty)],
       ['wh', FLT, data.workHours === undefined || data.workHours === null || data.workHours === '' ? null : Number(data.workHours)],
       ['tk', NV(16), String(data.tank || 'tank1')],
       ['dm', FLT, data.dispenserMeter === undefined || data.dispenserMeter === null || data.dispenserMeter === '' ? null : Number(data.dispenserMeter)],
       ['dk', NV(10), data.dateKey], ['t', NV(5), data.time],
       ['ca', NV(40), new Date().toISOString()], ['cb', NV(120), data.createdBy || null],
       ['cr', NV(64), data.clientRef || null]]);
  } catch (err) {
    // لا يوجد أي قيد فريد آخر على هذا الجدول، فأي خرق هنا هو بالضرورة مفتاح
    // التعريف — إعادة إرسال لطلب نجح أصلًا.
    if (isDuplicateError(err)) {
      const e = new Error('طلب مُعاد.');
      e.duplicateClientRef = true;
      throw e;
    }
    throw err;
  }
  return fuelFillOut(await one('SELECT * FROM dbo.fuel_fills WHERE id = @id', [['id', NV(64), id]]));
}

// آخر قراءة عدّاد ساعات عمل لآلية معيّنة — نفس دور lastKmForVehicle، لكن
// لعدّاد ساعات العمل بدل الكيلومتراج، والافتراض الأول هو work_hours_baseline
// المسجَّل عند تسجيل الآلية (المرحلة 5) لا صفر.
async function lastWorkHoursForVehicle(name) {
  const v = String(name).trim();
  const r = await one(`SELECT TOP 1 work_hours FROM dbo.fuel_fills
                       WHERE vehicle = @v AND work_hours IS NOT NULL
                       ORDER BY date_key DESC, [time] DESC, created_at DESC`, [['v', NV(200), v]]);
  if (r && r.work_hours !== null && r.work_hours !== undefined) return Number(r.work_hours);
  const veh = await getVehicleByName(v);
  return veh ? veh.workHoursBaseline : null;
}

async function listFuelSupply(days) {
  const n = Number(days);
  if (!n || n <= 0) {
    return (await all(`SELECT * FROM dbo.fuel_supply
                       ORDER BY date_key DESC, [time] DESC`)).map(fuelSupplyOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return (await all(`SELECT * FROM dbo.fuel_supply
                     WHERE date_key >= @from
                     ORDER BY date_key DESC, [time] DESC`,
    [['from', NV(10), from]])).map(fuelSupplyOut);
}

async function getFuelSupplyByClientRef(ref) {
  if (!ref) return null;
  return fuelSupplyOut(await one('SELECT * FROM dbo.fuel_supply WHERE client_ref = @r',
    [['r', NV(64), String(ref)]]));
}

async function insertFuelSupply(data) {
  const id = newId('s');
  try {
    await q(`INSERT INTO dbo.fuel_supply (id, meter_reading, tank, date_key, [time], created_at, created_by, client_ref)
             VALUES (@id,@mr,@tk,@dk,@t,@ca,@cb,@cr)`,
      [['id', NV(64), id], ['mr', FLT, Number(data.meterReading)],
       ['tk', NV(16), String(data.tank || 'tank1')],
       ['dk', NV(10), data.dateKey], ['t', NV(5), data.time],
       ['ca', NV(40), new Date().toISOString()], ['cb', NV(120), data.createdBy || null],
       ['cr', NV(64), data.clientRef || null]]);
  } catch (err) {
    // لا يوجد أي قيد فريد آخر على هذا الجدول، فأي خرق هنا هو بالضرورة مفتاح
    // التعريف — إعادة إرسال لطلب نجح أصلًا.
    if (isDuplicateError(err)) {
      const e = new Error('طلب مُعاد.');
      e.duplicateClientRef = true;
      throw e;
    }
    throw err;
  }
  return fuelSupplyOut(await one('SELECT * FROM dbo.fuel_supply WHERE id = @id', [['id', NV(64), id]]));
}

// آخر قراءة عدّاد لخزان معيّن — نفس دور lastKmForVehicle، لكن لكل خزان من
// الثلاثة الثابتة على حدة (3 خزانات ثابتة دائمًا، لا تُدار من الأدمن).
async function lastFuelMeterReading(tank) {
  const r = await one(`SELECT TOP 1 meter_reading FROM dbo.fuel_supply
                       WHERE tank = @tk
                       ORDER BY date_key DESC, [time] DESC, created_at DESC`,
    [['tk', NV(16), String(tank)]]);
  if (r && r.meter_reading !== null && r.meter_reading !== undefined) return Number(r.meter_reading);
  const baseline = await getFuelBaseline(tank);
  return baseline ? baseline.initialMeter : null;
}

async function getFuelBaseline(tank) {
  const qty = await getSetting(`fuel_initial_qty_${tank}`);
  const meter = await getSetting(`fuel_initial_meter_${tank}`);
  if (qty === null || meter === null) return null;
  return { initialQty: Number(qty), initialMeter: Number(meter) };
}

async function setFuelBaseline(tank, initialQty, initialMeter) {
  await setSetting(`fuel_initial_qty_${tank}`, Number(initialQty));
  await setSetting(`fuel_initial_meter_${tank}`, Number(initialMeter));
  return getFuelBaseline(tank);
}

// عدّاد الكازية التراكمي: عدّاد واحد للمحطة كلها بلا علاقة بالخزانات، يُسجَّل
// اختياريًا مع كل تعبئة آلية، ويُستخدَم فقط للمقارنة/التصالح مع مجموع الكميات
// المُدخلة يدويًا — لا رصيد ابتدائي له، أول قراءة تُسجَّل تصير نقطة البداية.
async function lastDispenserMeterReading() {
  const r = await one(`SELECT TOP 1 dispenser_meter FROM dbo.fuel_fills
                       WHERE dispenser_meter IS NOT NULL
                       ORDER BY date_key DESC, [time] DESC, created_at DESC`);
  return r && r.dispenser_meter !== null && r.dispenser_meter !== undefined ? Number(r.dispenser_meter) : null;
}

/* ---------------------------------------------------------- آليات الضيوف */

function guestVisitOut(r) {
  if (!r) return null;
  return {
    id: r.id, vehicleDesc: r.vehicle_desc, purpose: r.purpose,
    dateIn: r.date_in, timeIn: r.time_in,
    dateOut: r.date_out, timeOut: r.time_out,
    status: r.status, createdBy: r.created_by
  };
}

// الضيوف بالموقع الآن دائمًا + من خرج خلال آخر `days` يومًا — نفس مبدأ listEntries.
async function listGuestVisits(days) {
  const n = Number(days);
  if (!n || n <= 0) {
    return (await all(`SELECT * FROM dbo.guest_visits
                       ORDER BY date_in DESC, time_in DESC`)).map(guestVisitOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return (await all(`SELECT * FROM dbo.guest_visits
                     WHERE status = N'in' OR date_in >= @from
                     ORDER BY date_in DESC, time_in DESC`,
    [['from', NV(10), from]])).map(guestVisitOut);
}

async function insertGuestVisit(data) {
  const id = newId('g');
  await q(`INSERT INTO dbo.guest_visits (id, vehicle_desc, purpose, date_in, time_in, date_out, time_out, status, created_by)
           VALUES (@id,@vd,@p,@di,@ti,NULL,NULL,N'in',@cb)`,
    [['id', NV(64), id], ['vd', NV(200), String(data.vehicleDesc).trim()],
     ['p', NV(300), String(data.purpose).trim()],
     ['di', NV(10), data.dateIn], ['ti', NV(5), data.timeIn],
     ['cb', NV(120), data.createdBy || null]]);
  return guestVisitOut(await one('SELECT * FROM dbo.guest_visits WHERE id = @id', [['id', NV(64), id]]));
}

/**
 * إغلاق زيارة ضيف. أبسط من closeEntry عمدًا: سجلّ الضيوف احتمال تسابق جهازين
 * عليه أقل بكثير من رحلات الآليات (لا فهرس فريد يحميه)، فتحديث بشرط
 * `status = N'in'` كافٍ دون معاملة صريحة — إن خرق جهازان الشرط في آنٍ واحد
 * فأحدهما فقط يطابق الصف (rowsAffected = 0 للآخر).
 */
async function closeGuestVisit(id, data) {
  const existing = await one('SELECT * FROM dbo.guest_visits WHERE id = @id', [['id', NV(64), String(id)]]);
  if (!existing) return { error: 'notfound' };
  if (existing.status !== 'in') return { error: 'already', visit: guestVisitOut(existing) };

  const r = await q(`UPDATE dbo.guest_visits SET date_out=@do, time_out=@to, status=N'out'
                     WHERE id=@id AND status=N'in'`,
    [['do', NV(10), data.dateOut], ['to', NV(5), data.timeOut], ['id', NV(64), String(id)]]);

  const changed = (r.rowsAffected && r.rowsAffected[0]) || 0;
  if (changed === 0) {
    const fresh = await one('SELECT * FROM dbo.guest_visits WHERE id = @id', [['id', NV(64), String(id)]]);
    return { error: 'already', visit: guestVisitOut(fresh) };
  }
  return { visit: guestVisitOut(await one('SELECT * FROM dbo.guest_visits WHERE id = @id', [['id', NV(64), String(id)]])) };
}

/* ------------------------------------------------- النسخ الاحتياطي */

/**
 * لقطة JSON لكل الجداول.
 *
 * ليست بديلًا عن النسخ الاحتياطي الرسمي لـ SQL Server. الاعتماد الصحيح على
 * خطة الصيانة (Maintenance Plan) أو أمر BACKUP DATABASE ضمن سياسة الشركة.
 */
async function backupTo(file) {
  const target = file.replace(/\.db$/, '.json');
  const dump = {
    exportedAt: new Date().toISOString(),
    format: 'gate-log-mssql-backup-v1',
    vehicles: await all('SELECT * FROM dbo.vehicles'),
    entries:  await all('SELECT * FROM dbo.entries'),
    settings: await all('SELECT * FROM dbo.settings'),
    audit:    await all('SELECT TOP 5000 * FROM dbo.audit ORDER BY id DESC')
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(dump, null, 2), 'utf8');
  return target;
}

module.exports = {
  init, close, backupTo,
  hashPassword, verifyPassword,
  insertUser, getUserByUsername, getUser, listUsers, updateUser, setUserActive, changeUserPassword,
  login, logout, sessionUser, purgeExpiredSessions,
  checkLockout, noteLoginFailure, clearLoginFailures,
  audit, listAudit,
  listVehicles, listEntries, getEntry, getEntryByClientRef, getVehicle, getVehicleByName,
  lastKmForVehicle, vehicleIsOut, countEntriesForVehicle,
  insertEntry, closeEntry, updateEntry, deleteEntry,
  insertVehicle, updateVehicle, deleteVehicle, getVehicleByClientRef,
  listDrivers, getDriverByName, insertDriver, updateDriver, deleteDriver, getDriverByClientRef,
  insertFuelFill, listFuelFills, insertFuelSupply, listFuelSupply, lastWorkHoursForVehicle, lastDispenserMeterReading,
  getFuelFillByClientRef, getFuelSupplyByClientRef,
  lastFuelMeterReading, getFuelBaseline, setFuelBaseline,
  listGuestVisits, insertGuestVisit, closeGuestVisit
};
