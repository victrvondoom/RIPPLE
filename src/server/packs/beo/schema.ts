import { z } from 'zod';
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:MM');
export const ingredient = z.object({ name: z.string().min(1), unit: z.enum(['kg', 'each', 'l']), qtyPerPortion: z.number().positive(), supplierId: z.string() });
export const menuItem = z.object({
  id: z.string(), course: z.enum(['starter', 'main', 'side', 'dessert']), name: z.string().min(1),
  allergens: z.array(z.string()), vegan: z.boolean().default(false), vegetarian: z.boolean().default(false),
  serves: z.enum(['all', 'standard_share', 'vegetarian', 'vegan']), share: z.number().min(0).max(1).optional(),
  ingredients: z.array(ingredient),
});
export const beoPlanSchema = z.object({
  event: z.object({
    name: z.string().min(1), client: z.string().min(1), clientContact: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    venue: z.string().min(1), venueCapacity: z.number().int().positive(), venueCurfew: hhmm,
    guestCount: z.number().int().min(1).max(5000), serviceTime: hhmm, deliveryLeadMin: z.number().int().min(0),
    serviceDurationMin: z.number().int().min(30), teardownMin: z.number().int().min(0),
  }),
  dietary: z.object({ vegetarian: z.number().int().min(0), glutenFree: z.number().int().min(0), vegan: z.number().int().min(0), allergyNotes: z.array(z.string()) }),
  menu: z.array(menuItem).min(1),
  veganOptions: z.array(menuItem).default([]),
  suppliers: z.array(z.object({ id: z.string(), name: z.string(), leadDays: z.number().int().min(0), contact: z.string() })),
  staffing: z.object({
    guestsPerServer: z.number().positive(), guestsPerKitchenStaff: z.number().positive(), guestsPerBartender: z.number().positive(),
    captains: z.number().int().min(0), booked: z.object({ servers: z.number().int(), kitchen: z.number().int(), bartenders: z.number().int(), captains: z.number().int() }),
    serverCallLeadMin: z.number().int(), kitchenCallLeadMin: z.number().int(), ingredientBuffer: z.number().min(0).max(0.5),
  }),
});
export type BeoPlan = z.infer<typeof beoPlanSchema>;
export type MenuItem = z.infer<typeof menuItem>;

export const beoChangeSchema = z.object({
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(2000).default(''),
  guestCount: z.number().int().min(1).max(5000).optional(),
  serviceTime: hhmm.optional(),
  addVegan: z.boolean().default(false),
  veganCount: z.number().int().min(1).nullable().optional(),
});
export type BeoChange = z.infer<typeof beoChangeSchema>;
