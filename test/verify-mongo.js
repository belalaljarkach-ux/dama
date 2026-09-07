/**
 * verify-mongo.js — إثبات أن البيانات محفوظة فعليًا في MongoDB.
 *
 * يتصل بقاعدة البيانات مباشرة، لا عبر التطبيق. إن ظهرت السجلات هنا فهي
 * مكتوبة على القرص في MongoDB، وليست في ذاكرة المتصفح أو الخادم.
 *
 *   node test/verify-mongo.js
 *
 * يقرأ نفس متغيّرات البيئة التي يقرأها التطبيق:
 *   MONGODB_URI   افتراضيًا mongodb://127.0.0.1:27017
 *   MONGODB_DB    افتراضيًا gate_log
 */

'use strict';

const { MongoClient } = require('mongodb');

const URI    = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DBNAME = process.env.MONGODB_DB  || 'gate_log';

const line = (c = '─') => console.log('  ' + c.repeat(58));

function safeUri(u) {
  return u.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });

  try {
    await client.connect();
    await client.db(DBNAME).command({ ping: 1 });
  } catch (err) {
    console.error('');
    console.error('  ✗ تعذّر الاتصال بـ MongoDB');
    console.error('    العنوان: ' + safeUri(URI));
    console.error('    السبب  : ' + err.message);
    console.error('');
    console.error('    تحقّق من أن الخدمة تعمل:  Get-Service MongoDB');
    console.error('');
    process.exit(1);
  }

  const db = client.db(DBNAME);

  console.log('');
  line('═');
  console.log('   التحقّق من حفظ البيانات في MongoDB');
  line('═');
  console.log('   الاتصال       ' + safeUri(URI));
  console.log('   قاعدة البيانات ' + DBNAME);
  console.log('');

  /* ---- 1. المجموعات وعدد المستندات ---- */
  const expected = ['vehicles', 'entries', 'settings', 'sessions', 'login_attempts', 'audit'];
  const present = (await db.listCollections().toArray()).map(c => c.name);

  console.log('  ▸ المجموعات وعدد المستندات في كل منها');
  line();
  for (const name of expected) {
    if (!present.includes(name)) {
      console.log('    ' + name.padEnd(16) + '—  (لم تُنشأ بعد)');
      continue;
    }
    const n = await db.collection(name).countDocuments();
    console.log('    ' + name.padEnd(16) + String(n).padStart(5) + '  مستند');
  }
  console.log('');

  /* ---- 2. الآليات المسجّلة ---- */
  const vehicles = await db.collection('vehicles').find({}).sort({ name: 1 }).toArray();
  console.log('  ▸ الآليات المسجّلة (' + vehicles.length + ')');
  line();
  if (!vehicles.length) {
    console.log('    لا توجد آليات بعد.');
  } else {
    vehicles.forEach(v => {
      console.log('    ' + String(v.name).padEnd(22) + 'كيلومتراج البداية: ' + v.baselineKm);
    });
  }
  console.log('');

  /* ---- 3. آخر العمليات ---- */
  const entries = await db.collection('entries')
    .find({}).sort({ dateKey: -1, departTime: -1 }).limit(10).toArray();
  const outNow = await db.collection('entries').countDocuments({ status: 'out' });

  console.log('  ▸ آخر العمليات المحفوظة (في الخارج الآن: ' + outNow + ')');
  line();
  if (!entries.length) {
    console.log('    لا توجد عمليات بعد.');
  } else {
    entries.forEach(e => {
      const state = e.status === 'out' ? 'في الخارج' : 'مكتملة ';
      const ret = e.returnTime ? ('عودة ' + e.returnTime) : '—';
      console.log('    ' + state + ' │ ' + String(e.vehicle).padEnd(16) +
                  ' │ ' + String(e.driver).padEnd(14) +
                  ' │ ' + e.dateKey + ' ' + e.departTime + ' │ ' + ret);
    });
  }
  console.log('');

  /* ---- 4. التواريخ والأوقات مخزّنة نصًّا لا كائنات Date ---- */
  console.log('  ▸ فحص أنواع الحقول (سبب علّة انزياح التوقيت القديمة)');
  line();
  if (entries.length) {
    const s = entries[0];
    const check = (label, value) => {
      const t = value instanceof Date ? 'Date ✗' : (typeof value + ' ✓');
      console.log('    ' + label.padEnd(16) + String(value).padEnd(24) + t);
    };
    check('dateKey', s.dateKey);
    check('departTime', s.departTime);
    check('createdAt', s.createdAt);
    console.log('');
    console.log('    المطلوب string في الثلاثة. أي Date هنا يعني عودة الخلل.');
  } else {
    console.log('    لا توجد عملية لفحصها.');
  }
  console.log('');

  /* ---- 5. كلمات المرور مُجزّأة لا نصًّا صريحًا ---- */
  console.log('  ▸ كلمات المرور');
  line();
  const settings = await db.collection('settings').find({}).toArray();
  if (!settings.length) {
    console.log('    لم تُنشأ بعد (لم يعمل الخادم على هذه القاعدة).');
  } else {
    settings.forEach(s => {
      const v = String(s.value);
      const hashed = v.startsWith('pbkdf2$');
      console.log('    ' + String(s._id).padEnd(14) + (hashed ? '✓ مُجزّأة  ' : '✗ نص صريح!') +
                  '  ' + v.slice(0, 34) + '…');
    });
  }
  console.log('');

  /* ---- 6. الفهارس التي تفرض قواعد العمل ---- */
  console.log('  ▸ الفهارس التي تفرض القواعد في قاعدة البيانات نفسها');
  line();
  if (present.includes('entries')) {
    const idx = await db.collection('entries').indexes();
    const openTrip = idx.find(i => i.name === 'one_open_trip_per_vehicle');
    console.log('    رحلة مفتوحة واحدة لكل آلية   ' + (openTrip ? '✓ موجود' : '✗ مفقود'));
  }
  if (present.includes('vehicles')) {
    const idx = await db.collection('vehicles').indexes();
    const uniqName = idx.find(i => i.unique && i.key && i.key.name === 1);
    console.log('    اسم آلية فريد                ' + (uniqName ? '✓ موجود' : '✗ مفقود'));
  }
  if (present.includes('sessions')) {
    const idx = await db.collection('sessions').indexes();
    const ttl = idx.find(i => i.expireAfterSeconds !== undefined);
    console.log('    حذف الجلسات المنتهية تلقائيًا ' + (ttl ? '✓ موجود' : '✗ مفقود'));
  }
  console.log('');

  /* ---- 7. آخر ما سُجّل في التدقيق ---- */
  const audit = await db.collection('audit').find({}).sort({ at: -1 }).limit(5).toArray();
  console.log('  ▸ آخر 5 عمليات في سجل التدقيق');
  line();
  if (!audit.length) {
    console.log('    لا شيء بعد.');
  } else {
    audit.forEach(a => {
      console.log('    ' + a.at.slice(0, 19).replace('T', ' ') + ' │ ' +
                  String(a.role).padEnd(8) + ' │ ' + a.action);
    });
  }

  console.log('');
  line('═');
  const total = entries.length + vehicles.length;
  console.log(total > 0
    ? '   ✓ البيانات محفوظة فعليًا في MongoDB.'
    : '   قاعدة البيانات فارغة — سجّل آلية وعملية ثم أعد التشغيل.');
  line('═');
  console.log('');

  await client.close();
})().catch(err => {
  console.error('خطأ غير متوقّع:', err);
  process.exit(1);
});
