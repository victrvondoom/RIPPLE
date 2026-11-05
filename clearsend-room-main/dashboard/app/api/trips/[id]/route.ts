import { NextResponse } from "next/server";
import { deleteActivity } from "@/lib/activity";
import { hasServiceKey, requireServiceKey, requireTripAccess } from "@/lib/auth";
import { fail } from "@/lib/http";
import { deleteTrip, getTrip, maskTraveller } from "@/lib/trips";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    const t = await getTrip(id);
    if (!t) return NextResponse.json({ ok: false, error: "Trip not found", code: "NOT_FOUND" }, { status: 404 });
    const full = hasServiceKey(req) || !requireTripAccess(req, id).error;
    return NextResponse.json({ ok: true, access: full ? "full" : "public", trip: full ? t : { ...t, travellers: t.travellers.map(maskTraveller), order: t.order ? { id: t.order.id, status: t.order.status, captureId: t.order.captureId } : undefined } });
  } catch (e) {
    return fail(e, "GET /api/trips/:id");
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireServiceKey(req);
  if (denied) return denied;
  try {
    const id = (await params).id;
    const t = await getTrip(id);
    if (!t) return NextResponse.json({ ok: false, error: "Trip not found", code: "NOT_FOUND" }, { status: 404 });
    if (t.state === "paid") return NextResponse.json({ ok: false, error: "Paid trips are kept for the audit trail.", code: "CONFLICT" }, { status: 409 });
    await deleteTrip(id);
    const activity = new URL(req.url).searchParams.get("activity") === "1" ? await deleteActivity({ subject: id }) : 0;
    return NextResponse.json({ ok: true, deleted: id, activityDeleted: activity });
  } catch (e) {
    return fail(e, "DELETE /api/trips/:id");
  }
}
