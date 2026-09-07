/**
 * db.js — طبقة قاعدة البيانات لتطبيق سجل بوابة المجبل.
 *
 * تستخدم SQLite المدمجة في Node.js (node:sqlite) — لا تحتاج أي تثبيت إضافي
 * ولا خادم قواعد بيانات منفصل. كل البيانات في ملف واحد: data/gate-log.db
 *
 * كل الأوقات والتواريخ تُخزَّن كنصوص (TEXT) بصيغة "YYYY-MM-DD" و "HH:MM".
 * هذا يلغي نهائيًا مشكلة تحويل Google Sheets للتواريخ إلى كائنات Date
 * وانزياح التوقيت الذي كان يفسد حساب المدة والمسافة.
 */

'use strict';

const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('');
  console.error('  ✗ نسخة Node.js لديك لا تحتوي على وحدة node:sqlite.');
  console.error('    هذا البرنامج يحتاج Node.js 22.5 أو أحدث (يُفضَّل 24 LTS).');
  console.error('    النسخة الحالية: ' + process.version);
  console.error('    التحميل: https://nodejs.org/');
  console.error('');
  process.exit(1);
}

const SESSION_HOURS  = 12;      // مدة صلاحية الجلسة قبل طلب كلمة المرور مجددًا
const LOCKOUT_TRIES  = 8;       // عدد المحاولات الخاطئة قبل الحظر المؤقت
const LOCKOUT_MIN    = 10;      // مدة الحظر بالدقائق

let db = null;

/* ------------------------------------------------------------- الإعداد */

