import { NextResponse } from "next/server";
import { z } from "zod";
import { quote } from "@/lib/fx";
import { fail, parse } from "@/lib/http";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Q = z.object({ amount: z.coerce.number().positive().max(100000), from: z.string().regex(/^[A-Za-z]{3}$/).default("USD"), to: z.string().regex(/^[A-Za-z]{3}$/).default("USD") });

export async function GET(req: Request) {
  try {
    await rateLimit(req, "quote", 60, 60);
    const p = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
    const q = await quote(p.amount, p.from, p.to);
    return NextResponse.json({ ok: true, quote: q, fees: { platformFee: "2.5%", fxSpread: "1.2% (0 when same currency)" } });
  } catch (e) {
    return fail(Object.assign(e as Error, { status: (e as { status?: number }).status ?? 502 }), "GET /api/quote");
  }
}
