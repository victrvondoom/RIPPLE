import { NextResponse } from "next/server";
import { z } from "zod";
import { hasServiceKey } from "@/lib/auth";
import { createEscrow, listEscrows } from "@/lib/escrow";
import { quote } from "@/lib/fx";
import { body, fail, parse } from "@/lib/http";
import { roleLinks } from "@/lib/links";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

// Public list is a summary only. Full records need a role token or the service key.
export async function GET() {
  try {
    const list = await listEscrows();
    return NextResponse.json({ ok: true, escrows: list.map((e) => ({ id: e.id, title: e.title, state: e.state, amount: e.amount, currency: e.currency, payCurrency: e.payCurrency, total: e.quote.total, recipientCountry: e.recipient.country, createdAt: e.createdAt, lastStep: e.timeline.at(-1) })) });
  } catch (e) {
    return fail(e, "GET /api/escrow");
  }
}

const name = z.string().trim().min(1).max(80);
const Create = z.object({
  title: z.string().trim().min(3).max(140),
  spec: z.string().trim().min(10).max(4000),
  criteria: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
  amount: z.coerce.number().positive().max(10000),
  currency: z.string().regex(/^[A-Za-z]{3}$/).default("USD").transform((s) => s.toUpperCase()),
  payCurrency: z.string().regex(/^[A-Za-z]{3}$/).optional().transform((s) => s?.toUpperCase()),
  payerName: name,
  payerEmail: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  recipientName: name,
  recipientEmail: z.string().trim().email("must be the recipient's PayPal email"),
  recipientCountry: z.string().trim().min(2).max(60),
  verifierName: name,
  platform: z.string().trim().max(40).optional(),
  channel: z.string().trim().max(120).optional(),
  requestedBy: z.string().trim().max(80).optional(),
});

export async function POST(req: Request) {
  try {
    const agent = hasServiceKey(req);
    if (!agent) await rateLimit(req, "escrow-create", 5, 3600);
    const b = parse(Create, await body(req));
    if (b.recipientName.toLowerCase() === b.verifierName.toLowerCase()) throw Object.assign(new Error("The verifier must be a different person from the recipient."), { status: 400 });
    const payCurrency = b.payCurrency ?? b.currency;
    const q = await quote(b.amount, b.currency, payCurrency);
    const e = await createEscrow(
      {
        title: b.title,
        spec: b.spec,
        criteria: b.criteria,
        amount: b.amount,
        currency: b.currency,
        payCurrency,
        quote: q,
        payer: { name: b.payerName, email: b.payerEmail },
        recipient: { name: b.recipientName, email: b.recipientEmail, country: b.recipientCountry },
        verifier: { name: b.verifierName },
        room: { platform: b.platform ?? (agent ? undefined : "web"), channel: b.channel },
      },
      b.requestedBy ?? (agent ? "agent" : b.payerName),
    );
    return NextResponse.json({ ok: true, escrow: e, links: roleLinks(e.id), breakdown: q });
  } catch (e) {
    return fail(e, "POST /api/escrow");
  }
}
