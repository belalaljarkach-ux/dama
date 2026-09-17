/**
 * db-mongo.js — محرّك MongoDB لتطبيق سجل بوابة المجبل.
 *
 * يقدّم نفس واجهة db-sqlite.js بالضبط، لكن كل الدوال غير متزامنة (async)
 * لأن محرّك MongoDB لا يوفّر واجهة متزامنة. الخادم ينتظر (await) كل النداءات،
 * فيعمل المحرّكان بلا أي فرق في server.js.
 *
 * الاتصال يُضبط بمتغيّر البيئة MONGODB_URI، ويصلح لأي من الحالتين:
 *   • MongoDB مثبّت على سيرفر الشركة:  mongodb://127.0.0.1:27017
 *   • MongoDB Atlas السحابي:           mongodb+srv://user:pass@cluster.mongodb.net
 *
 * ملاحظتان تصميميتان مهمّتان:
 *
 * 1) المعرّفات: نستخدم حقل `id` نصّيًا من توليدنا كمفتاح أساسي (_id)، لا
 *    ObjectId. السبب أن التطبيق كله — والبيانات المُرحَّلة من النظام القديم —
 *    يتعامل مع معرّفات نصية، وخلط النوعين هو نفس العلّة التي كانت تُنتج صفوفًا
 *    مكررة في نسخة Google Sheets.
 *
 * 2) التواريخ والأوقات تبقى نصوصًا (‏"YYYY-MM-DD" و "HH:MM") ولا تُخزَّن أبدًا
 *    كنوع Date. لو خُزِّنت كـ Date لعاد انزياح التوقيت الذي أفسد حسابات المدة
 *    في النسخة القديمة. حقول الطوابع الزمنية (createdAt وغيرها) نصوص ISO أيضًا.
 */

'use strict';

const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

let MongoClient;
try {
  ({ MongoClient } = require('mongodb'));
} catch (err) {
  console.error('');
  console.error('  ✗ حزمة mongodb غير مثبّتة.');
  console.error('    ثبّتها بالأمر:  npm install mongodb');
  console.error('');
  process.exit(1);
}

const SESSION_HOURS = 12;
const LOCKOUT_TRIES = 8;
const LOCKOUT_MIN   = 10;

let client = null;
let db = null;
let col = {};
let heartbeatWarned = false;   // حتى لا يمتلئ السجل بتحذير متكرر أثناء انقطاع واحد

/* ------------------------------------------------------------- الإعداد */

/**
 * يترجم أخطاء الاتصال الغامضة إلى سبب محدّد وخطوة عملية.
 * أخطاء Atlas تحديدًا تصل بصيغة طويلة لا تقول للمستخدم ماذا يفعل.
 */
function explainConnectionError(err, isCloud) {
  const msg = String(err && err.message || err);

  if (/not authorized|Authentication failed|bad auth/i.test(msg)) {
    return {
      cause: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      fix: isCloud
        ? ['راجع Database Access في Atlas وتأكّد من المستخدم وكلمة مروره.',
           'إن كانت كلمة المرور تحتوي رموزًا مثل @ أو / أو : فيجب ترميزها',
           'داخل الرابط (‏@ تصبح %40 و / تصبح %2F و : تصبح %3A).']
        : ['راجع المستخدم وكلمة المرور في رابط الاتصال.']
    };
  }
  if (/IP that isn'?t whitelisted|not allowed to access|IP address is not allowed/i.test(msg)) {
    return {
      cause: 'عنوان IP الخاص بهذا السيرفر غير مسموح به في Atlas.',
      fix: ['افتح Atlas → Network Access → Add IP Address،',
            'وأضف عنوان IP العام لشبكة الشركة.',
            'لمعرفة العنوان العام من السيرفر: curl https://api.ipify.org',
            'تنبيه: إن كان اشتراك الإنترنت بعنوان متغيّر، سينقطع الاتصال',
            'كلما تغيّر العنوان — اطلب من مزوّد الخدمة عنوانًا ثابتًا.']
    };
  }
  if (/ENOTFOUND|getaddrinfo|querySrv|EAI_AGAIN/i.test(msg)) {
    return {
      cause: isCloud
        ? 'تعذّر ترجمة اسم نطاق Atlas — غالبًا لا يوجد اتصال بالإنترنت أو DNS محجوب.'
        : 'تعذّر ترجمة اسم المضيف في رابط الاتصال.',
      fix: isCloud
        ? ['تأكّد من وصول السيرفر للإنترنت.',
           'تأكّد أن جدار حماية الشركة يسمح بمنفذ 27017 الصادر (outbound)',
           'وباستعلامات DNS من نوع SRV.']
        : ['راجع اسم المضيف في رابط الاتصال.']
    };
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return {
      cause: 'رُفض الاتصال — لا توجد قاعدة بيانات تستمع على هذا العنوان.',
      fix: ['تحقّق من تشغيل الخدمة:  Get-Service MongoDB']
    };
  }
  if (/timed out|ETIMEDOUT|Server selection timed out/i.test(msg)) {
    return {
      cause: 'انتهت مهلة الاتصال قبل الوصول إلى قاعدة البيانات.',
      fix: isCloud
        ? ['تحقّق من الإنترنت، ومن أن المنفذ 27017 الصادر غير محجوب،',
           'ومن أن IP السيرفر مضاف في Network Access داخل Atlas.']
        : ['تحقّق من تشغيل خدمة MongoDB ومن إعدادات جدار الحماية.']
    };
  }
  return { cause: msg, fix: [] };
}

