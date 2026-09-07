/**
 * verify-mssql.js — فحص شامل لاتصال SQL Server قبل تشغيل التطبيق.
 *
 * يُشغَّل على سيرفر الشركة، ويختبر كل ما يمكن أن يفشل — بالترتيب — فيقول لك
 * أين توقّف بالضبط بدل رسالة عطل واحدة غامضة:
 *
 *   الاتصال ← الصلاحيات ← إنشاء الجداول ← دعم الفهرس المُرشَّح
 *   ← تخزين العربية ← المعاملات ← منع الازدواج ← قراءة البيانات
 *
 *   node test/verify-mssql.js
 *
 * لا يمسّ بياناتك: كل ما يكتبه يُحذف في نهاية الفحص.
 */

'use strict';

const config = require('../config');

let sql;
try { sql = require('mssql'); }
catch (err) {
  console.error('\n  ✗ حزمة mssql غير مثبّتة.  نفّذ:  npm install\n');
  process.exit(1);
}

let pass = 0, fail = 0, warn = 0;
const line = (c = '─') => console.log('  ' + c.repeat(60));
const ok   = (n, x) => { pass++; console.log('  ✓ ' + n + (x ? '  — ' + x : '')); };
const no   = (n, x) => { fail++; console.log('  ✗ ' + n + (x ? '  — ' + x : '')); };
const warnY = (n, x) => { warn++; console.log('  ⚠ ' + n + (x ? '  — ' + x : '')); };

const T = '__gatelog_probe';   // جدول مؤقّت للفحص، يُحذف في النهاية

