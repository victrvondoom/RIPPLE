import { NextResponse } from "next/server";
import { z } from "zod";
import { record } from "@/lib/activity";
import { searchFlights } from "@/lib/flights";
import { fail, parse } from "@/lib/http";
import { rateLimit } from "@/lib/ratelimit";
import { newId, redis, storeConfigured } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Q = z.object({
  from: z.string().trim().regex(/^[A-Za-z]{3}$/, "must be a 3-letter IATA code"),
  to: z.string().trim().regex(/^[A-Za-z]{3}$/, "must be a 3-letter IATA code"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  adults: z.coerce.number().int().min(1).max(9).default(1),
  currency: z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
  by: z.string().trim().max(80).optional(),
});

export async function GET(req: Request) {
  try {
    await rateLimit(req, "flights", 20, 60);
    const p = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
    const result = await searchFlights({ origin: p.from, destination: p.to, date: p.date, currency: p.currency, adults: p.adults });
    let searchId: string | null = null;
    // Snapshot the results so a booking can only reference an option the server actually returned (no invented prices).
    if (storeConfigured()) {
      searchId = newId("srch");
      await redis("SET", `room:search:${searchId}`, JSON.stringify(result), "EX", 3600);
      await record({ kind: "flight-search", subject: searchId, actor: p.by || "agent", summary: `${result.query.origin}->${result.query.destination} ${result.query.date}: ${result.options.length} options, ${result.priced} priced` });
    }
    return NextResponse.json({ ok: true, searchId, ...result });
  } catch (e) {
    return fail(Object.assign(e as Error, { status: (e as { status?: number }).status ?? 400 }), "GET /api/flights/search");
  }
}