async function init(options) {
  const opts   = options || {};
  const uri    = opts.uri    || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = opts.dbName || process.env.MONGODB_DB  || 'gate_log';
  const isCloud = opts.isCloud !== undefined
    ? opts.isCloud
    : (/^mongodb\+srv:/i.test(uri) || /mongodb\.net/i.test(uri));

  // القاعدة السحابية تحتاج مهلًا أطول من قاعدة محلية: كل عملية رحلة عبر
  // الإنترنت لا استدعاء على المضيف نفسه. مهل قصيرة هنا تُنتج أعطالًا وهمية
  // عند أول بطء في الشبكة.
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: isCloud ? 20000 : 8000,
    connectTimeoutMS:         isCloud ? 20000 : 8000,
    socketTimeoutMS:          isCloud ? 60000 : 30000,
    // إعادة المحاولة تلقائيًا مرة واحدة عند الانقطاع العابر — شائع عبر الإنترنت.
    retryWrites: true,
    retryReads: true,
    // اتصال دافئ دائم حتى لا تدفع كل عملية ثمن بناء الاتصال من جديد.
    minPoolSize: isCloud ? 2 : 1,
    maxPoolSize: 10,
    // ضغط البيانات يقلّل استهلاك الإنترنت على وصلة الشركة.
    compressors: isCloud ? ['zlib'] : undefined
  });

  // تسجيل انقطاعات الاتصال، فبدونها يبدو التطبيق «بطيئًا» بلا سبب ظاهر.
  client.on('serverHeartbeatFailed', ev => {
    if (!heartbeatWarned) {
      heartbeatWarned = true;
      console.warn('  ⚠ تعذّر الوصول إلى قاعدة البيانات: ' +
                   String(ev.failure && ev.failure.message || '').slice(0, 120));
    }
  });
  client.on('serverHeartbeatSucceeded', () => {
    if (heartbeatWarned) {
      heartbeatWarned = false;
      console.log('  ✓ عاد الاتصال بقاعدة البيانات ' + new Date().toLocaleTimeString('ar-EG'));
    }
  });

  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
  } catch (err) {
    const { cause, fix } = explainConnectionError(err, isCloud);
    const e = new Error(cause);
    e.fixSteps = fix;
    throw e;
  }
  db = client.db(dbName);

  col = {
    vehicles: db.collection('vehicles'),
    entries:  db.collection('entries'),
    settings: db.collection('settings'),
    sessions: db.collection('sessions'),
    attempts: db.collection('login_attempts'),
    audit:    db.collection('audit'),
    users:    db.collection('users'),
    drivers:  db.collection('drivers'),
    fuelFills:  db.collection('fuel_fills'),
    fuelSupply: db.collection('fuel_supply'),
    guestVisits: db.collection('guest_visits')
  };

  // الفهارس. `unique` على اسم الآلية يجعل منع التكرار قاعدة في قاعدة البيانات
  // نفسها، لا مجرّد فحص في الكود يمكن أن يسبقه طلب متزامن.
  await col.vehicles.createIndex({ name: 1 }, { unique: true });
  // اسم مستخدم فريد لكل حساب شخصي — نفس مبدأ فهرس اسم الآلية أعلاه.
  await col.users.createIndex({ username: 1 }, { unique: true });
  // اسم فريد لكل سائق — نفس المبدأ.
  await col.drivers.createIndex({ name: 1 }, { unique: true });
  await col.entries.createIndex({ status: 1 });
  await col.entries.createIndex({ dateKey: -1, departTime: -1 });
  await col.entries.createIndex({ vehicle: 1 });
  await col.entries.createIndex({ updatedAt: -1 });
  await col.audit.createIndex({ at: -1 });

  // فهرس زمني يحذف الجلسات المنتهية تلقائيًا دون أي عمل من التطبيق.
  await col.sessions.createIndex({ expiresAtDate: 1 }, { expireAfterSeconds: 0 });

  // منع خروج آلية هي أصلًا في الخارج، مفروضًا على مستوى قاعدة البيانات:
  // فهرس فريد جزئي يسمح بصف واحد فقط بحالة "out" لكل آلية.
  await col.entries.createIndex(
    { vehicle: 1 },
    { unique: true, partialFilterExpression: { status: 'out' }, name: 'one_open_trip_per_vehicle' }
  );

  // مفتاح التعريف: يجعل إعادة إرسال الطلب بعد انقطاع الشبكة آمنة.
  await col.entries.createIndex(
    { clientRef: 1 },
    { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'unique_client_ref' }
  );

  // فهارس وحدة المازوت — لا قيد تفرّد هنا (انظر تعليق الجدول في db-sqlite.js)،
  // فقط تسريع الاستعلام بالتاريخ والآلية كما في entries.
  await col.fuelFills.createIndex({ dateKey: -1 });
  await col.fuelFills.createIndex({ vehicle: 1 });
  await col.fuelSupply.createIndex({ dateKey: -1 });

  // سجلّ آليات ضيوف: فهرس الحالة فقط، كما في db-sqlite.js (لا قيد تفرّد هنا).
  await col.guestVisits.createIndex({ status: 1 });

  // مفاتيح تعريف لكل نماذج الإدخال — تسمح بإعادة الإرسال الآمنة بعد انقطاع
  // الشبكة (نفس مبدأ client_ref في entries) لشاشات الآليات والسائقين والمازوت.
  await col.vehicles.createIndex(
    { clientRef: 1 },
    { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'unique_client_ref' }
  );
  await col.drivers.createIndex(
    { clientRef: 1 },
    { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'unique_client_ref' }
  );
  await col.fuelFills.createIndex(
    { clientRef: 1 },
    { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'unique_client_ref' }
  );
  await col.fuelSupply.createIndex(
    { clientRef: 1 },
    { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } }, name: 'unique_client_ref' }
  );

  const initialPasswords = await seedUsers(opts.adminPassword);
  const safeUri = uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
  return { location: `${safeUri}/${dbName}`, initialPasswords };
}

