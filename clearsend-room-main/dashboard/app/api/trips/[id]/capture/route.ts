import { NextResponse } from "next/server";
import { record } from "@/lib/activity";
import { requireTripAccess } from "@/lib/auth";
import { fail } from "@/lib/http";
import { idempotent } from "@/lib/idem";
import { log } from "@/lib/log";
import { captureOrder, getOrder } from "@/lib/paypal";
import { getTrip, saveTrip } from "@/lib/trips";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const access = requireTripAccess(req, id);
  if (access.error) return access.error;
  return idempotent(req, `trip-capture:${id}`, async () => {
    try {
      const t = await getTrip(id);
      if (!t) return NextResponse.json({ ok: false, error: "Trip not found", code: "NOT_FOUND" }, { status: 404 });
      if (t.state !== "awaiting_payment" || !t.order) return NextResponse.json({ ok: false, error: `Trip is ${t.state}`, code: "CONFLICT" }, { status: 409 });
      const o = await getOrder(t.order.id);
      if (o.status !== "APPROVED") return NextResponse.json({ ok: false, error: `PayPal order is ${o.status}; the payer has not approved it yet.`, code: "CONFLICT", approveUrl: t.order.approveUrl }, { status: 409 });
      const c = await captureOrder(t.order.id);
      if (c.status !== "COMPLETED") return NextResponse.json({ ok: false, error: `Capture status ${c.status}`, code: "UPSTREAM_ERROR" }, { status: 502 });
      const at = new Date().toISOString();
      t.order = { ...t.order, status: c.status, captureId: c.captureId };
      t.state = "paid";
      t.timeline.push({ state: "paid", at, by: access.via === "agent" ? "agent" : "payer (web)", note: `PayPal sandbox capture ${c.captureId} ${c.captureStatus}. ${t.ticketing}` });
      await saveTrip(t);
      await record({ kind: "paypal", subject: t.id, actor: "agent", summary: `Captured ${t.quote.total} ${t.quote.payCurrency} in PayPal sandbox (capture ${c.captureId})` });
      log("info", "trip.captured", { trip: t.id, capture: c.captureId });
      return NextResponse.json({ ok: true, trip: t });
    } catch (e) {
      return fail(e, "POST /api/trips/:id/capture");
    }
  });
}
