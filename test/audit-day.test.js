/**
 * audit-day.test.js — سجل التدقيق في تبويب «المستخدمون»: يومي (يوم تشغيلي) وبلا عنوان الجهاز (IP).
 *
 * خادم حقيقي على SQLite مؤقتة، وصفوف تدقيق بتواريخ مصطنعة تُدخَل مباشرة في القاعدة:
 *  1) الافتراضي: اليوم التشغيلي الحالي فقط، ولا حقل ip في أي صف (ويبقى ip مخزَّنًا في القاعدة).
 *  2) day=YYYY-MM-DD: حدود اليوم التشغيلي 03:00 → 03:00 (02:59:59 تتبع اليوم السابق، و03:00:00 تتبع اليوم).
 *  3) الأحدث أولًا، تحقق من الصيغة، يوم مستقبلي فارغ، للأدمن وحده، وعلامة truncated عند بلوغ الحد.
 *
 *   node test/audit-day.test.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n')[0]); }
}

const PORT = 8913, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'audit-day-pw-1';
const call = async (cookie, method, url) => {
  const r = await fetch(BASE + url, { method, headers: cookie ? { cookie } : {} });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* */ }
  return { status: r.status, data, text };
};
const login = async (user, pw) => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
  if (r.status !== 200) throw new Error('login ' + user + ' ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
};
const local = s => new Date(s).toISOString();     // تفسير محلي (نفس ما يفعله الخادم لحدود اليوم)

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatelog-au-'));
  let srv = null;
  try {
    const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', GATE_LOG_DB: 'sqlite', GATE_LOG_DATA: dir,
      GATE_LOG_CONFIG: path.join(dir, 'none.json'), ADMIN_PASSWORD: ADMIN_PW });
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('الخادم لم يبدأ')), 15000);
      srv.stdout.on('data', d => { if (String(d).includes('الخادم يعمل')) { clearTimeout(t); res(); } });
      srv.on('exit', c => rej(new Error('الخادم توقّف ' + c)));
    });
    const pwPath = path.join(dir, 'كلمات-المرور-الأولية.txt');
    for (let i = 0; i < 50 && !fs.existsSync(pwPath); i++) await new Promise(r => setTimeout(r, 100));
    const pwFile = fs.readFileSync(pwPath, 'utf8');
    const pwOf = u => (pwFile.match(new RegExp(u + '\\s*:\\s*(\\S+)')) || [])[1];
    const admin = await login('admin', ADMIN_PW), mgr = await login('مدير_الاليات', pwOf('مدير_الاليات')), gate = await login('بوابة', pwOf('بوابة'));

    // صفوف تدقيق مصطنعة حول حدود اليوم التشغيلي 2026-03-10 (يبدأ 03:00)
    const db = new DatabaseSync(path.join(dir, 'gate-log.db'));
    const ins = db.prepare('INSERT INTO audit (at, username, role, ip, action, entity_id, detail) VALUES (?,?,?,?,?,?,?)');
    const seed = [
      ['2026-03-10T02:59:59', 'a', 'gate', '10.0.0.5', 'depart', 'e1', '{"vehicle":"قلاب 1"}'],      // يتبع 03-09
      ['2026-03-10T03:00:00', 'b', 'gate', '10.0.0.6', 'depart', 'e2', '{"vehicle":"قلاب 2"}'],      // 03-10
      ['2026-03-10T23:30:00', 'c', 'fleet_manager', '10.0.0.7', 'edit_entry', 'e3', '{"vehicle":"قلاب 3"}'], // 03-10
      ['2026-03-11T02:59:59', 'd', 'gate', '10.0.0.8', 'return', 'e4', '{"vehicle":"قلاب 4"}'],      // 03-10
      ['2026-03-11T03:00:00', 'e', 'gate', '10.0.0.9', 'depart', 'e5', '{"vehicle":"قلاب 5"}']       // 03-11
    ];
    for (const [at, u, role, ip, action, eid, detail] of seed) ins.run(local(at), u, role, ip, action, eid, detail);
    db.close();
    const vehiclesOf = r => r.data.rows.map(x => JSON.parse(x.detail).vehicle);

    console.log('— الافتراضي: اليوم التشغيلي الحالي، بلا IP');
    await check('بلا day → اليوم الحالي (day = today) وحقول الحدود حاضرة', async () => {
      const r = await call(admin, 'GET', '/api/audit');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.day, r.data.today); assert.match(r.data.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(r.data.dayStartHour, 3);
      assert.ok(r.data.rows.some(x => x.action === 'login'), 'دخول الأدمن اليوم ظاهر');
      assert.ok(!r.data.rows.some(x => /e[1-5]$/.test(x.entity_id || '')), 'صفوف 2026-03 لا تظهر في اليوم الحالي');
    });
    await check('لا حقل ip في أي صف من الاستجابة (ولا في نصها)', async () => {
      for (const q of ['', '?day=2026-03-10']) {
        const r = await call(admin, 'GET', '/api/audit' + q);
        assert.ok(r.data.rows.length > 0);
        for (const row of r.data.rows) assert.ok(!('ip' in row), JSON.stringify(row));
        assert.ok(!/10\.0\.0\.|127\.0\.0\.1|::1|"ip"/.test(r.text), 'عنوان جهاز في النص');
      }
    });
    await check('عنوان الجهاز يبقى مخزَّنًا في القاعدة للتحقيق', async () => {
      const d = new DatabaseSync(path.join(dir, 'gate-log.db'));
      assert.equal(d.prepare("SELECT ip FROM audit WHERE entity_id='e2'").get().ip, '10.0.0.6');
      d.close();
    });

    console.log('— حدود اليوم التشغيلي (03:00 → 03:00)');
    await check('day=2026-03-10: ثلاث عمليات (03:00 و23:30 و02:59:59 من اليوم التالي) والأحدث أولًا', async () => {
      const r = await call(admin, 'GET', '/api/audit?day=2026-03-10');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(vehiclesOf(r).sort(), ['قلاب 2', 'قلاب 3', 'قلاب 4']);
      assert.equal(r.data.day, '2026-03-10');
    });
    await check('02:59:59 تتبع اليوم السابق (03-09)', async () => {
      assert.deepEqual(vehiclesOf(await call(admin, 'GET', '/api/audit?day=2026-03-09')), ['قلاب 1']);
    });
    await check('03:00:00 من اليوم التالي تتبع 03-11 فقط', async () => {
      assert.deepEqual(vehiclesOf(await call(admin, 'GET', '/api/audit?day=2026-03-11')), ['قلاب 5']);
    });
    await check('الأحدث أولًا داخل اليوم', async () => {
      const r = await call(admin, 'GET', '/api/audit?day=2026-03-10');
      const ats = r.data.rows.map(x => x.at);
      assert.deepEqual(ats, [...ats].sort().reverse());
    });
    await check('يوم بلا عمليات → قائمة فارغة، ويوم مستقبلي فارغ أيضًا', async () => {
      assert.deepEqual((await call(admin, 'GET', '/api/audit?day=2026-01-01')).data.rows, []);
      assert.deepEqual((await call(admin, 'GET', '/api/audit?day=2099-01-01')).data.rows, []);
    });

    console.log('— التحقق والصلاحيات');
    for (const bad of ['abc', '2026-13-01', '2026/03/10', '10-03-2026']) {
      await check(`day غير صالح «${bad}» → 400`, async () => assert.equal((await call(admin, 'GET', '/api/audit?day=' + encodeURIComponent(bad))).status, 400));
    }
    await check('الأدمن وحده: مدير الآليات والبوابة 403، وبلا جلسة 401', async () => {
      assert.equal((await call(mgr, 'GET', '/api/audit?day=2026-03-10')).status, 403);
      assert.equal((await call(gate, 'GET', '/api/audit?day=2026-03-10')).status, 403);
      assert.equal((await call(null, 'GET', '/api/audit?day=2026-03-10')).status, 401);
    });
    await check('limit يقصّ ويضع truncated=true، وغير ذلك false', async () => {
      const a = await call(admin, 'GET', '/api/audit?day=2026-03-10&limit=2');
      assert.equal(a.data.rows.length, 2); assert.equal(a.data.truncated, true); assert.equal(a.data.limit, 2);
      const b = await call(admin, 'GET', '/api/audit?day=2026-03-10');
      assert.equal(b.data.truncated, false);
    });
  } catch (e) {
    fail++; console.log('  ✗ فشل غير متوقع: ' + e.stack);
  } finally {
    if (srv) { const s = srv; await new Promise(r => { s.removeAllListeners('exit'); s.on('exit', r); s.kill(); }); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} نجح، ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})();
