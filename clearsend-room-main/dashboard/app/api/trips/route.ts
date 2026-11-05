import { NextResponse } from "next/server";
import { z } from "zod";
import { hasServiceKey } from "@/lib/auth";
import type { searchFlights } from "@/lib/flights";
import { quote } from "@/lib/fx";
import { bad, body, fail, parse } from "@/lib/http";
import { signTrip, tripLink } from "@/lib/links";
import { rateLimit } from "@/lib/ratelimit";
import { redis } from "@/lib/store";
import { createTrip, listTrips, maskTraveller } from "@/lib/trips";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const trips = await listTrips();
    return NextResponse.json({ ok: true, trips: trips.map((t) => ({ ...t, travellers: t.travellers.map(maskTraveller), order: t.order ? { id: t.order.id, status: t.order.status, captureId: t.order.captureId } : undefined })) });
  } catch (e) {
    return fail(e, "GET /api/trips");
  }
}

const Traveller = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("").transform(() => undefined)),
  nationality: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(40).optional(),
});
const Create = z.object({
  searchId: z.string().regex(/^srch_[a-z0-9]+$/),
  ref: z.coerce.number().int().min(1),
  travellers: z.array(Traveller).min(1).max(9),
  payCurrency: z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
  requestedBy: z.string().trim().max(80).optional(),
});

// Create a priced quote for one option from a server-side search snapshot.
// The agent uses the service key; the web flow is rate-limited and receives a private trip link.
export async function POST(req: Request) {
  try {
    const agent = hasServiceKey(req);
    if (!agent) await rateLimit(req, "trip-create", 10, 3600);
    const b = parse(Create, await body(req));
    const raw = await redis<string | null>("GET", `room:search:${b.searchId}`);
    if (!raw) bad("Search expired or unknown. Search again.", 404);
    const search = JSON.parse(raw as string) as Awaited<ReturnType<typeof searchFlights>>;
    const opt = search.options.find((o) => o.ref === b.ref);
    if (!opt) bad(`Option ${b.ref} is not in search ${b.searchId}`, 404);
    if (!opt!.priced || !opt!.fare) bad("This option is schedule-only (fare unavailable) and cannot be booked or paid. Pick a priced option.", 422);
    if (b.travellers.length !== search.query.adults) bad(`Need details for exactly ${search.query.adults} traveller(s).`);
    const q = await quote(opt!.fare!.amount, opt!.fare!.currency, b.payCurrency.toUpperCase());
    const trip = await createTrip({ flight: opt!, searchedFor: { date: search.query.date, adults: search.query.adults }, travellers: b.travellers, quote: q }, b.requestedBy ?? (agent ? "agent" : "web"));
    return NextResponse.json({ ok: true, trip, breakdown: q, tripToken: signTrip(trip.id), tripLink: tripLink(trip.id), ask: "Show this breakdown and ask: 'Would you like me to book this and pay with your PayPal account?'" });
  } catch (e) {
    return fail(e, "POST /api/trips");
  }
}
