/**
 * server.js — الطرف الخلفي لتطبيق سجل بوابة المجبل.
 *
 * بدون أي اعتماديات خارجية: يعمل بـ Node.js وحده (24 LTS أو أحدث).
 *   التشغيل:  node server.js
 *   الفتح:    http://localhost:8787
 *
 * الفروق الجوهرية عن النسخة السابقة (Google Sheets):
 *   • الصلاحيات تُفرض هنا في الخادم، لا في صفحة HTML. إخفاء زر في الواجهة
 *     ليس حماية — أي شخص يستطيع استدعاء الـ API مباشرة.
 *   • كلمات المرور مُجزّأة (PBKDF2) في قاعدة البيانات، وليست مكتوبة في الصفحة.
 *   • كل كتابة تمر بمعاملة قاعدة بيانات، فلا تتعارض أجهزة البوابة فيما بينها.
 *   • كل حذف أو تعديل يُسجَّل في جدول تدقيق باسم الدور والوقت وعنوان الجهاز.
 */

'use strict';

const http = require('node:http');
const fs   = require('node:fs');
const path   = require('node:path');
const config = require('./config');
const db     = require('./db');

const ROOT     = __dirname;
const PUBLIC   = path.join(ROOT, 'public');
const DATA_DIR = config.dataDir;
const BACKUPS  = path.join(DATA_DIR, 'backups');
const PORT     = config.port;
const HOST     = config.host;

// عدد أيام العمليات المكتملة التي تُرسل للواجهة افتراضيًا. الآليات التي
// ما زالت في الخارج تُرسل دائمًا مهما قدُم تاريخها.
const DEFAULT_WINDOW_DAYS = config.windowDays;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2'
};

/* ------------------------------------------------------------ أدوات عامة */

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, headers || {}));
  res.end(body);
}

function json(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function clientIp(req) {
  return (req.socket.remoteAddress || '-').replace(/^::ffff:/, '');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > (limit || 256 * 1024)) { reject(new Error('حجم الطلب كبير جدًا')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (err) { throw Object.assign(new Error('صيغة JSON غير صالحة'), { status: 400 }); }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ------------------------------------------------------------- التحقّقات */

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const ROLES = ['gate', 'fleet_manager', 'fuel', 'admin', 'fuel_warehouse_manager'];
const VEHICLE_TYPES = ['gabbala', 'pump', 'service', 'silo'];

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 120);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function requireText(v, label, max) {
  const s = str(v, max);
  if (!s) throw badRequest(`الحقل «${label}» مطلوب.`);
  return s;
}

function requireDate(v, label) {
  const s = str(v, 10);
  if (!RE_DATE.test(s)) throw badRequest(`صيغة التاريخ في «${label}» غير صحيحة.`);
  return s;
}

function requireTime(v, label) {
  const s = str(v, 5);
  if (!RE_TIME.test(s)) throw badRequest(`صيغة الوقت في «${label}» غير صحيحة.`);
  return s;
}

function requireKm(v, label) {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 10000000) throw badRequest(`قيمة «${label}» غير منطقية.`);
  return n;
}

function requireVehicleType(v) {
  const s = str(v, 32);
  if (!VEHICLE_TYPES.includes(s)) throw badRequest('نوع الآلية غير معروف.');
  return s;
}

// رقم اختياري: فارغ يعني null (لا قيمة)، وإلا يجب أن يكون رقمًا منطقيًا.
function optionalNumber(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) throw badRequest(`قيمة «${label}» غير منطقية.`);
  return n;
}

/* --------------------------------------------------------------- الجلسة */

async function auth(req) {
  const token = parseCookies(req).gl_session;
  const user = await db.sessionUser(token);
  return { token, role: user ? user.role : null, username: user ? user.username : null, userId: user ? user.userId : null };
}