// يقبل نفس شكل الخيارات الذي يقبله محرّك Mongo، ليستدعيهما الخادم بنفس السطر.
function init(options) {
  const dataDir = (options && options.dataDir) || options;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'gate-log.db');
  db = new DatabaseSync(file);

  // WAL يسمح بقراءات متزامنة أثناء الكتابة — مهم مع عدة أجهزة على البوابة.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      baseline_km   REAL NOT NULL,
      registered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id          TEXT PRIMARY KEY,
      date_key    TEXT NOT NULL,
      vehicle     TEXT NOT NULL,
      driver      TEXT NOT NULL,
      customer    TEXT NOT NULL,
      depart_time TEXT NOT NULL,
      notes_out   TEXT NOT NULL DEFAULT '',
      return_date TEXT,
      return_time TEXT,
      km          REAL,
      notes_in    TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL CHECK (status IN ('out','done')),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      -- مفتاحا التعريف: يولّدهما جهاز البوابة، ويجعلان إعادة إرسال الطلب
      -- بعد انقطاع الشبكة آمنة (لا تُنشئ سجلًا مكررًا).
      client_ref        TEXT,
      return_client_ref TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_status  ON entries(status);
    CREATE INDEX IF NOT EXISTS idx_entries_date    ON entries(date_key);
    CREATE INDEX IF NOT EXISTS idx_entries_vehicle ON entries(vehicle);
    CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);

    -- صف مفتوح واحد فقط لكل آلية، مفروضًا في قاعدة البيانات لا في الكود.
    -- يمنع خروج آلية هي أصلًا في الخارج حتى لو تسابق جهازان على البوابة.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_trip
      ON entries(vehicle) WHERE status = 'out';

    -- لا عمليتان بنفس مفتاح التعريف: إعادة الإرسال تُرجع السجل الأصلي.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_ref
      ON entries(client_ref) WHERE client_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL,
      full_name     TEXT NOT NULL DEFAULT '',
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      role       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip        TEXT PRIMARY KEY,
      fails     INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT NOT NULL,
      role      TEXT NOT NULL,
      ip        TEXT,
      action    TEXT NOT NULL,
      entity_id TEXT,
      detail    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
  `);

  // لا يوجد نظام migration عام هنا: الجداول القديمة (sessions، audit) قد تكون
  // أُنشئت قبل إضافة نموذج المستخدمين الشخصي، فنضيف الأعمدة الناقصة يدويًا.
  // sessions و audit عمليّتان لا تحملان بيانات عمل جوهرية (الجلسات مؤقتة، والتدقيق
  // إضافي)، فالإضافة الآمنة بعمود جديد تكفي، بلا حاجة لإعادة بناء الجدول.
  ensureColumn('sessions', 'user_id', 'user_id TEXT');
  ensureColumn('sessions', 'username', 'username TEXT');
  ensureColumn('audit', 'username', "username TEXT NOT NULL DEFAULT '-'");

  return { location: file, initialPasswords: seedUsers(options && options.adminPassword) };
}

function ensureColumn(table, name, columnDdl) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
}

/* ------------------------------------------------ كلمات المرور والجلسات */

// PBKDF2 من وحدة crypto المدمجة — لا نخزّن كلمة المرور نفسها أبدًا.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(plain, salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$120000$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const expected = Buffer.from(parts[3], 'hex');
  const actual = crypto.pbkdf2Sync(plain, parts[2], iterations, expected.length, 'sha256');
  // مقارنة بزمن ثابت حتى لا تتسرب معلومات من زمن الاستجابة.
  return crypto.timingSafeEqual(expected, actual);
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// كلمة مرور أولية مقروءة: 3 مقاطع + رقمان، لا تحتوي أحرفًا متشابهة.
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
  { username: 'مدير_مستودع_المازوت',        role: 'fuel_warehouse_manager', fullName: 'مدير مستودع المازوت' }
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
function seedUsers(adminPassword) {
  const out = {};
  const noUsersYet = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if (noUsersYet) {
    const legacy = { gate: getSetting('pw_gate'), fleet_manager: getSetting('pw_manager') };
    for (const def of DEFAULT_ROLE_USERS) {
      const legacyHash = legacy[def.role];
      if (legacyHash) {
        insertUser({ username: def.username, passwordHash: legacyHash, role: def.role, fullName: def.fullName });
      } else {
        const plain = randomPassword();
        insertUser({ username: def.username, passwordHash: hashPassword(plain), role: def.role, fullName: def.fullName });
        out[def.username] = plain;
      }
    }
  }
  if (!getUserByUsername('admin')) {
    insertUser({ username: 'admin', passwordHash: hashPassword(adminPassword || 'sald2024'), role: 'admin', fullName: 'المدير العام' });
  }
  return Object.keys(out).length ? out : null;
}

function checkLockout(ip) {
  const row = db.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').get(ip);
  if (!row || !row.locked_until) return null;
  const until = new Date(row.locked_until);
  if (until > new Date()) return Math.ceil((until - new Date()) / 60000);
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
  return null;
}

function noteLoginFailure(ip) {
  const row = db.prepare('SELECT fails FROM login_attempts WHERE ip = ?').get(ip);
  const fails = (row ? row.fails : 0) + 1;
  const locked = fails >= LOCKOUT_TRIES
    ? new Date(Date.now() + LOCKOUT_MIN * 60000).toISOString()
    : null;
  db.prepare(`INSERT INTO login_attempts (ip, fails, locked_until) VALUES (?, ?, ?)
              ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`)
    .run(ip, fails, locked);
  return { fails, remaining: Math.max(0, LOCKOUT_TRIES - fails) };
}

function clearLoginFailures(ip) {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

function userOut(r) {
  return { id: r.id, username: r.username, role: r.role, fullName: r.full_name, active: !!r.active, createdAt: r.created_at };
}

function getUser(id) {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
  return r ? userOut(r) : null;
}

function getUserByUsername(username) {
  const r = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  return r ? userOut(r) : null;
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY role, username').all().map(userOut);
}

function insertUser(data) {
  const id = newId('u');
  try {
    db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, active, created_at)
                VALUES (?,?,?,?,?,1,?)`)
      .run(id, String(data.username).trim(), data.passwordHash, data.role, data.fullName || '', new Date().toISOString());
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      const e = new Error('اسم المستخدم هذا مستخدم بالفعل.');
      e.duplicateUsername = true;
      throw e;
    }
    throw err;
  }
  return getUser(id);
}

function updateUser(id, data) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
  if (!existing) return null;
  db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(
    data.fullName !== undefined ? data.fullName : existing.full_name,
    data.role !== undefined ? data.role : existing.role,
    String(id));
  return getUser(id);
}

function setUserActive(id, active) {
  const info = db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, String(id));
  return info.changes > 0 ? getUser(id) : null;
}

function changeUserPassword(id, plain) {
  if (typeof plain !== 'string' || plain.length < 6) {
    throw new Error('كلمة المرور يجب أن تكون 6 محارف على الأقل');
  }
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(plain), String(id));
  if (info.changes === 0) throw new Error('المستخدم غير موجود');
}

function login(username, password, ip) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!row || !row.active || !verifyPassword(password, row.password_hash)) return null;
  clearLoginFailures(ip);
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_HOURS * 3600000);
  db.prepare('INSERT INTO sessions (token, user_id, username, role, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(token, row.id, row.username, row.role, now.toISOString(), exp.toISOString());
  return { token, userId: row.id, username: row.username, role: row.role, expiresAt: exp.toISOString() };
}

