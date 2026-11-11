/**
 * guest-log.test.js — تبويب «سجل الضيوف» (GET /api/guests/log): عرض فقط من guest_visits.
 *
 * خادم حقيقي على SQLite مؤقتة:
 *  1) الصلاحيات في الخادم: مدير الآليات والأدمن وحدهما (المنسق والبوابة والمازوت والموارد 403، بلا جلسة 401).
 *  2) البيانات من سجلات البوابة نفسها: دخول بلا خروج = «داخل» وساعة الخروج فارغة؛ بعد خروج البوابة = «غادر» وساعة الخروج.
 *  3) الضيوف فقط (تُستثنى تسجيلات «زبون»)، بلا تكرار، والترتيب الأحدث أولًا، والترقيم لعدد كبير .
 *  4) الترشيح داخل اليوم، اسم الضيف (جزئي، ورموز % و_ حرفية)، حالة الزيارة، والتحديث يلتقط الجديد.
 *  5) لا أثر على البوابة: /api/state وتسجيل الدخول والخروج كما كانا.
 *
 *   node test/guest-log.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

const PORT = 8901, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'guest-log-pw-1';
const call = async (cookie, method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: Object.assign(cookie ? { cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* */ }
  return { status: r.status, data, text };
};
const login = async (user, pw) => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
  if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
};
const L = '/api/guests/log';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-gl-'));
  const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dir,
    GATE_LOG_CONFIG: path.join(dir, 'none.json'), ADMIN_PASSWORD: ADMIN_PW });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
      srv.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); res(); } });
      srv.on('exit', c => rej(new Error('الخادم توقّف ' + c)));
    });
    const pwPath = path.join(dir, 'كلمات-المرور-الأولية.txt');
    for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
    const pwFile = fs.readFileSync(pwPath, 'utf8');
    const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];
    const R = {
      admin: await login('admin', ADMIN_PW), gate: await login('بوابة', pwOf('بوابة')),
      manager: await login('مدير_الاليات', pwOf('مدير_الاليات')), coordinator: await login('منسق_حركة_الاليات', pwOf('منسق_حركة_الاليات')),
      fuel: await login('المازوت', pwOf('المازوت')), hr: await login('مسؤول_الموارد_البشرية', pwOf('مسؤول_الموارد_البشرية'))
    };
    const reg = (v, p, date, time, type) => call(R.gate, 'POST', '/api/guests', { vehicleDesc: v, purpose: p, dateIn: date, timeIn: time, visitType: type });

    // اليوم التشغيلي الحالي (يبدأ 03:00 محليًا) — كما يحسبه الخادم.
    const now = new Date(); if (now.getHours() < 3) now.setDate(now.getDate() - 1);
    const TODAY = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

    // 130 ضيفًا سابقًا: 65 في 2026-01-10 و65 في 2026-01-11 (يوم تشغيلي كامل لكلٍّ).
    const ids = [];
    for (let i = 1; i <= 130; i++) {
      const hh = String(8 + (i % 10)).padStart(2, '0');
      const r = await reg(`ضيف ${String(i).padStart(3, '0')}`, `جهة ${i}`, i <= 65 ? '2026-01-10' : '2026-01-11', `${hh}:${String(i % 60).padStart(2, '0')}`);
      assert.equal(r.status, 201, r.text);
      ids.push(r.data.visit.id);
    }
    // أول 100 غادروا (كل ضيوف 10 يناير + 35 من 11 يناير)، والـ30 الباقون (ids 100..129) ما زالوا داخلًا
    for (let i = 0; i < 100; i++) {
      const r = await call(R.gate, 'POST', `/api/guests/${ids[i]}/exit`, { dateOut: '2026-01-31', timeOut: '17:30' });
      assert.equal(r.status, 200, r.text);
    }
    // حدود اليوم التشغيلي (03:00) والحالات الخاصة
    assert.equal((await reg('حدّ أ 02:59', 'x', '2026-02-01', '02:59')).status, 201);   // يتبع 31 يناير
    assert.equal((await reg('حدّ ب 03:00', 'x', '2026-02-01', '03:00')).status, 201);   // يتبع 1 فبراير
    assert.equal((await reg('حدّ ج 01:30', 'x', '2026-02-02', '01:30')).status, 201);   // يتبع 1 فبراير
    assert.equal((await reg('حدّ د 03:00', 'x', '2026-02-02', '03:00')).status, 201);   // يتبع 2 فبراير
    assert.equal((await reg('100%_ضيف خاص', 'x', '2026-02-10', '09:00')).status, 201);
    assert.equal((await reg('زبون عادي ١', 'مصنع', '2026-02-10', '10:00', 'customer')).status, 201);
    assert.equal((await reg('زبون عادي ٢', 'مصنع', '2026-02-11', '10:00', 'customer')).status, 201);
    const day = (d, q) => call(R.admin, 'GET', `${L}?day=${d}${q || ''}`);

    console.log('\n1) الصلاحيات في الخادم');
    await check('مدير الآليات والأدمن → 200', async () => {
      for (const k of ['manager', 'admin']) assert.equal((await call(R[k], 'GET', L)).status, 200, k);
    });
    await check('المنسق والبوابة والمازوت والموارد البشرية → 403، بلا جلسة → 401', async () => {
      for (const k of ['coordinator', 'gate', 'fuel', 'hr']) assert.equal((await call(R[k], 'GET', L)).status, 403, k);
      assert.equal((await call(null, 'GET', L)).status, 401);
    });

    console.log('\n2) السجل يومي والرجوع لأيام سابقة');
    await check('بلا day = اليوم التشغيلي الحالي (فارغ الآن) والرد يذكر اليوم', async () => {
      const r = (await call(R.admin, 'GET', L)).data;
      assert.equal(r.day, TODAY); assert.equal(r.today, TODAY); assert.equal(r.total, 0); assert.equal(r.dayStartHour, 3);
    });
    await check('الرجوع ليوم سابق: 10 يناير = 65 زيارة كلها «غادر»', async () => {
      const r = (await day('2026-01-10', '&limit=200')).data;
      assert.equal(r.total, 65); assert.equal(r.rows.length, 65);
      assert.ok(r.rows.every(v => v.status === 'out' && v.dateIn === '2026-01-10'));
    });
    await check('11 يناير = 65 زيارة منها 30 «داخل» وساعة خروجها فارغة', async () => {
      const r = (await day('2026-01-11', '&limit=200')).data;
      assert.equal(r.total, 65);
      const inside = r.rows.filter(v => v.status === 'in');
      assert.equal(inside.length, 30);
      assert.ok(inside.every(v => v.timeOut === null && v.dateOut === null));
    });
    await check('ضيف غادر: ساعة وتاريخ الخروج من سجل البوابة', async () => {
      const v = (await day('2026-01-10', '&limit=200')).data.rows.find(x => x.id === ids[0]);
      assert.deepEqual([v.status, v.timeOut, v.dateOut, v.dateIn], ['out', '17:30', '2026-01-31', '2026-01-10']);
    });
    await check('عند خروج ضيف «داخل» من البوابة يتحدّث السجل: out + ساعة الخروج', async () => {
      assert.equal((await call(R.gate, 'POST', `/api/guests/${ids[129]}/exit`, { dateOut: '2026-01-11', timeOut: '12:05' })).status, 200);
      const v = (await day('2026-01-11', '&limit=200')).data.rows.find(y => y.id === ids[129]);
      assert.deepEqual([v.status, v.timeOut], ['out', '12:05']);
    });
    await check('ضيف جديد من البوابة يظهر في «اليوم الحالي» بحالة داخل', async () => {
      assert.equal((await reg('ضيف وصل الآن', 'إدارة', TODAY, '12:00')).status, 201);
      const r = (await call(R.admin, 'GET', L)).data;
      assert.equal(r.total, 1); assert.equal(r.rows[0].vehicleDesc, 'ضيف وصل الآن'); assert.equal(r.rows[0].status, 'in');
    });
    await check('يوم بلا زيارات → فارغ', async () => {
      const r = (await day('2025-06-01')).data;
      assert.equal(r.total, 0); assert.deepEqual(r.rows, []);
    });

    console.log('\n3) حدود اليوم التشغيلي (03:00)');
    await check('دخول 02:59 يتبع اليوم السابق (31 يناير) لا 1 فبراير', async () => {
      assert.deepEqual((await day('2026-01-31')).data.rows.map(v => v.vehicleDesc), ['حدّ أ 02:59']);
    });
    await check('1 فبراير: دخول 03:00 ودخول 01:30 من 2 فبراير', async () => {
      const r = (await day('2026-02-01')).data;
      assert.deepEqual(r.rows.map(v => v.vehicleDesc).sort(), ['حدّ ب 03:00', 'حدّ ج 01:30'].sort());
    });
    await check('2 فبراير: دخول 03:00 فقط', async () => {
      assert.deepEqual((await day('2026-02-02')).data.rows.map(v => v.vehicleDesc), ['حدّ د 03:00']);
    });
    await check('الأيام لا تتداخل: لا ضيف يظهر في يومين (مجموع الأيام = كل الضيوف)', async () => {
      const seen = new Set(); let n = 0;
      for (const d of ['2026-01-10', '2026-01-11', '2026-01-31', '2026-02-01', '2026-02-02', '2026-02-10', TODAY]) {
        for (const v of (await day(d, '&limit=200')).data.rows) { seen.add(v.id); n++; }
      }
      assert.equal(n, seen.size); assert.equal(n, 130 + 4 + 1 + 1);
    });

    console.log('\n4) الترقيم والترشيح داخل اليوم');
    await check('الصفحات (50) داخل يوم من 65 زيارة بلا تكرار والأحدث أولًا', async () => {
      const a = (await day('2026-01-11', '&limit=50&offset=0')).data, b = (await day('2026-01-11', '&limit=50&offset=50')).data;
      assert.equal(a.rows.length, 50); assert.equal(b.rows.length, 15); assert.equal(a.total, 65);
      const all = a.rows.concat(b.rows);
      assert.equal(new Set(all.map(v => v.id)).size, 65);
      const keys = all.map(v => v.dateIn + ' ' + v.timeIn);
      assert.deepEqual(keys, [...keys].sort().reverse());
    });
    await check('limit مسقوف بـ200 وقيم غير صالحة ترجع للافتراضي', async () => {
      assert.equal((await day('2026-01-11', '&limit=9999')).data.limit, 200);
      assert.equal((await day('2026-01-11', '&limit=abc&offset=-4')).data.rows.length, 50);
    });
    await check('اسم الضيف جزئي داخل اليوم', async () => {
      const r = (await day('2026-01-10', '&name=' + encodeURIComponent('ضيف 05'))).data;
      assert.ok(r.total >= 1 && r.rows.every(v => v.vehicleDesc.includes('ضيف 05') && v.dateIn === '2026-01-10'));
      assert.equal((await day('2026-01-11', '&name=' + encodeURIComponent('ضيف 005'))).data.total, 0);   // الضيف 005 في 10 يناير
    });
    await check('رموز % و_ في الاسم تُعامل حرفيًا', async () => {
      const r = (await day('2026-02-10', '&name=' + encodeURIComponent('100%_'))).data;
      assert.equal(r.total, 1); assert.equal(r.rows[0].vehicleDesc, '100%_ضيف خاص');
      assert.equal((await day('2026-02-10', '&name=' + encodeURIComponent('%'))).data.total, 1);
    });
    await check('حالة الزيارة داخل اليوم: داخل 29 / غادر 36 ومجموعهما = الكل', async () => {
      const a = (await day('2026-01-11', '&status=in')).data, b = (await day('2026-01-11', '&status=out&limit=200')).data;
      assert.equal(a.total, 29); assert.equal(b.total, 36);
      assert.ok(a.rows.every(v => v.status === 'in')); assert.ok(b.rows.every(v => v.status === 'out'));
    });
    await check('الزبائن مستثنون (10 و11 فبراير)', async () => {
      assert.ok(!(await day('2026-02-10')).data.rows.some(v => v.vehicleDesc.startsWith('زبون')));
      assert.equal((await day('2026-02-11')).data.total, 0);
    });
    await check('مدخلات غير صالحة → 400', async () => {
      for (const q of ['?day=2026-13-40', '?day=abc', '?status=zzz']) assert.equal((await call(R.admin, 'GET', L + q)).status, 400, q);
    });

    console.log('\n5) من لم يغادر من أيام سابقة');
    await check('carryOver في رد يوم لاحق = كل من لم يغادر قبل بدايته (29 + 4 حدود + الخاص = 34)', async () => {
      assert.equal((await day('2026-03-01')).data.carryOver, 34);
      assert.equal((await day('2026-01-11')).data.carryOver, 0);   // قبل 11 يناير لا أحد داخل (ضيوف 10 يناير غادروا)
    });
    await check('carry=1 يعرض من لم يغادر فقط (كلهم داخل، دخلوا قبل بداية اليوم المطلوب) ويتجاهل الحالة', async () => {
      const r = (await day('2026-03-01', '&carry=1&status=out&limit=200')).data;
      assert.equal(r.carry, true); assert.equal(r.total, 34);
      assert.ok(r.rows.every(v => v.status === 'in' && v.dateIn < '2026-03-01'));
      assert.ok(r.rows.some(v => v.vehicleDesc === 'ضيف 101'));
    });

    console.log('\n6) لا أثر على البوابة');
    await check('/api/state ما زال يعيد guestVisits للبوابة', async () => {
      const st = (await call(R.gate, 'GET', '/api/state')).data;
      assert.ok(Array.isArray(st.guestVisits) && st.guestVisits.some(v => v.vehicleDesc === 'ضيف وصل الآن' && v.status === 'in'));
    });
    await check('خروج ضيف مُخرَج سابقًا ما زال 409 (آلية البوابة لم تتغير)', async () => {
      assert.equal((await call(R.gate, 'POST', `/api/guests/${ids[0]}/exit`, { dateOut: '2026-02-01', timeOut: '12:00' })).status, 409);
    });
  } finally { srv.kill(); }
  console.log(`\n${pass} نجح، ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
