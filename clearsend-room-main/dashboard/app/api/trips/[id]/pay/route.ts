import { NextResponse } from "next/server";
import { checkConfirmation, record } from "@/lib/activity";
import { requireTripAccess } from "@/lib/auth";
import { body, fail } from "@/lib/http";
import { idempotent } from "@/lib/idem";
import { log } from "@/lib/log";
import { createOrder } from "@/lib/paypal";
import { getTrip, saveTrip } from "@/lib/trips";

export const dynamic = "force-dynamic";

// Creates the PayPal sandbox order ONLY with a verbatim human "yes" (from the room, or typed on the trip page).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const access = requireTripAccess(req, id);
  if (access.error) return access.error;
  return idempotent(req, `trip-pay:${id}`, async () => {
    try {
      const t = await getTrip(id);
      if (!t) return NextResponse.json({ ok: false, error: "Trip not found", code: "NOT_FOUND" }, { status: 404 });
      if (t.state !== "quoted") return NextResponse.json({ ok: false, error: `Trip is ${t.state}`, code: "CONFLICT", approveUrl: t.order?.approveUrl }, { status: 409 });
      const b = await body<{ confirmation?: unknown }>(req);
      const c = checkConfirmation(b.confirmation, /\b(yes|confirm|book it|go ahead|proceed|pay)\b/i);
      const order = await createOrder({
        amount: t.quote.total,
        currency: t.quote.payCurrency,
        description: `Flight ${t.flight.airline} ${t.flight.origin}-${t.flight.destination} ${t.searchedFor.date}`,
        referenceId: t.id,
        kind: "trip",
      });
      const at = new Date().toISOString();
      t.order = order;
      t.confirmation = { ...c, at };
      t.state = "awaiting_payment";
      t.timeline.push({ state: "awaiting_payment", at, by: c.by, note: `Confirmed (${access.via === "agent" ? "in room" : "on trip page"}): "${c.text}". PayPal sandbox order ${order.id} created.` });
      await saveTrip(t);
      await record({ kind: "confirmation", subject: t.id, actor: c.by, summary: `Confirmed booking: "${c.text}"` });
      await record({ kind: "paypal", subject: t.id, actor: "agent", summary: `PayPal sandbox order ${order.id} created for ${t.quote.total} ${t.quote.payCurrency} (${order.status})` });
      log("info", "trip.order_created", { trip: t.id, order: order.id, via: access.via });
      return NextResponse.json({ ok: true, trip: t, approveUrl: order.approveUrl, next: "Send the approve link to the payer. After they approve, call capture." });
    } catch (e) {
      return fail(e, "POST /api/trips/:id/pay");
    }
  });
}
