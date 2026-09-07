// اختبار التزامن: يحاكي جهازين على البوابة يرسلان نفس الطلب في نفس اللحظة.
const BASE = 'http://localhost:8899';
const MGR = process.argv[2];

// آلية جديدة لكل تشغيل، حتى يكون الاختبار قابلًا لإعادة التنفيذ على نفس القاعدة.
const VEH = 'قلاب التزامن ' + Date.now().toString(36);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  const t = await res.text();
  let d = {}; try { d = t ? JSON.parse(t) : {}; } catch (e) {}
  return { status: res.status, data: d };
}

(async () => {
  await call('POST', '/api/login', { role: 'manager', password: MGR });
  await call('POST', '/api/vehicles', { name: VEH, baselineKm: 50000 });

  console.log('\n── جهازان يسجّلان مغادرة نفس الآلية في نفس اللحظة ──');
  const departs = await Promise.all([
    call('POST', '/api/entries', { vehicle: VEH, driver: 'سائق أ', customer: 'زبون أ', departTime: '07:00' }),
    call('POST', '/api/entries', { vehicle: VEH, driver: 'سائق ب', customer: 'زبون ب', departTime: '07:00' }),
    call('POST', '/api/entries', { vehicle: VEH, driver: 'سائق ج', customer: 'زبون ج', departTime: '07:00' })
  ]);
  const created = departs.filter(r => r.status === 201);
  const rejected = departs.filter(r => r.status === 409);
  ok('طلب واحد فقط نجح', created.length === 1, `نجح ${created.length}`);
  ok('الباقي رُفض بـ 409', rejected.length === 2, `رُفض ${rejected.length}`);

  const state1 = await call('GET', '/api/state');
  const openTrips = state1.data.entries.filter(e => e.vehicle === VEH && e.status === 'out');
  ok('لا يوجد إلا صف مفتوح واحد في قاعدة البيانات', openTrips.length === 1, `وُجد ${openTrips.length}`);

  const tripId = openTrips[0].id;

  console.log('\n── جهازان يسجّلان عودة نفس العملية في نفس اللحظة ──');
  const returns = await Promise.all([
    call('POST', `/api/entries/${tripId}/return`, { returnTime: '11:00', km: 50100 }),
    call('POST', `/api/entries/${tripId}/return`, { returnTime: '11:05', km: 50200 }),
    call('POST', `/api/entries/${tripId}/return`, { returnTime: '11:10', km: 50300 })
  ]);
  const okReturns = returns.filter(r => r.status === 200);
  const dupReturns = returns.filter(r => r.status === 409);
  ok('عودة واحدة فقط سُجّلت', okReturns.length === 1, `نجح ${okReturns.length}`);
  ok('الباقي رُفض بـ 409', dupReturns.length === 2, `رُفض ${dupReturns.length}`);

  const state2 = await call('GET', '/api/state');
  const trip = state2.data.entries.find(e => e.id === tripId);
  ok('العملية مكتملة بقيمة واحدة متسقة', trip.status === 'done' && [50100, 50200, 50300].includes(trip.km), JSON.stringify({ s: trip.status, km: trip.km }));

  console.log('\n── الآلية تستطيع الخروج ثانية بعد عودتها ──');
  const again = await call('POST', '/api/entries', { vehicle: VEH, driver: 'سائق د', customer: 'زبون د', departTime: '12:00' });
  ok('المغادرة الثانية مقبولة', again.status === 201, again.status);

  console.log('\n── علامة BOM في CSV على مستوى البايت ──');
  const csv = await fetch(BASE + '/api/export/entries.csv', { headers: { Cookie: cookie } });
  const buf = Buffer.from(await csv.arrayBuffer());
  ok('الملف يبدأ بـ EF BB BF', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF,
     [...buf.slice(0, 3)].map(b => b.toString(16)).join(' '));

  console.log('\n── النسخة الاحتياطية ──');
  const bk = await call('POST', '/api/backup');
  ok('إنشاء نسخة احتياطية ينجح', bk.status === 200, JSON.stringify(bk.data));
  // كل محرّك يكتب امتداده: ‏.json لـ Mongo و ‏.db لـ SQLite.
  ok('اسم الملف المُبلَّغ يطابق الامتداد الفعلي',
     /\.(json|db)$/.test(bk.data.file || ''), bk.data.file);

  console.log(`\n══ النتيجة: ${pass} ناجح، ${fail} فاشل ══\n`);
  process.exit(fail ? 1 : 0);
})();
