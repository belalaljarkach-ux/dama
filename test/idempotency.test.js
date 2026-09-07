/**
 * idempotency.test.js — إعادة الإرسال بعد انقطاع الشبكة لا تُنشئ سجلات مكررة.
 *
 * السيناريو الذي يحميه هذا الاختبار: جهاز البوابة يرسل تسجيل مغادرة، فيصل
 * الطلب إلى الخادم ويُنفَّذ، ثم تنقطع الشبكة قبل وصول الرد. الجهاز يظن أن
 * الطلب فشل فيُعيده. بلا مفتاح تعريف تنشأ رحلتان لشاحنة واحدة.
 *
 *   node test/idempotency.test.js <كلمة-مرور-المدير>
 */

'use strict';

const BASE = 'http://localhost:8787';
const PW = process.argv[2];

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); }
};

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {},
                           cookie ? { Cookie: cookie } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  const t = await res.text();
  let d = {}; try { d = t ? JSON.parse(t) : {}; } catch (e) {}
  return { status: res.status, data: d };
}

const uid = () => 'test-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

(async () => {
  await call('POST', '/api/login', { role: 'manager', password: PW });
  const VEH = 'آلية التكرار ' + Date.now().toString(36);
  await call('POST', '/api/vehicles', { name: VEH, baselineKm: 10000 });

  console.log('\n── إعادة إرسال المغادرة نفسها ──');
  const ref1 = uid();
  const body = { vehicle: VEH, driver: 'سائق', customer: 'زبون', departTime: '08:00', clientRef: ref1 };

  const a = await call('POST', '/api/entries', body);
  ok('الإرسال الأول ينشئ العملية (201)', a.status === 201, a.status);

  const b = await call('POST', '/api/entries', body);
  ok('الإرسال الثاني لا يُنشئ عملية جديدة (200)', b.status === 200, b.status);
  ok('يُرجع العملية الأصلية نفسها', b.data.entry && b.data.entry.id === a.data.entry.id,
     `${a.data.entry && a.data.entry.id} مقابل ${b.data.entry && b.data.entry.id}`);
  ok('يُعلن أنه أزال التكرار', b.data.deduplicated === true, JSON.stringify(b.data.deduplicated));

  const c = await call('POST', '/api/entries', body);
  ok('الإرسال الثالث كذلك', c.status === 200 && c.data.entry.id === a.data.entry.id);

  console.log('\n── ثلاث إعادات متزامنة (أسوأ حالة) ──');
  const ref2 = uid();
  const VEH2 = 'آلية التكرار ب ' + Date.now().toString(36);
  await call('POST', '/api/vehicles', { name: VEH2, baselineKm: 20000 });
  const body2 = { vehicle: VEH2, driver: 'سائق', customer: 'زبون', departTime: '09:00', clientRef: ref2 };
  const burst = await Promise.all([
    call('POST', '/api/entries', body2),
    call('POST', '/api/entries', body2),
    call('POST', '/api/entries', body2)
  ]);
  const okCount = burst.filter(r => r.status === 201 || r.status === 200).length;
  const ids = new Set(burst.filter(r => r.data.entry).map(r => r.data.entry.id));
  ok('كل الطلبات نجحت بلا خطأ', okCount === 3, 'نجح ' + okCount);
  ok('كلها تشير إلى عملية واحدة', ids.size === 1, 'عدد المعرّفات: ' + ids.size);

  const state1 = await call('GET', '/api/state');
  const rows2 = state1.data.entries.filter(e => e.vehicle === VEH2);
  ok('صف واحد في قاعدة البيانات', rows2.length === 1, 'وُجد ' + rows2.length);

  console.log('\n── إعادة إرسال العودة نفسها ──');
  const entryId = a.data.entry.id;
  const rref = uid();
  const rbody = { returnTime: '12:00', km: 10120, notesIn: 'عودة', clientRef: rref };

  const r1 = await call('POST', `/api/entries/${entryId}/return`, rbody);
  ok('العودة الأولى تنجح (200)', r1.status === 200, r1.status);

  const r2 = await call('POST', `/api/entries/${entryId}/return`, rbody);
  ok('إعادة العودة نفسها تنجح لا تفشل (200)', r2.status === 200, r2.status);
  ok('تُعلن أنها مكررة', r2.data.deduplicated === true, JSON.stringify(r2.data.deduplicated));
  ok('لم تتغيّر القيم المحفوظة', r2.data.entry && r2.data.entry.km === 10120,
     r2.data.entry && String(r2.data.entry.km));

  console.log('\n── عودة بمفتاح مختلف على عملية مغلقة ترفض فعلًا ──');
  const r3 = await call('POST', `/api/entries/${entryId}/return`,
    { returnTime: '13:00', km: 10500, clientRef: uid() });
  ok('تُرفض بـ 409 (جهاز آخر سجّلها)', r3.status === 409, r3.status);

  const state2 = await call('GET', '/api/state');
  const row = state2.data.entries.find(e => e.id === entryId);
  ok('القيمة النهائية هي الأولى لا الثانية', row && row.km === 10120, row && String(row.km));

  console.log('\n── بلا مفتاح تعريف: السلوك القديم كما هو ──');
  const VEH3 = 'آلية بلا مفتاح ' + Date.now().toString(36);
  await call('POST', '/api/vehicles', { name: VEH3, baselineKm: 30000 });
  const n1 = await call('POST', '/api/entries',
    { vehicle: VEH3, driver: 'س', customer: 'ز', departTime: '10:00' });
  const n2 = await call('POST', '/api/entries',
    { vehicle: VEH3, driver: 'س', customer: 'ز', departTime: '10:00' });
  ok('الأول ينجح', n1.status === 201, n1.status);
  ok('الثاني يُرفض لأن الآلية في الخارج (409)', n2.status === 409, n2.status);

  console.log(`\n══ النتيجة: ${pass} ناجح، ${fail} فاشل ══\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('خطأ:', e.message); process.exit(1); });