(async () => {
  console.log('');
  line('═');
  console.log('   فحص جاهزية SQL Server لتطبيق سجل بوابة المجبل');
  line('═');
  console.log('   الخادم    ' + config.safeMssql);
  console.log('   الإعدادات ' + config.configSource);
  console.log('');

  const c = config.mssql;
  const cfg = c.connectionString || {
    server: c.server, port: c.port, database: c.database,
    user: c.user, password: c.password,
    options: {
      instanceName: c.instanceName || undefined,
      encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate,
      enableArithAbort: true
    },
    connectionTimeout: 20000, requestTimeout: 30000
  };

  /* ---- 1. الاتصال ---- */
  console.log('  ▸ 1. الاتصال');
  line();
  let pool;
  try {
    pool = new sql.ConnectionPool(cfg);
    await pool.connect();
    ok('الاتصال بالخادم نجح');
  } catch (err) {
    no('تعذّر الاتصال', err.message);
    console.log('');
    console.log('    أشيع الأسباب على SQL Server Express:');
    console.log('      • بروتوكول TCP/IP معطّل (افتراضيًا) — فعّله من');
    console.log('        SQL Server Configuration Manager ثم أعد تشغيل الخدمة');
    console.log('      • المنفذ 1433 محجوب في جدار الحماية');
    console.log('      • النسخة مُسمّاة SQLEXPRESS — اضبط mssqlInstance');
    console.log('      • الخادم يقبل مصادقة Windows فقط — فعّل الوضع المختلط');
    console.log('');
    process.exit(1);
  }

  const r1 = await pool.request().query(
    "SELECT @@VERSION AS v, DB_NAME() AS db, SUSER_SNAME() AS usr, " +
    "SERVERPROPERTY('Edition') AS ed, SERVERPROPERTY('Collation') AS coll");
  const info = r1.recordset[0];
  ok('النسخة', String(info.ed));
  ok('قاعدة البيانات', String(info.db));
  ok('المستخدم', String(info.usr));
  console.log('    الترتيبية (collation): ' + info.coll);
  console.log('    ملاحظة: التطبيق يستخدم NVARCHAR في كل الأعمدة النصية،');
  console.log('    فالعربية تعمل مهما كانت هذه الترتيبية.');
  console.log('');

  /* ---- 2. الصلاحيات ---- */
  console.log('  ▸ 2. الصلاحيات المطلوبة');
  line();
  const perms = [
    ['CREATE TABLE', 'HAS_PERMS_BY_NAME(NULL, NULL, \'CREATE TABLE\')'],
    ['SELECT',       'HAS_PERMS_BY_NAME(NULL, NULL, \'SELECT\')'],
    ['INSERT',       'HAS_PERMS_BY_NAME(NULL, NULL, \'INSERT\')'],
    ['UPDATE',       'HAS_PERMS_BY_NAME(NULL, NULL, \'UPDATE\')'],
    ['DELETE',       'HAS_PERMS_BY_NAME(NULL, NULL, \'DELETE\')']
  ];
  for (const [label, expr] of perms) {
    const r = await pool.request().query('SELECT ' + expr + ' AS granted');
    const g = r.recordset[0].granted === 1;
    g ? ok('صلاحية ' + label) : no('صلاحية ' + label + ' مفقودة');
  }
  console.log('');

  /* ---- 3. إنشاء جدول وفهرس مُرشَّح ---- */
  console.log('  ▸ 3. إنشاء الجداول والفهرس المُرشَّح');
  line();
  try {
    await pool.request().query(`IF OBJECT_ID('dbo.${T}','U') IS NOT NULL DROP TABLE dbo.${T}`);
    await pool.request().query(`
      CREATE TABLE dbo.${T} (
        id      NVARCHAR(64)  NOT NULL PRIMARY KEY,
        vehicle NVARCHAR(120) NOT NULL,
        status  NVARCHAR(8)   NOT NULL,
        note    NVARCHAR(400) NULL
      )`);
    ok('إنشاء جدول اختبار');
  } catch (err) { no('إنشاء الجدول فشل', err.message); }

  try {
    await pool.request().query(
      `CREATE UNIQUE INDEX ux_${T}_open ON dbo.${T}(vehicle) WHERE status = N'out'`);
    ok('الفهرس المُرشَّح (filtered index) مدعوم',
       'هذا ما يمنع خروج آلية مرتين في نفس اللحظة');
  } catch (err) {
    no('الفهرس المُرشَّح غير مدعوم', err.message);
    console.log('    يتطلّب SQL Server 2008 أو أحدث.');
  }
  console.log('');

  /* ---- 4. تخزين العربية ---- */
  console.log('  ▸ 4. تخزين النصوص العربية');
  line();
  const arabic = 'قلاب رقم ٣ — معمل الإسمنت';
  await pool.request()
    .input('id', sql.NVarChar(64), 'probe1')
    .input('v',  sql.NVarChar(120), arabic)
    .input('s',  sql.NVarChar(8), 'out')
    .query(`INSERT INTO dbo.${T} (id, vehicle, status) VALUES (@id, @v, @s)`);
  const back = (await pool.request().query(`SELECT vehicle FROM dbo.${T} WHERE id = 'probe1'`))
    .recordset[0].vehicle;
  back === arabic
    ? ok('النص العربي عاد مطابقًا حرفًا بحرف', back)
    : no('النص العربي تشوّه', 'أُرسل: ' + arabic + '  |  عاد: ' + back);
  console.log('');

  /* ---- 5. منع الازدواج فعليًا ---- */
  console.log('  ▸ 5. منع رحلتين مفتوحتين لنفس الآلية');
  line();
  try {
    await pool.request()
      .input('id', sql.NVarChar(64), 'probe2')
      .input('v',  sql.NVarChar(120), arabic)
      .input('s',  sql.NVarChar(8), 'out')
      .query(`INSERT INTO dbo.${T} (id, vehicle, status) VALUES (@id, @v, @s)`);
    no('قُبل صف مفتوح ثانٍ لنفس الآلية', 'الفهرس لا يعمل!');
  } catch (err) {
    const dup = [2601, 2627].includes(err.number) ||
                (err.originalError && [2601, 2627].includes(err.originalError.number));
    dup ? ok('رُفض الصف الثاني برقم الخطأ ' + (err.number || err.originalError.number))
        : no('رُفض لسبب غير متوقّع', err.message);
  }
  console.log('');

  /* ---- 6. المعاملات ---- */
  console.log('  ▸ 6. المعاملات (transactions)');
  line();
  try {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    await new sql.Request(tx)
      .input('id', sql.NVarChar(64), 'probe3')
      .input('v',  sql.NVarChar(120), 'مؤقّت')
      .input('s',  sql.NVarChar(8), 'done')
      .query(`INSERT INTO dbo.${T} (id, vehicle, status) VALUES (@id, @v, @s)`);
    await tx.rollback();
    const n = (await pool.request().query(
      `SELECT COUNT(*) AS n FROM dbo.${T} WHERE id = 'probe3'`)).recordset[0].n;
    n === 0 ? ok('المعاملة تراجعت بنجاح (rollback)')
            : no('التراجع لم يعمل — بقي الصف');
  } catch (err) { no('المعاملات فشلت', err.message); }
  console.log('');

  /* ---- 7. التنظيف ---- */
  console.log('  ▸ 7. التنظيف');
  line();
  try {
    await pool.request().query(`DROP TABLE dbo.${T}`);
    ok('حُذف جدول الاختبار — لم يبقَ أثر');
  } catch (err) { warnY('تعذّر حذف جدول الاختبار', 'احذف dbo.' + T + ' يدويًا'); }

  /* ---- 8. جداول التطبيق إن وُجدت ---- */
  console.log('');
  console.log('  ▸ 8. جداول التطبيق (إن كان قد عمل من قبل)');
  line();
  const tables = ['vehicles', 'entries', 'settings', 'sessions', 'login_attempts', 'audit'];
  let found = 0;
  for (const t of tables) {
    const r = await pool.request().query(
      `IF OBJECT_ID('dbo.${t}','U') IS NOT NULL
         SELECT COUNT(*) AS n FROM dbo.${t}
       ELSE SELECT -1 AS n`);
    const n = r.recordset[0].n;
    if (n < 0) console.log('    ' + t.padEnd(16) + '—  (لم يُنشأ بعد)');
    else { found++; console.log('    ' + t.padEnd(16) + String(n).padStart(5) + '  صف'); }
  }
  if (!found) console.log('    لم يعمل التطبيق على هذه القاعدة بعد — طبيعي قبل أول تشغيل.');

  await pool.close();

  console.log('');
  line('═');
  if (fail === 0) {
    console.log('   ✓ السيرفر جاهز.  شغّل التطبيق:  node server.js');
  } else {
    console.log('   ✗ ' + fail + ' فحص فشل. عالجها قبل تشغيل التطبيق.');
  }
  if (warn) console.log('   ⚠ ' + warn + ' تنبيه.');
  line('═');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('\n  ✗ خطأ غير متوقّع: ' + err.message + '\n');
  process.exit(1);
});
