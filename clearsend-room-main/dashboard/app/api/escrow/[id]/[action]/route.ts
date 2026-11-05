import { NextResponse } from "next/server";
import { checkConfirmation, record } from "@/lib/activity";
import { requireEscrowAccess } from "@/lib/auth";
import { mustGet, nextSteps, transition } from "@/lib/escrow";
import { bad, body, fail, str } from "@/lib/http";
import { idempotent } from "@/lib/idem";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/ratelimit";
import { verifyDeliverable } from "@/lib/llm";
import { captureOrder, createOrder, createPayout, getOrder, refundCapture } from "@/lib/paypal";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WHO: Record<string, string[]> = {
  fund: ["agent", "payer"],
  capture: ["agent", "payer"],
  submit: ["agent", "recipient"],
  verify: ["agent", "verifier"],
  release: ["agent", "verifier"],
  refund: ["agent", "payer", "verifier"],
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (!WHO[action]) return NextResponse.json({ ok: false, error: `Unknown action ${action}` }, { status: 404 });
  const access = requireEscrowAccess(req, id, WHO[action]);
  if (access.error) return access.error;
  if (action === "verify") {
    try {
      await rateLimit(req, "verify", 10, 3600);
    } catch (err) {
      return fail(err, "POST /api/escrow/:id/verify");
    }
  }
  const money = ["fund", "capture", "release", "refund"].includes(action);
  return money ? idempotent(req, `escrow-${action}:${id}`, () => run(req, id, action, access.role!)) : run(req, id, action, access.role!);
}

async function run(req: Request, id: string, action: string, role: string) {
  try {
    const b = await body<{ confirmation?: unknown; deliverable?: string; by?: string; note?: string }>(req);
    let extra: Record<string, unknown> = {};
    let e;
    switch (action) {
      case "fund": {
        const c = checkConfirmation(b.confirmation, /\b(yes|confirm|fund|go ahead|proceed|pay)\b/i);
        e = await transition(id, ["created"], async (x) => {
          if (x.order?.approveUrl && x.order.status !== "VOIDED") {
            extra = { approveUrl: x.order.approveUrl, reused: true };
            return { note: "", by: c.by };
          }
          const order = await createOrder({ amount: x.quote.total, currency: x.payCurrency, description: `Escrow: ${x.title}`, referenceId: x.id, kind: "escrow" });
          x.order = order;
          x.approvals.push({ ...c, action: "fund", at: new Date().toISOString() });
          extra = { approveUrl: order.approveUrl };
          await record({ kind: "confirmation", subject: x.id, actor: c.by, summary: `Payer confirmed funding: "${c.text}"` });
          await record({ kind: "paypal", subject: x.id, actor: "agent", summary: `PayPal sandbox order ${order.id} created for ${x.quote.total} ${x.payCurrency}` });
          return { note: "", by: c.by };
        });
        break;
      }
      case "capture":
        e = await transition(id, ["created"], async (x) => {
          if (!x.order) bad("No PayPal order yet; fund first.", 409);
          const o = await getOrder(x.order!.id);
          if (o.status !== "APPROVED") bad(`PayPal order is ${o.status}; the payer has not approved it yet.`, 409);
          const cap = await captureOrder(x.order!.id);
          if (cap.status !== "COMPLETED" || !cap.captureId) bad(`Capture status ${cap.status}`, 502);
          x.order = { ...x.order!, status: cap.status, captureId: cap.captureId };
          await record({ kind: "paypal", subject: x.id, actor: "agent", summary: `Captured ${x.quote.total} ${x.payCurrency} into escrow (capture ${cap.captureId})` });
          return { next: "funded", note: `PayPal capture ${cap.captureId}`, by: "agent" };
        });
        break;
      case "submit": {
        const text = str(b.deliverable, "deliverable", 12000);
        const by = role === "recipient" ? "recipient" : str(b.by, "by (chat username of the recipient)", 80);
        e = await transition(id, ["funded", "rejected"], async (x) => {
          x.deliverable = { text, by, at: new Date().toISOString() };
          await record({ kind: "escrow", subject: x.id, actor: by, summary: `Deliverable submitted (${text.length} chars) for "${x.title}"` });
          return { next: "submitted", note: `Deliverable posted by ${by}`, by };
        });
        break;
      }
      case "verify":
        e = await transition(id, ["submitted"], async (x) => {
          const d = await verifyDeliverable(x.spec, x.criteria, x.deliverable!.text);
          x.decisions.push(d);
          await record({ kind: "decision", subject: x.id, actor: d.model, summary: `${d.met ? "VERIFIED" : "REJECTED"}: ${d.summary}`, data: { criteria: d.criteria } });
          extra = { decision: d };
          return { next: d.met ? "verified" : "rejected", note: d.summary, by: d.model };
        });
        break;
      case "release": {
        const c = checkConfirmation(b.confirmation, /\b(approve|release|yes|confirm)\b/i);
        e = await transition(id, ["verified"], async (x) => {
          if (c.by.toLowerCase() === x.recipient.name.toLowerCase()) bad("The recipient cannot approve their own release.", 403);
          const p = await createPayout({ referenceId: x.id, email: x.recipient.email, amount: x.amount, currency: x.currency, note: `ClearSend Room escrow: ${x.title}` });
          x.payout = p;
          x.approvals.push({ ...c, action: "release", at: new Date().toISOString() });
          await record({ kind: "confirmation", subject: x.id, actor: c.by, summary: `Release approved: "${c.text}"` });
          await record({ kind: "paypal", subject: x.id, actor: "agent", summary: `PayPal payout batch ${p.batchId} (${p.status}) ${x.amount} ${x.currency} to ${x.recipient.country}` });
          return { next: "released", note: `Approved by ${c.by}; payout ${p.batchId}`, by: c.by };
        });
        break;
      }
      case "refund": {
        const c = checkConfirmation(b.confirmation, /\b(refund|yes|confirm)\b/i);
        e = await transition(id, ["funded", "submitted", "rejected"], async (x) => {
          if (!x.order?.captureId) bad("Nothing captured to refund.", 409);
          const r = await refundCapture(x.order!.captureId!, `ClearSend Room escrow refund: ${x.title}`);
          x.refund = r;
          x.approvals.push({ ...c, action: "refund", at: new Date().toISOString() });
          await record({ kind: "paypal", subject: x.id, actor: "agent", summary: `Refund ${r.id} (${r.status}) approved by ${c.by}` });
          return { next: "refunded", note: `Refund ${r.id} approved by ${c.by}`, by: c.by };
        });
        break;
      }
    }
    e = e ?? (await mustGet(id));
    log("info", "escrow.action", { escrow: id, action, role, state: e.state });
    return NextResponse.json({ ok: true, state: e.state, escrow: e, nextSteps: nextSteps(e), ...extra });
  } catch (err) {
    return fail(err, `POST /api/escrow/:id/${action}`);
  }
}