async function close() {
  if (client) { await client.close(); client = null; db = null; col = {}; }
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
  const doc = await col.settings.findOne({ _id: key });
  return doc ? doc.value : null;
}

async function setSetting(key, value) {
  await col.settings.updateOne({ _id: key }, { $set: { value: String(value) } }, { upsert: true });
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
  const noUsersYet = (await col.users.countDocuments({})) === 0;
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

function userOut(doc) {
  if (!doc) return null;
  return { id: doc.id, username: doc.username, role: doc.role, fullName: doc.fullName || '', active: !!doc.active, createdAt: doc.createdAt };
}

async function getUser(id) {
  return userOut(await col.users.findOne({ _id: String(id) }));
}

async function getUserByUsername(username) {
  return userOut(await col.users.findOne({ username: String(username).trim() }));
}

async function listUsers() {
  const rows = await col.users.find({}).sort({ role: 1, username: 1 }).toArray();
  return rows.map(userOut);
}

async function insertUser(data) {
  const id = newId('u');
  const doc = {
    _id: id, id,
    username: String(data.username).trim(),
    passwordHash: data.passwordHash,
    role: data.role,
    fullName: data.fullName || '',
    active: true,
    createdAt: new Date().toISOString()
  };
  try {
    await col.users.insertOne(doc);
  } catch (err) {
    // 11000 = خرق فهرس فريد — اسم المستخدم هذا مأخوذ بالفعل.
    if (err.code === 11000) {
      const e = new Error('اسم المستخدم هذا مستخدم بالفعل.');
      e.duplicateUsername = true;
      throw e;
    }
    throw err;
  }
  return userOut(doc);
}

async function updateUser(id, data) {
  const existing = await col.users.findOne({ _id: String(id) });
  if (!existing) return null;
  const res = await col.users.findOneAndUpdate(
    { _id: String(id) },
    { $set: {
        fullName: data.fullName !== undefined ? data.fullName : existing.fullName,
        role: data.role !== undefined ? data.role : existing.role
    } },
    { returnDocument: 'after' }
  );
  return userOut(res);
}

async function setUserActive(id, active) {
  const res = await col.users.findOneAndUpdate(
    { _id: String(id) },
    { $set: { active: !!active } },
    { returnDocument: 'after' }
  );
  return userOut(res);
}

async function changeUserPassword(id, plain) {
  if (typeof plain !== 'string' || plain.length < 6) {
    throw new Error('كلمة المرور يجب أن تكون 6 محارف على الأقل');
  }
  const res = await col.users.updateOne({ _id: String(id) }, { $set: { passwordHash: hashPassword(plain) } });
  if (res.matchedCount === 0) throw new Error('المستخدم غير موجود');
}

async function checkLockout(ip) {
  const doc = await col.attempts.findOne({ _id: ip });
  if (!doc || !doc.lockedUntil) return null;
  const until = new Date(doc.lockedUntil);
  if (until > new Date()) return Math.ceil((until - new Date()) / 60000);
  await col.attempts.deleteOne({ _id: ip });
  return null;
}

async function noteLoginFailure(ip) {
  const doc = await col.attempts.findOneAndUpdate(
    { _id: ip },
    { $inc: { fails: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const fails = doc ? doc.fails : 1;
  if (fails >= LOCKOUT_TRIES) {
    await col.attempts.updateOne({ _id: ip },
      { $set: { lockedUntil: new Date(Date.now() + LOCKOUT_MIN * 60000).toISOString() } });
  }
  return { fails, remaining: Math.max(0, LOCKOUT_TRIES - fails) };
}

async function clearLoginFailures(ip) {
  await col.attempts.deleteOne({ _id: ip });
}

async function login(username, password, ip) {
  const row = await col.users.findOne({ username: String(username).trim() });
  if (!row || !row.active || !verifyPassword(password, row.passwordHash)) return null;
  await clearLoginFailures(ip);
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_HOURS * 3600000);
  await col.sessions.insertOne({
    _id: token, userId: row.id, username: row.username, role: row.role,
    createdAt: now.toISOString(),
    expiresAt: exp.toISOString(),
    expiresAtDate: exp            // نوع Date، يحتاجه فهرس الحذف التلقائي وحده
  });
  return { token, userId: row.id, username: row.username, role: row.role, expiresAt: exp.toISOString() };
}

async function sessionUser(token) {
  if (!token) return null;
  const doc = await col.sessions.findOne({ _id: token });
  if (!doc) return null;
  if (new Date(doc.expiresAt) <= new Date()) {
    await col.sessions.deleteOne({ _id: token });
    return null;
  }
  return { userId: doc.userId, username: doc.username, role: doc.role };
}

async function logout(token) {
  if (token) await col.sessions.deleteOne({ _id: token });
}

async function purgeExpiredSessions() {
  // فهرس TTL يقوم بهذا تلقائيًا؛ نبقي النداء لتطابق الواجهة ولتنظيف فوري.
  await col.sessions.deleteMany({ expiresAt: { $lte: new Date().toISOString() } });
}

/* -------------------------------------------------------------- التدقيق */

// actor: {username, role} — أو نص دور مجرّد (توافقًا مع نداءات قديمة محتملة).
async function audit(actor, ip, action, entityId, detail) {
  const username = (actor && actor.username) || '-';
  const role = (actor && actor.role) || actor || '-';
  await col.audit.insertOne({
    at: new Date().toISOString(),
    username, role, ip: ip || '-',
    action, entityId: entityId || null,
    detail: detail ? JSON.stringify(detail) : null
  });
}

async function listAudit(limit) {
  const n = Math.min(Number(limit) || 200, 1000);
  const rows = await col.audit.find({}).sort({ at: -1 }).limit(n).toArray();
  // نُعيد نفس أسماء الحقول التي تتوقّعها الواجهة من محرّك SQLite.
  return rows.map(r => ({
    id: String(r._id), at: r.at, username: r.username || '-', role: r.role, ip: r.ip,
    action: r.action, entity_id: r.entityId, detail: r.detail
  }));
}

/* --------------------------------------------------------- تحويل الصفوف */

function stripId(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

/* ---------------------------------------------------------- الاستعلامات */

async function listVehicles() {
  const rows = await col.vehicles.find({}).sort({ name: 1 }).toArray();
  return rows.map(stripId);
}

async function listEntries(days) {
  const n = Number(days);
  const sort = { dateKey: -1, departTime: -1 };
  if (!n || n <= 0) {
    return (await col.entries.find({}).sort(sort).toArray()).map(stripId);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const rows = await col.entries
    .find({ $or: [{ status: 'out' }, { dateKey: { $gte: from } }] })
    .sort(sort).toArray();
  return rows.map(stripId);
}

async function getEntry(id) {
  return stripId(await col.entries.findOne({ _id: String(id) }));
}

async function getEntryByClientRef(ref) {
  if (!ref) return null;
  return stripId(await col.entries.findOne({ clientRef: String(ref) }));
}

async function getVehicle(id) {
  return stripId(await col.vehicles.findOne({ _id: String(id) }));
}

async function getVehicleByName(name) {
  return stripId(await col.vehicles.findOne({ name: String(name).trim() }));
}

async function getVehicleByClientRef(ref) {
  if (!ref) return null;
  return stripId(await col.vehicles.findOne({ clientRef: String(ref) }));
}

async function lastKmForVehicle(name) {
  const v = String(name).trim();
  const row = await col.entries
    .find({ vehicle: v, status: 'done', km: { $ne: null } })
    .sort({ dateKey: -1, departTime: -1 }).limit(1).next();
  if (row && row.km !== null && row.km !== undefined) return Number(row.km);
  const veh = await getVehicleByName(v);
  return veh ? veh.baselineKm : null;
}

async function vehicleIsOut(name) {
  const r = await col.entries.findOne({ vehicle: String(name).trim(), status: 'out' });
  if (!r) return null;
  return { id: r._id, driver: r.driver, customer: r.customer, departTime: r.departTime };
}

async function countEntriesForVehicle(name) {
  return col.entries.countDocuments({ vehicle: String(name).trim() });
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

/* ------------------------------------------------------- عمليات الكتابة */

async function insertEntry(data) {
  const now = new Date().toISOString();
  const id = newId('t');
  const doc = {
    _id: id, id,
    dateKey: data.dateKey, vehicle: data.vehicle, driver: data.driver,
    customer: data.customer, departTime: data.departTime,
    notesOut: data.notesOut || '',
    returnDate: null, returnTime: null, km: null,
    loadQty: data.loadQty === undefined || data.loadQty === null ? null : Number(data.loadQty),
    technicianName: data.technicianName || null,
    technicianAssistant: data.technicianAssistant || null,
    manualPour: !!data.manualPour,
    notesIn: '',
    status: 'out', createdAt: now, updatedAt: now,
    returnClientRef: null
  };
  if (data.clientRef) doc.clientRef = String(data.clientRef);
  try {
    await col.entries.insertOne(doc);
  } catch (err) {
    // 11000 = خرق فهرس فريد. هنا يعني أن الآلية خرجت أصلًا — سبقنا طلب آخر.
    if (err.code === 11000) {
      // خرق مفتاح التعريف يعني إعادة إرسال لطلب نجح أصلًا — لا خطأ.
      if (/clientRef|unique_client_ref/.test(String(err.message))) {
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
  return stripId(doc);
}

/**
 * تسجيل العودة. التحديث الشرطي (status: 'out' داخل الفلتر) ذرّي في MongoDB:
 * إن سجّل جهاز آخر العودة قبل جزء من الثانية، لا يطابق هذا الطلب أي مستند
 * فيفشل بدل أن يكتب فوق ما سُجِّل.
 */
async function closeEntry(id, data) {
  const existing = await col.entries.findOne({ _id: String(id) });
  if (!existing) return { error: 'notfound' };

  const res = await col.entries.findOneAndUpdate(
    { _id: String(id), status: 'out' },
    { $set: {
        returnDate: data.returnDate, returnTime: data.returnTime,
        km: Number(data.km), notesIn: data.notesIn || '',
        status: 'done', updatedAt: new Date().toISOString(),
        returnClientRef: data.clientRef || null
    } },
    { returnDocument: 'after' }
  );
  if (!res) return { error: 'already', entry: stripId(existing) };
  return { entry: stripId(res) };
}

async function updateEntry(id, data) {
  const existing = await col.entries.findOne({ _id: String(id) });
  if (!existing) return null;
  const done = data.returnTime && data.km !== null && data.km !== undefined && data.km !== '';

  const res = await col.entries.findOneAndUpdate(
    { _id: String(id) },
    { $set: {
        dateKey: data.dateKey, vehicle: data.vehicle, driver: data.driver,
        customer: data.customer, departTime: data.departTime,
        notesOut: data.notesOut || '',
        loadQty: data.loadQty === undefined || data.loadQty === null || data.loadQty === '' ? null : Number(data.loadQty),
        technicianName: data.technicianName || null,
        technicianAssistant: data.technicianAssistant || null,
        manualPour: !!data.manualPour,
        returnDate: done ? (data.returnDate || data.dateKey) : null,
        returnTime: done ? data.returnTime : null,
        km:         done ? Number(data.km) : null,
        notesIn:    done ? (data.notesIn || '') : '',
        status:     done ? 'done' : 'out',
        updatedAt:  new Date().toISOString()
    } },
    { returnDocument: 'after' }
  );
  return stripId(res);
}

async function deleteEntry(id) {
  const res = await col.entries.deleteOne({ _id: String(id) });
  return res.deletedCount > 0;
}

async function insertVehicle(name, baselineKm, type, fuelTankQty, workHoursBaseline, clientRef) {
  const id = newId('v');
  const doc = {
    _id: id, id,
    name: String(name).trim(),
    baselineKm: Number(baselineKm),
    type: type || null,
    fuelTankQty: fuelTankQty === undefined || fuelTankQty === null || fuelTankQty === '' ? null : Number(fuelTankQty),
    workHoursBaseline: workHoursBaseline === undefined || workHoursBaseline === null || workHoursBaseline === '' ? null : Number(workHoursBaseline),
    registeredAt: new Date().toISOString()
  };
  if (clientRef) doc.clientRef = String(clientRef);
  try {
    await col.vehicles.insertOne(doc);
  } catch (err) {
    if (err.code === 11000) {
      // خرق مفتاح التعريف يعني إعادة إرسال لطلب نجح أصلًا — لا خطأ.
      if (/clientRef|unique_client_ref/.test(String(err.message))) {
        const e = new Error('طلب مُعاد.');
        e.duplicateClientRef = true;
        throw e;
      }
      // تحسّبًا فقط: server.js يتحقّق من الاسم مسبقًا ويُرجع 409 بنفسه (انظر
      // مسار POST /api/vehicles)، لكن نُعلِّم الخطأ هنا أيضًا دفاعًا عن النفس.
      const e = new Error('هذه الآلية مسجّلة مسبقًا.');
      e.duplicateName = true;
      throw e;
    }
    throw err;
  }
  return stripId(doc);
}

/**
 * تعديل آلية. إعادة التسمية تُحدِّث كل سجلاتها السابقة، وإلا انفصل تاريخها
 * القديم عن اسمها الجديد وضاعت حسابات المسافة.
 *
 * تُنفَّذ داخل معاملة (transaction) إن كان خادم MongoDB يدعمها — أي عند
 * تشغيله كـ replica set أو على Atlas. على خادم مفرد بلا replica set تُنفَّذ
 * العمليتان تباعًا؛ الخطر عمليًّا معدوم لأن إعادة تسمية آلية إجراء نادر
 * يقوم به المدير وحده.
 */
async function updateVehicle(id, name, baselineKm, type, fuelTankQty, workHoursBaseline) {
  const old = await col.vehicles.findOne({ _id: String(id) });
  if (!old) return null;
  const newName = String(name).trim();
  const now = new Date().toISOString();

  const apply = async (session) => {
    const opts = session ? { session } : {};
    await col.vehicles.updateOne({ _id: String(id) },
      { $set: {
          name: newName, baselineKm: Number(baselineKm),
          type: type || null,
          fuelTankQty: fuelTankQty === undefined || fuelTankQty === null || fuelTankQty === '' ? null : Number(fuelTankQty),
          workHoursBaseline: workHoursBaseline === undefined || workHoursBaseline === null || workHoursBaseline === '' ? null : Number(workHoursBaseline)
      } }, opts);
    if (old.name !== newName) {
      await col.entries.updateMany({ vehicle: old.name },
        { $set: { vehicle: newName, updatedAt: now } }, opts);
    }
  };

  let session = null;
  try {
    session = client.startSession();
    await session.withTransaction(() => apply(session));
  } catch (err) {
    // المعاملات غير متاحة على خادم مفرد — ننفّذ بلا معاملة.
    await apply(null);
  } finally {
    if (session) await session.endSession();
  }
  return getVehicle(id);
}

async function deleteVehicle(id) {
  const res = await col.vehicles.deleteOne({ _id: String(id) });
  return res.deletedCount > 0;
}

/* ---------------------------------------------------------- السائقون */

async function listDrivers() {
  const rows = await col.drivers.find({}).sort({ name: 1 }).toArray();
  return rows.map(stripId);
}

async function getDriverByName(name) {
  return stripId(await col.drivers.findOne({ name: String(name).trim() }));
}

async function getDriverByClientRef(ref) {
  if (!ref) return null;
  return stripId(await col.drivers.findOne({ clientRef: String(ref) }));
}

async function insertDriver(data) {
  const id = newId('d');
  const doc = {
    _id: id, id,
    name: String(data.name).trim(),
    allowedTypes: data.allowedTypes || [],
    createdAt: new Date().toISOString()
  };
  if (data.clientRef) doc.clientRef = String(data.clientRef);
  try {
    await col.drivers.insertOne(doc);
  } catch (err) {
    if (err.code === 11000) {
      // خرق مفتاح التعريف يعني إعادة إرسال لطلب نجح أصلًا — لا خطأ.
      if (/clientRef|unique_client_ref/.test(String(err.message))) {
        const e = new Error('طلب مُعاد.');
        e.duplicateClientRef = true;
        throw e;
      }
      const e = new Error('هذا السائق مسجّل مسبقًا.');
      e.duplicateDriverName = true;
      throw e;
    }
    throw err;
  }
  return stripId(doc);
}

async function updateDriver(id, data) {
  const existing = await col.drivers.findOne({ _id: String(id) });
  if (!existing) return null;
  const newName = String(data.name).trim();
  let res;
  try {
    res = await col.drivers.findOneAndUpdate(
      { _id: String(id) },
      { $set: { name: newName, allowedTypes: data.allowedTypes || [] } },
      { returnDocument: 'after' }
    );
  } catch (err) {
    if (err.code === 11000) {
      const e = new Error('يوجد سائق آخر بنفس الاسم.');
      e.duplicateDriverName = true;
      throw e;
    }
    throw err;
  }
  return stripId(res);
}

async function deleteDriver(id) {
  const res = await col.drivers.deleteOne({ _id: String(id) });
  return res.deletedCount > 0;
}

/* ---------------------------------------------------------- وحدة المازوت */

// حقلا tank و dispenserMeter أُضيفا لاحقًا (3 خزانات ثابتة + عدّاد كازية عام)؛
// المستندات القديمة لا تحملهما، فنطبّق نفس الافتراض الذي يطبّقه fuelFillOut
// في db-sqlite.js عند كل قراءة بدل ترحيل كل مستند قديم.
function fuelFillOut(doc) {
  if (!doc) return null;
  const out = stripId(doc);
  out.tank = out.tank || 'tank1';
  out.dispenserMeter = out.dispenserMeter === null || out.dispenserMeter === undefined ? null : Number(out.dispenserMeter);
  return out;
}

function fuelSupplyOut(doc) {
  if (!doc) return null;
  const out = stripId(doc);
  out.tank = out.tank || 'tank1';
  return out;
}

async function listFuelFills(days) {
  const n = Number(days);
  const sort = { dateKey: -1, time: -1 };
  if (!n || n <= 0) {
    return (await col.fuelFills.find({}).sort(sort).toArray()).map(fuelFillOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const rows = await col.fuelFills.find({ dateKey: { $gte: from } }).sort(sort).toArray();
  return rows.map(fuelFillOut);
}

async function getFuelFillByClientRef(ref) {
  if (!ref) return null;
  return fuelFillOut(await col.fuelFills.findOne({ clientRef: String(ref) }));
}

async function insertFuelFill(data) {
  const id = newId('f');
  const doc = {
    _id: id, id,
    vehicle: String(data.vehicle).trim(),
    km: Number(data.km),
    qty: Number(data.qty),
    workHours: data.workHours === undefined || data.workHours === null || data.workHours === '' ? null : Number(data.workHours),
    tank: String(data.tank || 'tank1'),
    dispenserMeter: data.dispenserMeter === undefined || data.dispenserMeter === null || data.dispenserMeter === '' ? null : Number(data.dispenserMeter),
    dateKey: data.dateKey, time: data.time,
    createdAt: new Date().toISOString(), createdBy: data.createdBy || null
  };
  if (data.clientRef) doc.clientRef = String(data.clientRef);
  try {
    await col.fuelFills.insertOne(doc);
  } catch (err) {
    // لا قاعدة تفرّد أخرى على هذه المجموعة — أي خرق فهرس فريد هو مفتاح
    // التعريف بالضرورة.
    if (err.code === 11000) {
      const e = new Error('طلب مُعاد.');
      e.duplicateClientRef = true;
      throw e;
    }
    throw err;
  }
  return fuelFillOut(doc);
}

// آخر قراءة عدّاد ساعات عمل لآلية معيّنة — نفس دور lastKmForVehicle، لكن
// لعدّاد ساعات العمل بدل الكيلومتراج، والافتراض الأول هو workHoursBaseline
// المسجَّل عند تسجيل الآلية (المرحلة 5) لا صفر.
async function lastWorkHoursForVehicle(name) {
  const v = String(name).trim();
  const row = await col.fuelFills
    .find({ vehicle: v, workHours: { $ne: null } })
    .sort({ dateKey: -1, time: -1, createdAt: -1 }).limit(1).next();
  if (row && row.workHours !== null && row.workHours !== undefined) return Number(row.workHours);
  const veh = await getVehicleByName(v);
  return veh ? veh.workHoursBaseline : null;
}

async function listFuelSupply(days) {
  const n = Number(days);
  const sort = { dateKey: -1, time: -1 };
  if (!n || n <= 0) {
    return (await col.fuelSupply.find({}).sort(sort).toArray()).map(fuelSupplyOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const rows = await col.fuelSupply.find({ dateKey: { $gte: from } }).sort(sort).toArray();
  return rows.map(fuelSupplyOut);
}

async function getFuelSupplyByClientRef(ref) {
  if (!ref) return null;
  return fuelSupplyOut(await col.fuelSupply.findOne({ clientRef: String(ref) }));
}

async function insertFuelSupply(data) {
  const id = newId('s');
  const doc = {
    _id: id, id,
    meterReading: Number(data.meterReading),
    tank: String(data.tank || 'tank1'),
    dateKey: data.dateKey, time: data.time,
    createdAt: new Date().toISOString(), createdBy: data.createdBy || null
  };
  if (data.clientRef) doc.clientRef = String(data.clientRef);
  try {
    await col.fuelSupply.insertOne(doc);
  } catch (err) {
    // لا قاعدة تفرّد أخرى على هذه المجموعة — أي خرق فهرس فريد هو مفتاح
    // التعريف بالضرورة.
    if (err.code === 11000) {
      const e = new Error('طلب مُعاد.');
      e.duplicateClientRef = true;
      throw e;
    }
    throw err;
  }
  return fuelSupplyOut(doc);
}

// آخر قراءة عدّاد لخزان معيّن — نفس دور lastKmForVehicle، لكن لكل خزان من
// الثلاثة الثابتة على حدة (3 خزانات ثابتة دائمًا، لا تُدار من الأدمن).
async function lastFuelMeterReading(tank) {
  const row = await col.fuelSupply
    .find({ tank: String(tank) }).sort({ dateKey: -1, time: -1, createdAt: -1 }).limit(1).next();
  if (row) return Number(row.meterReading);
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
  const row = await col.fuelFills
    .find({ dispenserMeter: { $ne: null } })
    .sort({ dateKey: -1, time: -1, createdAt: -1 }).limit(1).next();
  return row ? Number(row.dispenserMeter) : null;
}

/* ---------------------------------------------------------- آليات الضيوف */

// الضيوف بالموقع الآن دائمًا + من خرج خلال آخر `days` يومًا — نفس مبدأ listEntries.
async function listGuestVisits(days) {
  const n = Number(days);
  const sort = { dateIn: -1, timeIn: -1 };
  if (!n || n <= 0) {
    return (await col.guestVisits.find({}).sort(sort).toArray()).map(stripId);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const rows = await col.guestVisits
    .find({ $or: [{ status: 'in' }, { dateIn: { $gte: from } }] })
    .sort(sort).toArray();
  return rows.map(stripId);
}

async function insertGuestVisit(data) {
  const id = newId('g');
  const doc = {
    _id: id, id,
    vehicleDesc: String(data.vehicleDesc).trim(),
    purpose: String(data.purpose).trim(),
    dateIn: data.dateIn, timeIn: data.timeIn,
    dateOut: null, timeOut: null,
    status: 'in', createdBy: data.createdBy || null
  };
  await col.guestVisits.insertOne(doc);
  return stripId(doc);
}

/**
 * إغلاق زيارة ضيف. نفس مبدأ closeEntry: تحديث شرطي (status: 'in' داخل الفلتر)
 * ذرّي في MongoDB بلا حاجة لمعاملة صريحة — لكن هنا بلا فحص findOne أوّلي منفصل
 * لأن سجلّ الضيوف أقل تنافسًا بكثير من entries (see closeEntry أعلاه)؛ الفحص
 * الوحيد اللازم هو: هل المستند موجود؟ فإن لم يوجد أصلًا فالخطأ notfound، وإن
 * وُجد لكن حالته لم تعد 'in' فالخطأ already.
 */
async function closeGuestVisit(id, data) {
  const existing = await col.guestVisits.findOne({ _id: String(id) });
  if (!existing) return { error: 'notfound' };

  const res = await col.guestVisits.findOneAndUpdate(
    { _id: String(id), status: 'in' },
    { $set: { dateOut: data.dateOut, timeOut: data.timeOut, status: 'out' } },
    { returnDocument: 'after' }
  );
  if (!res) return { error: 'already', visit: stripId(existing) };
  return { visit: stripId(res) };
}

/* ------------------------------------------------- النسخ الاحتياطي */

/**
 * نسخة احتياطية بصيغة JSON لكل المجموعات.
 *
 * ملاحظة مهمّة: هذه ليست بديلًا كاملًا عن `mongodump`. هي لقطة كافية
 * لاستعادة بيانات التطبيق (وسكربت restore-mongo.js يعيدها)، لكن سياسة النسخ
 * الاحتياطي الرسمية للشركة يجب أن تعتمد على mongodump أو نسخ Atlas التلقائية.
 */
async function backupTo(file) {
  const target = file.replace(/\.db$/, '.json');
  const dump = {
    exportedAt: new Date().toISOString(),
    format: 'gate-log-mongo-backup-v1',
    vehicles: await col.vehicles.find({}).toArray(),
    entries:  await col.entries.find({}).toArray(),
    settings: await col.settings.find({}).toArray(),
    audit:    await col.audit.find({}).sort({ at: -1 }).limit(5000).toArray()
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