function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id, username, role, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { userId: row.user_id, username: row.username, role: row.role };
}

function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

/* -------------------------------------------------------------- التدقيق */

// actor: {username, role} — أو نص دور مجرّد (توافقًا مع نداءات قديمة محتملة).
function audit(actor, ip, action, entityId, detail) {
  const username = (actor && actor.username) || '-';
  const role = (actor && actor.role) || actor || '-';
  db.prepare('INSERT INTO audit (at, username, role, ip, action, entity_id, detail) VALUES (?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), username, role, ip || '-', action, entityId || null,
         detail ? JSON.stringify(detail) : null);
}

function listAudit(limit) {
  return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 200, 1000));
}

/* --------------------------------------------------------- تحويل الصفوف */

function entryOut(r) {
  return {
    id: r.id, dateKey: r.date_key, vehicle: r.vehicle, driver: r.driver,
    customer: r.customer, departTime: r.depart_time, notesOut: r.notes_out,
    returnDate: r.return_date, returnTime: r.return_time,
    km: r.km === null ? null : Number(r.km),
    notesIn: r.notes_in, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    clientRef: r.client_ref, returnClientRef: r.return_client_ref
  };
}

function vehicleOut(r) {
  return { id: r.id, name: r.name, baselineKm: Number(r.baseline_km), registeredAt: r.registered_at };
}

/* ---------------------------------------------------------- الاستعلامات */

function listVehicles() {
  return db.prepare('SELECT * FROM vehicles ORDER BY name').all().map(vehicleOut);
}

/**
 * كل الآليات في الخارج (مهما قدُم تاريخها) + العمليات المكتملة خلال آخر
 * `days` يومًا. هذا يمنع تضخم الاستجابة بعد سنة من التشغيل، مع ضمان أن
 * أي آلية لم تعد بعد تبقى ظاهرة دائمًا في قائمة الخارج.
 */
function listEntries(days) {
  const n = Number(days);
  if (!n || n <= 0) {
    return db.prepare('SELECT * FROM entries ORDER BY date_key DESC, depart_time DESC').all().map(entryOut);
  }
  const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return db.prepare(`SELECT * FROM entries
                     WHERE status = 'out' OR date_key >= ?
                     ORDER BY date_key DESC, depart_time DESC`).all(from).map(entryOut);
}

function getEntry(id) {
  const r = db.prepare('SELECT * FROM entries WHERE id = ?').get(String(id));
  return r ? entryOut(r) : null;
}

function getVehicleByName(name) {
  const r = db.prepare('SELECT * FROM vehicles WHERE name = ?').get(String(name).trim());
  return r ? vehicleOut(r) : null;
}

// آخر كيلومتراج مسجَّل لآلية — يُستخدم للتحقق من منطقية القراءة الجديدة.
function lastKmForVehicle(name) {
  const r = db.prepare(`SELECT km FROM entries
                        WHERE vehicle = ? AND status = 'done' AND km IS NOT NULL
                        ORDER BY date_key DESC, depart_time DESC LIMIT 1`).get(String(name).trim());
  if (r && r.km !== null) return Number(r.km);
  const v = getVehicleByName(name);
  return v ? v.baselineKm : null;
}

function vehicleIsOut(name) {
  const r = db.prepare(`SELECT id, driver, customer, depart_time FROM entries
                        WHERE vehicle = ? AND status = 'out' LIMIT 1`).get(String(name).trim());
  if (!r) return null;
  return { id: r.id, driver: r.driver, customer: r.customer, departTime: r.depart_time };
}

function getEntryByClientRef(ref) {
  if (!ref) return null;
  const r = db.prepare('SELECT * FROM entries WHERE client_ref = ?').get(String(ref));
  return r ? entryOut(r) : null;
}

