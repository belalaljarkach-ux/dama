/**
 * reports-core.js — منطق تقارير الفترة (دوال نقية، بلا وصول لقاعدة البيانات).
 *
 * يُستعمل من مسار /api/reports/period في server.js. يأخذ العمليات والتعبئات
 * المقروءة من قاعدة البيانات (بنطاق تقويمي) ويُرجع فقط ما يخص الفترة المطلوبة
 * بمقياس «اليوم التشغيلي»: يبدأ الساعة dayStartHour (الافتراضي 03:00) وينتهي
 * قبلها بيوم تقويمي لاحق، فحركة 01:30 صباحًا تتبع اليوم السابق.
 *
 *  - الرحلة تتبع يوم مغادرتها التشغيلي (للتقارير).
 *  - التنبيه يتبع يوم عودة الرحلة التشغيلي (نفس قاعدة لوحة التحكم).
 *  - المسافة تُحسب بسلسلة عدّاد الآلية (نفس منطق enrichEntries في الواجهة).
 *  - لا تغيير على قاعدة البيانات: كل ما هنا مشتقّ وقت القراءة.
 */

'use strict';

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 400; // سقف حماية لطول الفترة المطلوبة

function pad(n) { return String(n).padStart(2, '0'); }

function isDateKey(s) {
  if (typeof s !== 'string' || !RE_DATE.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

function shiftDateKey(key, delta) {
  const p = String(key).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + delta));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/** اليوم التشغيلي لحركة (dateKey, time). قبل ساعة البدء = اليوم السابق. */
function opDayOf(dateKey, time, startHour) {
  if (!dateKey) return '';
  if (!time) return dateKey;
  const hh = Number(String(time).slice(0, 2));
  return (isFinite(hh) && hh < startHour) ? shiftDateKey(dateKey, -1) : dateKey;
}

function opDayOfEntry(e, startHour) { return opDayOf(e.dateKey, e.departTime, startHour); }

function opDayOfReturn(e, startHour) {
  return e.returnTime ? opDayOf(e.returnDate || e.dateKey, e.returnTime, startHour) : opDayOfEntry(e, startHour);
}

/** اليوم التشغيلي الحالي من لحظة محلية معيّنة. */
function currentOpDay(now, startHour) {
  const d = now || new Date();
  return opDayOf(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
                 pad(d.getHours()) + ':' + pad(d.getMinutes()), startHour);
}

function departDate(e) { return new Date(`${e.dateKey}T${e.departTime}:00`); }

function returnDate(e) {
  if (!e.returnTime) return null;
  if (e.returnDate) return new Date(`${e.returnDate}T${e.returnTime}:00`);
  const dep = departDate(e);
  const ret = new Date(`${e.dateKey}T${e.returnTime}:00`);
  if (ret < dep) ret.setDate(ret.getDate() + 1);
  return ret;
}

/**
 * يحسب المدة والمسافة لكل رحلة مكتملة (نفس قواعد الواجهة) على نسخ جديدة.
 * lookbackFrom: أول يوم تقويمي محمّل. أول رحلة لآلية داخل النافذة تعتمد
 * كيلومتراج التسجيل فقط إن سُجّلت الآلية ضمن النافذة؛ وإلا فرحلتها السابقة
 * خارج النافذة والمسافة «غير متاحة» (null) بدل رقم مضلِّل.
 */
function enrichTrips(doneEntries, vehicles, lookbackFrom) {
  const vByName = new Map(vehicles.map(v => [String(v.name).trim(), v]));
  const byVehicle = new Map();
  doneEntries.forEach(e => {
    const k = (e.vehicle || '').trim();
    if (!byVehicle.has(k)) byVehicle.set(k, []);
    byVehicle.get(k).push(e);
  });
  const out = [];
  byVehicle.forEach((list, name) => {
    list.sort((a, b) => departDate(a) - departDate(b) || String(a.id).localeCompare(String(b.id)));
    const v = vByName.get(name);
    list.forEach((e, i) => {
      let ref, unknownRef = false;
      if (i === 0) {
        const regDay = v && v.registeredAt ? String(v.registeredAt).slice(0, 10) : null;
        if (v && regDay && lookbackFrom && regDay < lookbackFrom) unknownRef = true;
        ref = (v && !unknownRef) ? v.baselineKm : null;
      } else {
        ref = list[i - 1].km;
      }
      const refOk = ref !== null && ref !== undefined && !isNaN(ref);
      const km = Number(e.km);
      const ret = returnDate(e);
      out.push(Object.assign({}, e, {
        _distance: (refOk && km >= ref) ? (km - ref) : null,
        _chainBroken: refOk && km < ref,
        _durationMin: ret ? Math.round((ret - departDate(e)) / 60000) : null
      }));
    });
  });
  return out;
}

/** متوسطات الزبون (المدة/المسافة) على مجموعة رحلات — أساس قاعدة التنبيه. */
function customerBaselines(trips) {
  const g = new Map();
  trips.forEach(e => {
    const c = (e.customer || '').trim();
    const s = g.get(c) || { nT: 0, sumT: 0, nD: 0, sumD: 0 };
    if (e._durationMin !== null && e._durationMin !== undefined && !isNaN(e._durationMin)) { s.nT++; s.sumT += e._durationMin; }
    if (e._distance !== null && e._distance !== undefined && !isNaN(e._distance)) { s.nD++; s.sumD += e._distance; }
    g.set(c, s);
  });
  const out = {};
  g.forEach((s, c) => {
    out[c] = { nT: s.nT, avgT: s.nT ? s.sumT / s.nT : null, nD: s.nD, avgD: s.nD ? s.sumD / s.nD : null };
  });
  return out;
}

/** نطاق القراءة المطلوب من قاعدة البيانات لفترة [from..to] وعمق ماضٍ lookbackDays. */
function planRange(from, to, lookbackDays) {
  return { lookbackFrom: shiftDateKey(from, -Math.max(0, lookbackDays | 0)), readTo: shiftDateKey(to, 1) };
}

function validatePeriod(from, to) {
  if (!isDateKey(from) || !isDateKey(to)) return 'صيغة التاريخ غير صحيحة (YYYY-MM-DD).';
  if (from > to) return 'تاريخ البداية بعد تاريخ النهاية.';
  if (daysBetween(from, to) + 1 > MAX_SPAN_DAYS) return `الفترة أطول من الحد الأقصى (${MAX_SPAN_DAYS} يومًا).`;
  return null;
}

/**
 * @param {object} p
 *   from,to       الفترة التشغيلية المطلوبة (شاملة)
 *   entries       عمليات بنطاق تقويمي [lookbackFrom .. to+1]
 *   fuelFills     تعبئات بنطاق تقويمي [from .. to+1]
 *   vehicles      الآليات المسجّلة
 *   lookbackFrom  بداية النطاق التقويمي المقروء للعمليات
 *   startHour     ساعة بدء اليوم التشغيلي
 */
function buildPeriodReport(p) {
  const { from, to, vehicles, lookbackFrom, startHour } = p;

  // إزالة التكرار بالمعرّف: سجل واحد لكل عملية مهما تداخلت النطاقات.
  const seen = new Set();
  const done = [];
  (p.entries || []).forEach(e => {
    if (e.status !== 'done' || seen.has(e.id)) return;
    seen.add(e.id);
    done.push(e);
  });

  // خط الأساس والسلسلة: كل رحلات النافذة حتى نهاية الفترة التشغيلية.
  const upToEnd = done.filter(e => opDayOfEntry(e, startHour) <= to);
  const enriched = enrichTrips(upToEnd, vehicles, lookbackFrom);

  const inPeriod = e => {
    const d = opDayOfEntry(e, startHour), r = opDayOfReturn(e, startHour);
    return (d >= from && d <= to) || (r >= from && r <= to);
  };
  const trips = enriched.filter(inPeriod).map(e => Object.assign(e, {
    opDay: opDayOfEntry(e, startHour),
    returnOpDay: opDayOfReturn(e, startHour)
  })).sort((a, b) => departDate(b) - departDate(a) || String(a.id).localeCompare(String(b.id)));

  const customersInPeriod = new Set(trips.map(e => (e.customer || '').trim()));
  const allBase = customerBaselines(enriched);
  const baselines = {};
  customersInPeriod.forEach(c => { if (allBase[c]) baselines[c] = allBase[c]; });

  const fuelSeen = new Set();
  const fuelFills = [];
  (p.fuelFills || []).forEach(f => {
    if (fuelSeen.has(f.id)) return;
    fuelSeen.add(f.id);
    const d = opDayOf(f.dateKey, f.time, startHour);
    if (d >= from && d <= to) fuelFills.push(Object.assign({}, f, { opDay: d }));
  });

  return { from, to, dayStartHour: startHour, trips, baselines, fuelFills };
}

module.exports = {
  MAX_SPAN_DAYS, isDateKey, shiftDateKey, daysBetween, opDayOf, opDayOfEntry, opDayOfReturn,
  currentOpDay, enrichTrips, customerBaselines, planRange, validatePeriod, buildPeriodReport
};