// تُرجع {role, username, userId} عند النجاح، أو null بعد إرسال رد الخطأ مباشرة.
async function requireRole(req, res, ...roles) {
  const { role, username, userId } = await auth(req);
  if (!role) { fail(res, 401, 'انتهت الجلسة. الرجاء تسجيل الدخول من جديد.'); return null; }
  if (roles.length && !roles.includes(role)) { fail(res, 403, 'هذا الإجراء غير متاح لهذا الحساب.'); return null; }
  return { role, username, userId };
}

/* --------------------------------------------------------------- CSV */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function entriesCsv(rows) {
  const head = ['المعرّف', 'التاريخ', 'الآلية', 'السائق', 'الزبون', 'وقت المغادرة',
                'ملاحظة الخروج', 'كمية التحميل', 'تاريخ العودة', 'وقت العودة', 'كيلومتراج العودة',
                'ملاحظة العودة', 'الحالة', 'أُنشئت في'];
  const lines = [head.join(',')];
  rows.forEach(e => lines.push([
    e.id, e.dateKey, e.vehicle, e.driver, e.customer, e.departTime, e.notesOut,
    e.loadQty === null || e.loadQty === undefined ? '' : e.loadQty,
    e.returnDate || '', e.returnTime || '', e.km === null ? '' : e.km,
    e.notesIn, e.status === 'done' ? 'مكتملة' : 'في الخارج', e.createdAt
  ].map(csvCell).join(',')));
  // علامة BOM حتى يتعرّف Excel على ترميز UTF-8 ويعرض العربية بشكل صحيح.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------- الملفات الثابتة */

function serveStatic(req, res, pathname) {
  const rel  = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'غير موجود');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), { 'Content-Type': type });
}

