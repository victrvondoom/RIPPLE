import type { BeoChange, BeoPlan, MenuItem } from './schema.js';

const ing = (name: string, unit: 'kg' | 'each' | 'l', q: number, supplierId: string) => ({ name, unit, qtyPerPortion: q, supplierId });
const item = (m: Partial<MenuItem> & Pick<MenuItem, 'id' | 'course' | 'name' | 'serves' | 'ingredients'>): MenuItem =>
  ({ allergens: [], vegan: false, vegetarian: false, ...m });

export function samplePlan(): BeoPlan {
  return {
    event: {
      name: 'Harbor Tech Summit — Gala Dinner', client: 'Meridian Labs', clientContact: 'Dana Whitfield <dana@meridian.example>',
      date: '2026-11-14', venue: 'Pier 9 Loft', venueCapacity: 140, venueCurfew: '23:00',
      guestCount: 120, serviceTime: '18:30', deliveryLeadMin: 120, serviceDurationMin: 180, teardownMin: 45,
    },
    dietary: { vegetarian: 6, glutenFree: 4, vegan: 0, allergyNotes: ['2 guests: tree-nut allergy (table 4)', '1 guest: shellfish allergy (table 9)'] },
    menu: [
      item({ id: 'st1', course: 'starter', name: 'Roasted beet & goat cheese salad', allergens: ['dairy', 'tree-nuts (walnut)'], vegetarian: true, serves: 'all',
        ingredients: [ing('Beets', 'kg', 0.09, 'greenfield'), ing('Goat cheese', 'kg', 0.03, 'harbor-dairy'), ing('Walnuts', 'kg', 0.012, 'pantry'), ing('Arugula', 'kg', 0.02, 'greenfield')] }),
      item({ id: 'm1', course: 'main', name: 'Herb-roasted chicken, lemon jus', serves: 'standard_share', share: 0.6,
        ingredients: [ing('Chicken breast', 'kg', 0.28, 'coastal-poultry'), ing('Lemon', 'each', 0.1, 'greenfield')] }),
      item({ id: 'm2', course: 'main', name: 'Braised short rib, red wine reduction', allergens: ['sulphites'], serves: 'standard_share', share: 0.4,
        ingredients: [ing('Beef short rib', 'kg', 0.34, 'prime-meats'), ing('Red wine', 'l', 0.05, 'pantry')] }),
      item({ id: 'm3', course: 'main', name: 'Stuffed roasted peppers (vegetarian)', allergens: ['dairy'], vegetarian: true, serves: 'vegetarian',
        ingredients: [ing('Bell peppers', 'each', 1, 'greenfield'), ing('Feta', 'kg', 0.05, 'harbor-dairy')] }),
      item({ id: 's1', course: 'side', name: 'Roasted potatoes & seasonal greens', vegan: true, vegetarian: true, serves: 'all',
        ingredients: [ing('Potatoes', 'kg', 0.2, 'greenfield'), ing('Seasonal greens', 'kg', 0.08, 'greenfield')] }),
      item({ id: 'd1', course: 'dessert', name: 'Dark chocolate tart', allergens: ['dairy', 'egg', 'gluten'], vegetarian: true, serves: 'all',
        ingredients: [ing('Dark chocolate', 'kg', 0.04, 'pantry'), ing('Cream', 'l', 0.03, 'harbor-dairy'), ing('Tart shells', 'each', 1, 'pantry')] }),
    ],
    veganOptions: [
      item({ id: 'v-st', course: 'starter', name: 'Heirloom tomato & white bean salad', vegan: true, vegetarian: true, serves: 'vegan',
        ingredients: [ing('Heirloom tomatoes', 'kg', 0.12, 'greenfield'), ing('White beans', 'kg', 0.05, 'pantry')] }),
      item({ id: 'v-m', course: 'main', name: 'Wild mushroom & chestnut wellington', allergens: ['gluten', 'tree-nuts (chestnut)'], vegan: true, vegetarian: true, serves: 'vegan',
        ingredients: [ing('Wild mushrooms', 'kg', 0.18, 'greenfield'), ing('Vegan puff pastry', 'each', 1, 'plant-pantry'), ing('Chestnuts', 'kg', 0.05, 'plant-pantry')] }),
      item({ id: 'v-d', course: 'dessert', name: 'Coconut panna cotta, berry compote', allergens: ['coconut'], vegan: true, vegetarian: true, serves: 'vegan',
        ingredients: [ing('Coconut cream', 'l', 0.08, 'plant-pantry'), ing('Mixed berries', 'kg', 0.05, 'greenfield')] }),
    ],
    suppliers: [
      { id: 'coastal-poultry', name: 'Coastal Poultry', leadDays: 2, contact: 'orders@coastalpoultry.example' },
      { id: 'prime-meats', name: 'Prime Meats', leadDays: 3, contact: 'orders@primemeats.example' },
      { id: 'harbor-dairy', name: 'Harbor Dairy Co.', leadDays: 2, contact: 'orders@harbordairy.example' },
      { id: 'greenfield', name: 'Greenfield Produce', leadDays: 3, contact: 'orders@greenfield.example' },
      { id: 'pantry', name: 'Pantry Supply', leadDays: 3, contact: 'orders@pantrysupply.example' },
      { id: 'plant-pantry', name: 'Plant Pantry Wholesale', leadDays: 7, contact: 'orders@plantpantry.example' },
    ],
    staffing: {
      guestsPerServer: 15, guestsPerKitchenStaff: 40, guestsPerBartender: 60, captains: 1,
      booked: { servers: 8, kitchen: 3, bartenders: 2, captains: 1 }, serverCallLeadMin: 90, kitchenCallLeadMin: 300, ingredientBuffer: 0.05,
    },
  };
}

/** The client change from the brief: 120 → 145 guests, vegan meals added (count NOT given), service 18:30 → 19:30. */
export function sampleChange(): BeoChange {
  return { receivedOn: '2026-11-09', description: 'Client emailed: guest count is now 145, please add vegan meals, and move dinner service to 19:30.', guestCount: 145, serviceTime: '19:30', addVegan: true, veganCount: null };
}
