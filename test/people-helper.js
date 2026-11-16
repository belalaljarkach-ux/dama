/**
 * people-helper.js — تجهيز السائقين والزبائن والمحاضر للاختبارات.
 * بعد تعديل «اختيار فقط»: السائق يجب أن يكون مسجّلًا، وخروج الآلية يتطلب محضرًا (يحمل الزبون).
 * seedPeople يسجّل السائقين، ويُنشئ منطقة واحدة ومحضرًا لكل زبون، ويُرجع { اسم الزبون: معرّف محضره }.
 * على قاعدة بلا migration 005 تُرجع الخريطة فارغة (الزبون يبقى نصًا كما كان).
 */
'use strict';
exports.seedPeople = async function seedPeople(call, admin, { drivers = [], customers = [] }) {
  for (const name of drivers) await call(admin, 'POST', '/api/drivers', { name, allowedTypes: [] });
  const map = {};
  if (!customers.length) return map;
  const g = await call(admin, 'POST', '/api/regions', { name: 'منطقة اختبار' });
  if (g.status !== 201) return map;
  for (const name of customers) {
    const c = await call(admin, 'POST', '/api/customers', { name });
    if (c.status !== 201) continue;
    const m = await call(admin, 'POST', '/api/muhdars', { name: 'محضر ' + name, customerId: c.data.customer.id, regionId: g.data.region.id });
    if (m.status === 201) map[name] = m.data.muhdar.id;
  }
  return map;
};