/* ------------------------------------------------------------- المسارات */

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  /* ---- تسجيل الدخول ---- */

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    const lockedFor = await db.checkLockout(ip);
    if (lockedFor) return fail(res, 429, `تم تجاوز عدد المحاولات. حاول بعد ${lockedFor} دقيقة.`);

    const body = await readJson(req);
    const username = str(body.username, 120);
    if (!username) return fail(res, 400, 'اسم المستخدم مطلوب.');
    const session = await db.login(username, String(body.password || ''), ip);
    if (!session) {
      const { remaining } = await db.noteLoginFailure(ip);
      await db.audit({ username, role: '-' }, ip, 'login_failed', null, null);
      return fail(res, 401, remaining > 0
        ? `اسم المستخدم أو كلمة المرور غير صحيحة. المحاولات المتبقية: ${remaining}.`
        : 'اسم المستخدم أو كلمة المرور غير صحيحة. تم إيقاف المحاولات مؤقتًا.');
    }
    await db.audit(session, ip, 'login', null, null);
    return json(res, 200, { role: session.role, username: session.username, expiresAt: session.expiresAt }, {
      'Set-Cookie': `gl_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`
    });
  }

  if (p === '/api/logout' && m === 'POST') {
    const { token, role, username } = await auth(req);
    await db.logout(token);
    await db.audit({ role, username }, clientIp(req), 'logout', null, null);
    return json(res, 200, { ok: true }, {
      'Set-Cookie': 'gl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    });
  }

  if (p === '/api/me' && m === 'GET') {
    const { role, username } = await auth(req);
    return json(res, 200, { role: role || null, username: username || null, serverTime: new Date().toISOString() });
  }

  /* ---- الحالة الكاملة (طلب واحد بدل طلبين) ---- */

  if (p === '/api/state' && m === 'GET') {
    const actor = await requireRole(req, res); if (!actor) return;
    const days = url.searchParams.has('days')
      ? Number(url.searchParams.get('days'))
      : DEFAULT_WINDOW_DAYS;
    return json(res, 200, {
      role: actor.role,
      username: actor.username,
      entries: await db.listEntries(days),
      vehicles: await db.listVehicles(),
      drivers: await db.listDrivers(),
      fuelFills: await db.listFuelFills(days),
      fuelSupply: await db.listFuelSupply(days),
      fuelBaseline: await db.getFuelBaseline(),
      windowDays: days,
      serverTime: new Date().toISOString()
    });
  }

  /* ---- المغادرة: البوابة والمدير ---- */

  if (p === '/api/entries' && m === 'POST') {
    const actor = await requireRole(req, res, 'gate'); if (!actor) return;
    const b = await readJson(req);

    const clientRef = str(b.clientRef, 64) || null;

    // إعادة إرسال بعد انقطاع الشبكة: لو كان الطلب قد نجح ووُقد الرد فقط،
    // نُرجع السجل الأصلي بدل إنشاء سجل ثانٍ للرحلة نفسها.
    if (clientRef) {
      const prior = await db.getEntryByClientRef(clientRef);
      if (prior) return json(res, 200, { entry: prior, deduplicated: true });
    }

    const vehicle  = requireText(b.vehicle, 'الآلية');
    const driver   = requireText(b.driver, 'السائق');
    const customer = requireText(b.customer, 'الزبون');
    const dateKey  = requireDate(b.dateKey || new Date().toISOString().slice(0, 10), 'التاريخ');
    const departTime = requireTime(b.departTime, 'وقت المغادرة');

    // الآلية يجب أن تكون مسجّلة، وإلا استحال حساب المسافة من أول رحلة.
    const vehicleRow = await db.getVehicleByName(vehicle);
    if (!vehicleRow) {
      return fail(res, 400, `الآلية «${vehicle}» غير مسجّلة. يسجّلها المدير من تبويب «الآليات» أولًا.`);
    }
    // كمية التحميل تخصّ الجبالات فقط — مطلوبة لها، ومُهملة لأي نوع آخر.
    const loadQty = vehicleRow.type === 'gabbala'
      ? requireKm(b.loadQty, 'كمية التحميل')
      : null;
    // لا يمكن خروج آلية هي أصلًا في الخارج — يمنع الصفوف المكرّرة عند
    // استخدام أكثر من جهاز على البوابة.
    const already = await db.vehicleIsOut(vehicle);
    if (already) {
      // قد تكون هذه الرحلة المفتوحة هي تسجيلنا نفسه: وصل طلب سابق بنفس
      // المفتاح ونجح بعد فحص المفتاح أعلاه مباشرة. نتأكّد قبل إعلان التعارض،
      // وإلا أبلغنا جهاز البوابة بفشل عملية نجحت فعلًا.
      if (clientRef) {
        const mine = await db.getEntryByClientRef(clientRef);
        if (mine) return json(res, 200, { entry: mine, deduplicated: true });
      }
      return fail(res, 409, `الآلية «${vehicle}» مسجّلة في الخارج منذ الساعة ${already.departTime} مع السائق ${already.driver}. سجّل عودتها أولًا.`);
    }

    let entry;
    try {
      entry = await db.insertEntry({
        vehicle, driver, customer, dateKey, departTime, loadQty,
        notesOut: str(b.notesOut, 300), clientRef
      });
    } catch (err) {
      // سباق: وصل الطلب مرتين في نفس اللحظة وفاتَ الفحصَ أعلاه.
      //
      // لا نعتمد على اسم الفهرس الذي أبلغ عنه المحرّك: الصف الواحد يخرق
      // فهرسين معًا (مفتاح التعريف، ورحلة مفتوحة واحدة لكل آلية)، وكل محرّك
      // يُبلّغ عن أيّهما صادفه أولًا. السؤال الحاسم واحد: هل يوجد الآن سجل
      // بهذا المفتاح؟ إن وُجد فهو تسجيلنا نفسه نجح — لا تعارض.
      if (clientRef && (err.duplicateClientRef || err.duplicateOpenTrip)) {
        const prior = await db.getEntryByClientRef(clientRef);
        if (prior) return json(res, 200, { entry: prior, deduplicated: true });
      }
      // الفحص أعلاه يلتقط الحالة المعتادة، لكن بين الفحص والكتابة توجد نافذة
      // زمنية: لو أرسل جهازان الطلب في نفس اللحظة، يرفض الفهرس الفريد الثاني.
      // نُترجم ذلك إلى 409 مفهومة بدل خطأ خادم غامض.
      if (err.duplicateOpenTrip) {
        return fail(res, 409, `الآلية «${vehicle}» سُجّلت في الخارج من جهاز آخر قبل لحظة.`);
      }
      throw err;
    }
    await db.audit(actor, clientIp(req), 'depart', entry.id, { vehicle, driver, customer });
    return json(res, 201, { entry });
  }

  /* ---- العودة: البوابة والمدير ---- */

  const mReturn = p.match(/^\/api\/entries\/([\w-]+)\/return$/);
  if (mReturn && m === 'POST') {
    const actor = await requireRole(req, res, 'gate'); if (!actor) return;
    const b = await readJson(req);

    const existing = await db.getEntry(mReturn[1]);
    if (!existing) return fail(res, 404, 'العملية غير موجودة.');

    const clientRef = str(b.clientRef, 64) || null;

    // إعادة إرسال بعد انقطاع الشبكة: إن كانت هذه العودة بالذات هي التي أغلقت
    // العملية، فالطلب نجح سابقًا ووُقد الرد فقط — نُرجع نجاحًا لا تعارضًا.
    if (clientRef && existing.status === 'done' && existing.returnClientRef === clientRef) {
      return json(res, 200, { entry: existing, deduplicated: true });
    }

    const returnTime = requireTime(b.returnTime, 'وقت العودة');
    const returnDate = requireDate(b.returnDate || new Date().toISOString().slice(0, 10), 'تاريخ العودة');
    const km = requireKm(b.km, 'كيلومتراج العودة');

    // قراءة العدّاد لا تنقص. رقم أصغر من آخر قراءة يعني خطأ إدخال غالبًا،
    // فنرفضه إلا إذا أكّد المستخدم صراحة (تبديل عدّاد مثلًا).
    const lastKm = await db.lastKmForVehicle(existing.vehicle);
    if (lastKm !== null && km < lastKm && !b.force) {
      return fail(res, 409, `كيلومتراج العودة (${km}) أقل من آخر قراءة مسجّلة (${lastKm}). تأكّد من الرقم.`);
    }

    const result = await db.closeEntry(existing.id, {
      returnDate, returnTime, km, notesIn: str(b.notesIn, 300), clientRef
    });
    if (result.error === 'notfound') return fail(res, 404, 'العملية غير موجودة.');
    if (result.error === 'already') {
      return fail(res, 409, 'سُجّلت عودة هذه الآلية من جهاز آخر قبل قليل.');
    }
    await db.audit(actor, clientIp(req), 'return', existing.id, { vehicle: existing.vehicle, km });
    return json(res, 200, { entry: result.entry });
  }

  /* ---- تعديل وحذف العمليات: المدير فقط ---- */

  const mEntry = p.match(/^\/api\/entries\/([\w-]+)$/);
  if (mEntry && m === 'PUT') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const b = await readJson(req);
    const before = await db.getEntry(mEntry[1]);
    if (!before) return fail(res, 404, 'العملية غير موجودة.');

    const editVehicle = requireText(b.vehicle, 'الآلية');
    const editVehicleRow = await db.getVehicleByName(editVehicle);
    const payload = {
      vehicle:  editVehicle,
      driver:   requireText(b.driver, 'السائق'),
      customer: requireText(b.customer, 'الزبون'),
      dateKey:  requireDate(b.dateKey, 'التاريخ'),
      departTime: requireTime(b.departTime, 'وقت المغادرة'),
      notesOut: str(b.notesOut, 300),
      notesIn:  str(b.notesIn, 300),
      loadQty: editVehicleRow && editVehicleRow.type === 'gabbala' ? requireKm(b.loadQty, 'كمية التحميل') : null,
      returnDate: null, returnTime: null, km: null
    };
    const hasReturn = b.returnTime && b.km !== null && b.km !== undefined && b.km !== '';
    if (hasReturn) {
      payload.returnTime = requireTime(b.returnTime, 'وقت العودة');
      payload.returnDate = requireDate(b.returnDate || payload.dateKey, 'تاريخ العودة');
      payload.km = requireKm(b.km, 'كيلومتراج العودة');
    }

    const entry = await db.updateEntry(before.id, payload);
    await db.audit(actor, clientIp(req), 'edit_entry', before.id, { before, after: entry });
    return json(res, 200, { entry });
  }

  if (mEntry && m === 'DELETE') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const before = await db.getEntry(mEntry[1]);
    if (!before) return fail(res, 404, 'العملية غير موجودة.');
    await db.deleteEntry(before.id);
    await db.audit(actor, clientIp(req), 'delete_entry', before.id, before);
    return json(res, 200, { ok: true });
  }

  /* ---- الآليات: مدير الآليات فقط ---- */

  if (p === '/api/vehicles' && m === 'POST') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const b = await readJson(req);
    const name = requireText(b.name, 'اسم الآلية');
    const km   = requireKm(b.baselineKm, 'الكيلومتراج الحالي');
    const type = requireVehicleType(b.type);
    const fuelTankQty = optionalNumber(b.fuelTankQty, 'كمية المازوت بالخزان');
    if (await db.getVehicleByName(name)) return fail(res, 409, 'هذه الآلية مسجّلة مسبقًا.');
    const v = await db.insertVehicle(name, km, type, fuelTankQty);
    await db.audit(actor, clientIp(req), 'add_vehicle', v.id, { name, baselineKm: km, type });
    return json(res, 201, { vehicle: v });
  }

  const mVehicle = p.match(/^\/api\/vehicles\/([\w-]+)$/);
  if (mVehicle && m === 'PUT') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const b = await readJson(req);
    const name = requireText(b.name, 'اسم الآلية');
    const km   = requireKm(b.baselineKm, 'الكيلومتراج الحالي');
    const type = requireVehicleType(b.type);
    const fuelTankQty = optionalNumber(b.fuelTankQty, 'كمية المازوت بالخزان');
    const clash = await db.getVehicleByName(name);
    if (clash && clash.id !== mVehicle[1]) return fail(res, 409, 'يوجد آلية أخرى بنفس الاسم.');
    const v = await db.updateVehicle(mVehicle[1], name, km, type, fuelTankQty);
    if (!v) return fail(res, 404, 'الآلية غير موجودة.');
    await db.audit(actor, clientIp(req), 'edit_vehicle', v.id, { name, baselineKm: km, type });
    return json(res, 200, { vehicle: v });
  }

  if (mVehicle && m === 'DELETE') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const v = await db.getVehicle(mVehicle[1]);
    if (!v) return fail(res, 404, 'الآلية غير موجودة.');
    const out = await db.vehicleIsOut(v.name);
    if (out) return fail(res, 409, 'لا يمكن حذف آلية مسجّلة في الخارج الآن.');
    const n = await db.countEntriesForVehicle(v.name);
    if (n > 0 && !url.searchParams.has('force')) {
      return fail(res, 409, `لهذه الآلية ${n} عملية في السجل. الحذف سيُبقي العمليات لكنه يُفقد كيلومتراج البداية.`);
    }
    await db.deleteVehicle(v.id);
    await db.audit(actor, clientIp(req), 'delete_vehicle', v.id, v);
    return json(res, 200, { ok: true });
  }

  /* ---- السائقون: مدير الآليات فقط ---- */

  function parseAllowedTypes(v) {
    const arr = Array.isArray(v) ? v : [];
    const bad = arr.filter(t => !VEHICLE_TYPES.includes(t));
    if (bad.length) throw badRequest('نوع آلية غير معروف ضمن الأنواع المسموحة.');
    return arr;
  }

  if (p === '/api/drivers' && m === 'POST') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const b = await readJson(req);
    const name = requireText(b.name, 'اسم السائق');
    const allowedTypes = parseAllowedTypes(b.allowedTypes);
    if (await db.getDriverByName(name)) return fail(res, 409, 'هذا السائق مسجّل مسبقًا.');
    let driver;
    try { driver = await db.insertDriver({ name, allowedTypes }); }
    catch (err) {
      if (err.duplicateDriverName) return fail(res, 409, 'هذا السائق مسجّل مسبقًا.');
      throw err;
    }
    await db.audit(actor, clientIp(req), 'add_driver', driver.id, { name, allowedTypes });
    return json(res, 201, { driver });
  }

  const mDriver = p.match(/^\/api\/drivers\/([\w-]+)$/);
  if (mDriver && m === 'PUT') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const b = await readJson(req);
    const name = requireText(b.name, 'اسم السائق');
    const allowedTypes = parseAllowedTypes(b.allowedTypes);
    let driver;
    try { driver = await db.updateDriver(mDriver[1], { name, allowedTypes }); }
    catch (err) {
      if (err.duplicateDriverName) return fail(res, 409, 'يوجد سائق آخر بنفس الاسم.');
      throw err;
    }
    if (!driver) return fail(res, 404, 'السائق غير موجود.');
    await db.audit(actor, clientIp(req), 'edit_driver', driver.id, { name, allowedTypes });
    return json(res, 200, { driver });
  }

  if (mDriver && m === 'DELETE') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    await db.deleteDriver(mDriver[1]);
    await db.audit(actor, clientIp(req), 'delete_driver', mDriver[1], null);
    return json(res, 200, { ok: true });
  }

  /* ---- المازوت: حساب المازوت فقط للكتابة ---- */

  if (p === '/api/fuel/fills' && m === 'POST') {
    const actor = await requireRole(req, res, 'fuel'); if (!actor) return;
    const b = await readJson(req);
    const vehicle = requireText(b.vehicle, 'الآلية');
    const km = requireKm(b.km, 'الكيلومتراج الحالي');
    const qty = requireKm(b.qty, 'كمية التعبئة');
    const workHours = optionalNumber(b.workHours, 'ساعات العمل');
    const dateKey = requireDate(b.dateKey || new Date().toISOString().slice(0, 10), 'التاريخ');
    const time = requireTime(b.time, 'الوقت');
    const fill = await db.insertFuelFill({ vehicle, km, qty, workHours, dateKey, time, createdBy: actor.username });
    await db.audit(actor, clientIp(req), 'fuel_fill', fill.id, { vehicle, qty });
    return json(res, 201, { fill });
  }

  if (p === '/api/fuel/supply' && m === 'POST') {
    const actor = await requireRole(req, res, 'fuel'); if (!actor) return;
    const b = await readJson(req);
    const meterReading = requireKm(b.meterReading, 'قراءة العدّاد');
    const dateKey = requireDate(b.dateKey || new Date().toISOString().slice(0, 10), 'التاريخ');
    const time = requireTime(b.time, 'الوقت');

    // العدّاد لا ينقص — نفس قاعدة كيلومتراج الآليات حرفيًا.
    const last = await db.lastFuelMeterReading();
    if (last !== null && meterReading < last && !b.force) {
      return fail(res, 409, `قراءة العدّاد (${meterReading}) أقل من آخر قراءة مسجّلة (${last}). تأكّد من الرقم.`);
    }

    const supply = await db.insertFuelSupply({ meterReading, dateKey, time, createdBy: actor.username });
    await db.audit(actor, clientIp(req), 'fuel_supply', supply.id, { meterReading });
    return json(res, 201, { supply });
  }

  if (p === '/api/fuel/baseline' && m === 'POST') {
    const actor = await requireRole(req, res, 'fuel'); if (!actor) return;
    const b = await readJson(req);
    const initialQty = requireKm(b.initialQty, 'الكمية الابتدائية');
    const initialMeter = requireKm(b.initialMeter, 'قراءة العدّاد الابتدائية');
    const baseline = await db.setFuelBaseline(initialQty, initialMeter);
    await db.audit(actor, clientIp(req), 'fuel_baseline', null, { initialQty, initialMeter });
    return json(res, 200, { baseline });
  }

  /* ---- المستخدمون وكلمات المرور: الأدمن فقط ---- */

  if (p === '/api/users' && m === 'GET') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    return json(res, 200, { users: await db.listUsers() });
  }

  if (p === '/api/users' && m === 'POST') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    const b = await readJson(req);
    const username = requireText(b.username, 'اسم المستخدم', 120);
    const role = requireText(b.role, 'الدور', 32);
    if (!ROLES.includes(role)) return fail(res, 400, 'دور غير معروف.');
    const password = String(b.password || '');
    if (password.length < 6) return fail(res, 400, 'كلمة المرور يجب أن تكون 6 محارف على الأقل.');
    let user;
    try {
      user = await db.insertUser({ username, passwordHash: db.hashPassword(password), role, fullName: str(b.fullName, 200) });
    } catch (err) {
      if (err.duplicateUsername) return fail(res, 409, 'اسم المستخدم هذا مستخدم بالفعل.');
      throw err;
    }
    await db.audit(actor, clientIp(req), 'add_user', user.id, { username, role });
    return json(res, 201, { user });
  }

  const mUser = p.match(/^\/api\/users\/([\w-]+)$/);
  if (mUser && m === 'PUT') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    const b = await readJson(req);
    const role = requireText(b.role, 'الدور', 32);
    if (!ROLES.includes(role)) return fail(res, 400, 'دور غير معروف.');
    const user = await db.updateUser(mUser[1], { fullName: str(b.fullName, 200), role });
    if (!user) return fail(res, 404, 'المستخدم غير موجود.');
    await db.audit(actor, clientIp(req), 'edit_user', user.id, { role });
    return json(res, 200, { user });
  }

  const mUserActive = p.match(/^\/api\/users\/([\w-]+)\/active$/);
  if (mUserActive && m === 'PUT') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    const b = await readJson(req);
    const user = await db.setUserActive(mUserActive[1], !!b.active);
    if (!user) return fail(res, 404, 'المستخدم غير موجود.');
    await db.audit(actor, clientIp(req), b.active ? 'activate_user' : 'deactivate_user', user.id, null);
    return json(res, 200, { user });
  }

  const mUserPassword = p.match(/^\/api\/users\/([\w-]+)\/password$/);
  if (mUserPassword && m === 'POST') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    const b = await readJson(req);
    try { await db.changeUserPassword(mUserPassword[1], String(b.password || '')); }
    catch (err) { return fail(res, 400, err.message); }
    await db.audit(actor, clientIp(req), 'change_password', mUserPassword[1], null);
    return json(res, 200, { ok: true });
  }

  /* ---- التصدير: مدير الآليات فقط ---- */

  if (p === '/api/export/entries.csv' && m === 'GET') {
    const actor = await requireRole(req, res, 'fleet_manager'); if (!actor) return;
    const rows = await db.listEntries(0);
    await db.audit(actor, clientIp(req), 'export_csv', null, { count: rows.length });
    return send(res, 200, entriesCsv(rows), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="gate-log-entries.csv"'
    });
  }

  /* ---- سجل التدقيق والنسخ الاحتياطي: الأدمن فقط ---- */

  if (p === '/api/audit' && m === 'GET') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    return json(res, 200, { rows: await db.listAudit(url.searchParams.get('limit')) });
  }

  if (p === '/api/backup' && m === 'POST') {
    const actor = await requireRole(req, res, 'admin'); if (!actor) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // كل محرّك يختار امتداده (‏.db لـ SQLite و ‏.json لـ Mongo) ويعيد المسار
    // الفعلي — نُبلّغ به لا بالاسم المطلوب، وإلا عرضنا اسم ملف لا وجود له.
    const written = await db.backupTo(path.join(BACKUPS, 'gate-log-' + stamp + '.db'));
    pruneBackups();
    const name = path.basename(written);
    await db.audit(actor, clientIp(req), 'backup', null, { file: name });
    return json(res, 200, { ok: true, file: name });
  }

  if (p.startsWith('/api/')) return fail(res, 404, 'مسار غير معروف');
  if (m !== 'GET') return fail(res, 405, 'طريقة غير مسموحة');
  return serveStatic(req, res, p);
}

