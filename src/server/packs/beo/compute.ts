import type { BeoPlan, MenuItem } from './schema.js';

export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
export function addMin(t: string, d: number): string {
  const total = toMin(t) + d;
  const day = Math.floor(total / 1440);
  const m = ((total % 1440) + 1440) % 1440;
  const s = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return day > 0 ? `${s} (+${day}d)` : day < 0 ? `${s} (${day}d)` : s;
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function portions(plan: BeoPlan): Record<string, number> {
  const g = plan.event.guestCount, veg = plan.dietary.vegetarian, vegan = plan.dietary.vegan;
  const standard = Math.max(0, g - veg - vegan);
  const veganCourses = new Set(plan.menu.filter((m) => m.vegan && m.serves === 'vegan').map((m) => m.course));
  const out: Record<string, number> = {};
  for (const m of plan.menu) {
    if (m.serves === 'vegan') out[m.id] = vegan;
    else if (m.serves === 'vegetarian') out[m.id] = veg;
    else if (m.serves === 'standard_share') out[m.id] = Math.ceil(standard * (m.share ?? 0));
    else out[m.id] = veganCourses.has(m.course) ? g - vegan : g;
  }
  return out;
}

export interface IngredientNeed { key: string; name: string; unit: string; supplierId: string; qty: number }
export function ingredientNeeds(plan: BeoPlan): IngredientNeed[] {
  const p = portions(plan);
  const acc = new Map<string, IngredientNeed>();
  for (const m of plan.menu) for (const ing of m.ingredients) {
    const key = `${ing.supplierId}|${ing.name}|${ing.unit}`;
    const cur = acc.get(key) ?? { key, name: ing.name, unit: ing.unit, supplierId: ing.supplierId, qty: 0 };
    cur.qty += (p[m.id] ?? 0) * ing.qtyPerPortion * (1 + plan.staffing.ingredientBuffer);
    acc.set(key, cur);
  }
  return [...acc.values()].map((n) => ({ ...n, qty: n.unit === 'each' ? Math.ceil(n.qty - 1e-9) : Math.ceil(n.qty * 10 - 1e-9) / 10 }));
}

export function staffing(plan: BeoPlan) {
  const g = plan.event.guestCount, s = plan.staffing;
  const need = { servers: Math.ceil(g / s.guestsPerServer), kitchen: Math.ceil(g / s.guestsPerKitchenStaff), bartenders: Math.ceil(g / s.guestsPerBartender), captains: s.captains };
  const gap = { servers: need.servers - s.booked.servers, kitchen: need.kitchen - s.booked.kitchen, bartenders: need.bartenders - s.booked.bartenders, captains: need.captains - s.booked.captains };
  return { need, booked: s.booked, gap };
}

export function timeline(plan: BeoPlan) {
  const e = plan.event;
  const end = addMin(e.serviceTime, e.serviceDurationMin);
  const teardownEnd = addMin(e.serviceTime, e.serviceDurationMin + e.teardownMin);
  return {
    kitchenCall: addMin(e.serviceTime, -plan.staffing.kitchenCallLeadMin),
    delivery: addMin(e.serviceTime, -e.deliveryLeadMin),
    serverCall: addMin(e.serviceTime, -plan.staffing.serverCallLeadMin),
    service: e.serviceTime, serviceEnd: end, teardownEnd,
    pastCurfewMin: toMin(teardownEnd.slice(0, 5)) + (teardownEnd.includes('+1d') ? 1440 : 0) - toMin(e.venueCurfew),
  };
}

export const itemLabel = (m: MenuItem) => `${m.name} [${m.course}]`;
export const fmtQty = (n: IngredientNeed | { qty: number; unit: string }) => `${n.qty} ${n.unit}`;
