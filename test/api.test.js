// اختبار شامل لواجهة الـ API
const BASE = 'http://localhost:8899';
const GATE = process.argv[2], MGR = process.argv[3];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const jars = {};
async function call(who, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      body ? { 'Content-Type': 'application/json' } : {},
      jars[who] ? { Cookie: jars[who] } : {}),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) jars[who] = sc.map(c => c.split(';')[0]).join('; ');
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

(async () => {
  console.log('\n── المصادقة ──');
  let r = await call('anon', 'GET', '/api/state');
  ok('طلب بلا جلسة يُرفض 401', r.status === 401, r.status);

  r = await call('bad', 'POST', '/api/login', { role: 'manager', password: 'wrong-password' });
  ok('كلمة مرور خاطئة تُرفض 401', r.status === 401, r.status);
  ok('الرسالة تعرض المحاولات المتبقية', /المتبقية/.test(r.data.error || ''), r.data.error);

  r = await call('gate', 'POST', '/api/login', { role: 'gate', password: GATE });
  ok('دخول البوابة بكلمة مرورها', r.status === 200 && r.data.role === 'gate', JSON.stringify(r.data));

  r = await call('gate', 'POST', '/api/login', { role: 'manager', password: GATE });
  ok('كلمة مرور البوابة لا تفتح حساب المدير', r.status === 401, r.status);

  r = await call('mgr', 'POST', '/api/login', { role: 'manager', password: MGR });
  ok('دخول المدير بكلمة مروره', r.status === 200 && r.data.role === 'manager', JSON.stringify(r.data));

  console.log('\n── فرض الصلاحيات في السيرفر (لا في الواجهة) ──');
  r = await call('gate', 'POST', '/api/vehicles', { name: 'قلاب 99', baselineKm: 1 });
  ok('البوابة لا تستطيع إضافة آلية (403)', r.status === 403, r.status);
  r = await call('gate', 'GET', '/api/audit');
  ok('البوابة لا ترى سجل التدقيق (403)', r.status === 403, r.status);
  r = await call('gate', 'GET', '/api/export/entries.csv');
  ok('البوابة لا تصدّر السجل (403)', r.status === 403, r.status);

  console.log('\n── الآليات ──');
  r = await call('mgr', 'POST', '/api/vehicles', { name: 'قلاب رقم ٣', baselineKm: 120000 });
  ok('المدير يضيف آلية', r.status === 201, JSON.stringify(r.data));
  const v1 = r.data.vehicle;
  r = await call('mgr', 'POST', '/api/vehicles', { name: 'قلاب رقم ٣', baselineKm: 5 });
  ok('رفض آلية مكرّرة الاسم (409)', r.status === 409, r.status);
  r = await call('mgr', 'POST', '/api/vehicles', { name: 'شاحنة 7', baselineKm: 80000 });
  ok('إضافة آلية ثانية', r.status === 201);
  r = await call('mgr', 'POST', '/api/vehicles', { name: '', baselineKm: 5 });
  ok('رفض اسم آلية فارغ (400)', r.status === 400, r.status);
  r = await call('mgr', 'POST', '/api/vehicles', { name: 'س', baselineKm: 'أبجد' });
  ok('رفض كيلومتراج غير رقمي (400)', r.status === 400, r.status);

  console.log('\n── المغادرة ──');
  r = await call('gate', 'POST', '/api/entries', {
    vehicle: 'قلاب رقم ٣', driver: 'أحمد', customer: 'معمل الإسمنت', departTime: '07:30'
  });
  ok('البوابة تسجّل مغادرة', r.status === 201, JSON.stringify(r.data));
  const e1 = r.data.entry;
  ok('الحالة الابتدائية "out"', e1 && e1.status === 'out', e1 && e1.status);
  ok('الوقت مُخزَّن نصًّا كما أُدخل', e1 && e1.departTime === '07:30', e1 && e1.departTime);

  r = await call('gate', 'POST', '/api/entries', {
    vehicle: 'قلاب رقم ٣', driver: 'خالد', customer: 'زبون آخر', departTime: '08:00'
  });
  ok('منع خروج آلية هي أصلًا في الخارج (409)', r.status === 409, r.status);
  ok('الرسالة تذكر السائق الحالي', /أحمد/.test(r.data.error || ''), r.data.error);

  r = await call('gate', 'POST', '/api/entries', {
    vehicle: 'آلية غير مسجّلة', driver: 'س', customer: 'ص', departTime: '09:00'
  });
  ok('منع مغادرة آلية غير مسجّلة (400)', r.status === 400, r.status);

  r = await call('gate', 'POST', '/api/entries', {
    vehicle: 'شاحنة 7', driver: 'أحمد', customer: 'معمل الإسمنت', departTime: '99:99'
  });
  ok('رفض وقت غير صالح (400)', r.status === 400, r.status);

  console.log('\n── العودة ──');
  r = await call('gate', 'POST', `/api/entries/${e1.id}/return`, {
    returnTime: '11:45', km: 119000
  });
  ok('رفض كيلومتراج أقل من آخر قراءة (409)', r.status === 409, r.status);
  ok('الرسالة تعرض آخر قراءة', /120000/.test(r.data.error || ''), r.data.error);

  r = await call('gate', 'POST', `/api/entries/${e1.id}/return`, {
    returnTime: '11:45', km: 119000, force: true
  });
  ok('القبول عند التأكيد الصريح (force)', r.status === 200, r.status);

  r = await call('gate', 'POST', `/api/entries/${e1.id}/return`, { returnTime: '12:00', km: 121000 });
  ok('منع تسجيل عودة مرتين (409)', r.status === 409, r.status);
  ok('الرسالة تشرح أن جهازًا آخر سجّلها', /جهاز آخر/.test(r.data.error || ''), r.data.error);

  console.log('\n── العودة بعد منتصف الليل ──');
  r = await call('gate', 'POST', '/api/entries', {
    vehicle: 'شاحنة 7', driver: 'سمير', customer: 'مقلع الشمال',
    dateKey: '2026-08-25', departTime: '22:30'
  });
  const e2 = r.data.entry;
  ok('مغادرة بتاريخ سابق', r.status === 201, r.status);
  r = await call('gate', 'POST', `/api/entries/${e2.id}/return`, {
    returnDate: '2026-08-26', returnTime: '02:15', km: 80300
  });
  ok('عودة في اليوم التالي مقبولة', r.status === 200, JSON.stringify(r.data));
  ok('تاريخ العودة محفوظ منفصلًا', r.data.entry && r.data.entry.returnDate === '2026-08-26', r.data.entry && r.data.entry.returnDate);

  console.log('\n── التعديل والحذف (المدير) ──');
  r = await call('gate', 'PUT', `/api/entries/${e1.id}`, {
    vehicle: 'قلاب رقم ٣', driver: 'مزوّر', customer: 'x', dateKey: '2026-08-27', departTime: '07:30'
  });
  ok('البوابة لا تستطيع تعديل عملية (403)', r.status === 403, r.status);

  r = await call('mgr', 'PUT', `/api/entries/${e1.id}`, {
    vehicle: 'قلاب رقم ٣', driver: 'أحمد محمد', customer: 'معمل الإسمنت',
    dateKey: e1.dateKey, departTime: '07:15', returnTime: '11:45', returnDate: e1.dateKey, km: 120450
  });
  ok('المدير يعدّل العملية', r.status === 200, JSON.stringify(r.data));
  ok('التعديل طُبّق فعلًا', r.data.entry && r.data.entry.driver === 'أحمد محمد', r.data.entry && r.data.entry.driver);

  console.log('\n── إعادة تسمية آلية تُحدّث سجلاتها ──');
  r = await call('mgr', 'PUT', `/api/vehicles/${v1.id}`, { name: 'قلاب رقم 3 (جديد)', baselineKm: 120000 });
  ok('إعادة التسمية نجحت', r.status === 200, r.status);
  r = await call('mgr', 'GET', '/api/state');
  const renamed = r.data.entries.filter(e => e.vehicle === 'قلاب رقم 3 (جديد)');
  ok('سجلات الآلية القديمة تبعت الاسم الجديد', renamed.length === 1, renamed.length);

  console.log('\n── الحذف ──');
  r = await call('mgr', 'DELETE', `/api/vehicles/${v1.id}`);
  ok('رفض حذف آلية لها سجلات بلا تأكيد (409)', r.status === 409, r.status);
  r = await call('mgr', 'DELETE', `/api/vehicles/${v1.id}?force=1`);
  ok('الحذف بعد التأكيد', r.status === 200, r.status);

  console.log('\n── كلمات المرور ──');
  r = await call('gate', 'POST', '/api/password', { target: 'gate', password: 'hacked123' });
  ok('البوابة لا تغيّر كلمات المرور (403)', r.status === 403, r.status);
  r = await call('mgr', 'POST', '/api/password', { target: 'gate', password: '123' });
  ok('رفض كلمة مرور قصيرة (400)', r.status === 400, r.status);
  r = await call('mgr', 'POST', '/api/password', { target: 'gate', password: 'bawaba-jadida-77' });
  ok('المدير يغيّر كلمة مرور البوابة', r.status === 200, r.status);
  r = await call('old', 'POST', '/api/login', { role: 'gate', password: GATE });
  ok('كلمة المرور القديمة لم تعد تعمل', r.status === 401, r.status);
  r = await call('new', 'POST', '/api/login', { role: 'gate', password: 'bawaba-jadida-77' });
  ok('كلمة المرور الجديدة تعمل', r.status === 200, r.status);

  console.log('\n── التصدير وسجل التدقيق ──');
  const csv = await fetch(BASE + '/api/export/entries.csv', { headers: { Cookie: jars.mgr } });
  const body = await csv.text();
  ok('تصدير CSV يعمل', csv.status === 200, csv.status);
  ok('CSV يبدأ بعلامة BOM لأجل Excel', body.charCodeAt(0) === 0xFEFF);
  ok('CSV يحتوي بيانات عربية', /أحمد محمد/.test(body));

  r = await call('mgr', 'GET', '/api/audit');
  ok('سجل التدقيق يعمل', r.status === 200 && r.data.rows.length > 0, r.data.rows && r.data.rows.length);
  const actions = r.data.rows.map(x => x.action);
  ok('الحذف مُسجَّل في التدقيق', actions.includes('delete_vehicle'));
  ok('محاولة الدخول الفاشلة مُسجَّلة', actions.includes('login_failed'));
  ok('تغيير كلمة المرور مُسجَّل', actions.includes('change_password'));

  console.log('\n── الخروج ──');
  r = await call('mgr', 'POST', '/api/logout');
  ok('الخروج ينجح', r.status === 200);
  r = await call('mgr', 'GET', '/api/state');
  ok('الجلسة أُبطلت بعد الخروج (401)', r.status === 401, r.status);

  console.log(`\n══ النتيجة: ${pass} ناجح، ${fail} فاشل ══\n`);
  process.exit(fail ? 1 : 0);
})();