/* ------------------------------------------------ النسخ الاحتياطي التلقائي */

function pruneBackups() {
  const files = fs.readdirSync(BACKUPS)
    .filter(f => f.startsWith('gate-log-') && (f.endsWith('.db') || f.endsWith('.json')))
    .sort();
  files.slice(0, -60).forEach(f => {
    try { fs.unlinkSync(path.join(BACKUPS, f)); } catch (e) { /* محذوف مسبقًا */ }
  });
}

async function autoBackup() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = await db.backupTo(path.join(BACKUPS, 'gate-log-' + stamp + '.db'));
    pruneBackups();
    console.log(new Date().toLocaleString('ar-EG') + '  نسخة احتياطية: ' + path.basename(file));
  } catch (err) {
    console.error('فشل النسخ الاحتياطي:', err.message);
  }
}

/* ------------------------------------------------------------- التشغيل */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  route(req, res, url).catch(err => {
    const status = err.status || 500;
    if (status >= 500) console.error('[خطأ]', req.method, url.pathname, '-', err.message);
    fail(res, status, status >= 500 ? 'حدث خطأ في الخادم.' : err.message);
  });
});

function banner(location, initialPasswords) {
  const driverLabel = { mssql: 'SQL Server', mongo: 'MongoDB', sqlite: 'SQLite' }[db.driverName];
  console.log('');
  console.log('  ═══════════════════════════════════════════');
  console.log('   سجل بوابة المجبل — الخادم يعمل');
  console.log('  ═══════════════════════════════════════════');
  console.log('   العنوان        http://localhost:' + PORT);
  console.log('   قاعدة البيانات ' + driverLabel + '  →  ' + location);
  console.log('   النسخ          ' + BACKUPS);
  console.log('   الإيقاف        Ctrl+C');
  if (initialPasswords) {
    const lines = [
      '',
      '  ┌──────────────────────────────────────────┐',
      '  │  كلمات المرور الأولية — تظهر مرة واحدة   │',
      '  └──────────────────────────────────────────┘',
      ...Object.entries(initialPasswords).map(([username, pw]) => '   ' + username + ' :  ' + pw),
      '',
      '   غيّرها كل موظف من حسابه، أو أعد تعيينها من تبويب «المستخدمون» في حساب الأدمن.',
      ''
    ].filter(Boolean);
    console.log(lines.join('\n'));
    fs.writeFileSync(path.join(DATA_DIR, 'كلمات-المرور-الأولية.txt'),
      '\uFEFF' + lines.join('\r\n')
        + '\r\nاحذف هذا الملف بعد تغيير كلمتي المرور.\r\n', 'utf8');
  }
  console.log('');
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  إيقاف الخادم...');
  server.close(async () => {
    try { await db.close(); } catch (e) { /* الاتصال مغلق أصلًا */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

async function main() {
  fs.mkdirSync(BACKUPS, { recursive: true });

  let info;
  try {
    info = await db.init(db.initOptions({ dataDir: DATA_DIR }));
  } catch (err) {
    console.error('');
    console.error('  ✗ تعذّر الاتصال بقاعدة البيانات');
    console.error('');
    console.error('    القاعدة   ' + config.describeDb() +
      (db.driverName === 'mongo' && config.isCloud ? '  (Atlas السحابية)' : ''));
    console.error('    الإعدادات ' + config.configSource);
    console.error('');
    console.error('    السبب: ' + err.message);
    // خطوات الإصلاح تأتي من المحرّك، وهي محدّدة بنوع العطل لا عامة.
    if (err.fixSteps && err.fixSteps.length) {
      console.error('');
      console.error('    ما ينبغي فعله:');
      err.fixSteps.forEach(s => console.error('      ' + s));
    }
    console.error('');
    process.exit(1);
  }

  server.listen(PORT, HOST, () => banner(info.location, info.initialPasswords));

  // تنظيف الجلسات المنتهية ونسخة احتياطية يومية.
  setInterval(() => {
    db.purgeExpiredSessions().catch(err => console.error('تنظيف الجلسات:', err.message));
  }, 3600000).unref();
  setInterval(autoBackup, 24 * 3600000).unref();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