function getVehicle(id) {
  const r = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(String(id));
  return r ? vehicleOut(r) : null;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

/* ------------------------------------------------------- عمليات الكتابة */

function insertEntry(data) {
  const now = new Date().toISOString();
  const id = newId('t');
  try {
    db.prepare(`INSERT INTO entries
        (id, date_key, vehicle, driver, customer, depart_time, notes_out,
         return_date, return_time, km, notes_in, status, created_at, updated_at, client_ref)
        VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,'','out',?,?,?)`)
      .run(id, data.dateKey, data.vehicle, data.driver, data.customer,
           data.departTime, data.notesOut || '', now, now, data.clientRef || null);
  } catch (err) {
    // خرق الفهرس الفريد = الآلية في الخارج أصلًا. نُعلِّم الخطأ ليترجمه
    // الخادم إلى 409، تمامًا كما يفعل محرّك Mongo.
    if (/UNIQUE constraint failed/i.test(err.message)) {
      // خرق مفتاح التعريف يعني إعادة إرسال لطلب نجح أصلًا — لا خطأ.
      if (/client_ref/i.test(err.message)) {
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
 * تسجيل العودة. يجري داخل معاملة (transaction) ويتحقق أن العملية ما زالت
 * "في الخارج" — فإن سجّلها جهاز آخر قبل لحظة، يفشل هذا الطلب بدل أن يكتب فوقه.
 */
function closeEntry(id, data) {
  const tx = db.prepare('BEGIN IMMEDIATE');
  tx.run();
  try {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(String(id));
    if (!row) { db.prepare('ROLLBACK').run(); return { error: 'notfound' }; }
    if (row.status !== 'out') { db.prepare('ROLLBACK').run(); return { error: 'already', entry: entryOut(row) }; }
    db.prepare(`UPDATE entries SET return_date = ?, return_time = ?, km = ?, notes_in = ?,
                status = 'done', updated_at = ?, return_client_ref = ? WHERE id = ?`)
      .run(data.returnDate, data.returnTime, data.km, data.notesIn || '',
           new Date().toISOString(), data.clientRef || null, String(id));
    db.prepare('COMMIT').run();
    return { entry: getEntry(id) };
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch (e) { /* المعاملة أُغلقت أصلًا */ }
    throw err;
  }
}

function updateEntry(id, data) {
  const existing = getEntry(id);
  if (!existing) return null;
  const done = data.returnTime && data.km !== null && data.km !== undefined && data.km !== '';
  db.prepare(`UPDATE entries SET date_key=?, vehicle=?, driver=?, customer=?, depart_time=?,
              notes_out=?, return_date=?, return_time=?, km=?, notes_in=?, status=?, updated_at=?
              WHERE id=?`)
    .run(data.dateKey, data.vehicle, data.driver, data.customer, data.departTime,
         data.notesOut || '',
         done ? (data.returnDate || data.dateKey) : null,
         done ? data.returnTime : null,
         done ? Number(data.km) : null,
         done ? (data.notesIn || '') : '',
         done ? 'done' : 'out',
         new Date().toISOString(), String(id));
  return getEntry(id);
}

function deleteEntry(id) {
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(String(id));
  return info.changes > 0;
}

function insertVehicle(name, baselineKm) {
  const id = newId('v');
  db.prepare('INSERT INTO vehicles (id, name, baseline_km, registered_at) VALUES (?,?,?,?)')
    .run(id, String(name).trim(), Number(baselineKm), new Date().toISOString());
  return getVehicle(id);
}

/**
 * تعديل آلية. إعادة تسمية الآلية تُحدِّث كل سجلاتها السابقة داخل نفس المعاملة،
 * وإلا انفصل تاريخها القديم عن اسمها الجديد وضاعت حسابات المسافة.
 */
function updateVehicle(id, name, baselineKm) {
  const tx = db.prepare('BEGIN IMMEDIATE');
  tx.run();
  try {
    const old = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(String(id));
    if (!old) { db.prepare('ROLLBACK').run(); return null; }
    const newName = String(name).trim();
    db.prepare('UPDATE vehicles SET name = ?, baseline_km = ? WHERE id = ?')
      .run(newName, Number(baselineKm), String(id));
    if (old.name !== newName) {
      db.prepare('UPDATE entries SET vehicle = ?, updated_at = ? WHERE vehicle = ?')
        .run(newName, new Date().toISOString(), old.name);
    }
    db.prepare('COMMIT').run();
    return getVehicle(id);
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch (e) { /* المعاملة أُغلقت أصلًا */ }
    throw err;
  }
}

function deleteVehicle(id) {
  const info = db.prepare('DELETE FROM vehicles WHERE id = ?').run(String(id));
  return info.changes > 0;
}

function countEntriesForVehicle(name) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE vehicle = ?').get(String(name).trim());
  return r ? r.n : 0;
}

/* ------------------------------------------------- النسخ الاحتياطي والإغلاق */

// نسخة احتياطية آمنة أثناء تشغيل البرنامج (VACUUM INTO يحترم المعاملات الجارية).
function backupTo(file) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

function close() {
  if (db) { db.close(); db = null; }
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
  insertVehicle, updateVehicle, deleteVehicle
};
