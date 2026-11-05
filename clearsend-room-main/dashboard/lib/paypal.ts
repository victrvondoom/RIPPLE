// PayPal REST, SANDBOX ONLY. This project never talks to api-m.paypal.com.
import { appUrl } from "./links";

const BASE = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(message: string, public readonly status = 502, public readonly debugId?: string) {
    super(message);
    this.name = "PayPalError";
  }
}

export function paypalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new PayPalError("PayPal sandbox credentials are not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).", 503);
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !j.access_token) throw new PayPalError(`PayPal auth failed: ${j.error_description ?? r.status}`, r.status);
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 300) * 1000 };
  return j.access_token;
}

async function call<T>(path: string, init: RequestInit & { idem?: string } = {}): Promise<T> {
  const token = await accessToken();
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.idem ? { "PayPal-Request-Id": init.idem } : {}),
    },
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as T & { message?: string; debug_id?: string; details?: { issue?: string }[] };
  if (!r.ok) throw new PayPalError(`PayPal ${path} failed: ${j.details?.[0]?.issue ?? j.message ?? r.status}`, r.status, j.debug_id);
  return j;
}

type Link = { href: string; rel: string };
export type PayPalOrder = { id: string; status: string; links?: Link[]; purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[] };

/** PayPal appends ?token=<orderId>&PayerID=... to the return URL, so we return to a neutral page that never carries our own tokens. */
export function returnUrls(kind: "trip" | "escrow", id: string) {
  const q = `kind=${kind}&id=${encodeURIComponent(id)}`;
  return { returnUrl: `${appUrl()}/paypal/return?${q}`, cancelUrl: `${appUrl()}/paypal/cancel?${q}` };
}

export async function createOrder(input: { amount: number; currency: string; description: string; referenceId: string; kind: "trip" | "escrow" }) {
  const urls = returnUrls(input.kind, input.referenceId);
  const order = await call<PayPalOrder>("/v2/checkout/orders", {
    method: "POST",
    idem: `order-${input.referenceId}`,
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: input.referenceId, description: input.description.slice(0, 127), amount: { currency_code: input.currency, value: input.amount.toFixed(2) } }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "ClearSend Room",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: urls.returnUrl,
            cancel_url: urls.cancelUrl,
          },
        },
      },
    }),
  });
  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  return { id: order.id, status: order.status, approveUrl };
}

export async function getOrder(id: string) {
  return call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(id)}`);
}

export async function captureOrder(id: string) {
  const o = await call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: "POST", body: "{}", idem: `capture-${id}` });
  const capture = o.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: o.status, captureId: capture?.id, captureStatus: capture?.status };
}

export async function refundCapture(captureId: string, note: string) {
  return call<{ id: string; status: string }>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: "POST",
    idem: `refund-${captureId}`,
    body: JSON.stringify({ note_to_payer: note.slice(0, 255) }),
  });
}

export async function createPayout(input: { referenceId: string; email: string; amount: number; currency: string; note: string }) {
  const j = await call<{ batch_header: { payout_batch_id: string; batch_status: string } }>("/v1/payments/payouts", {
    method: "POST",
    idem: `payout-${input.referenceId}`,
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: `room-${input.referenceId}`, email_subject: "ClearSend Room escrow released", email_message: input.note.slice(0, 255) },
      items: [{ recipient_type: "EMAIL", receiver: input.email, amount: { value: input.amount.toFixed(2), currency: input.currency }, note: input.note.slice(0, 255), sender_item_id: input.referenceId }],
    }),
  });
  return { batchId: j.batch_header.payout_batch_id, status: j.batch_header.batch_status };
}

/** Cheap real check for /api/health: fetches (or reuses) an OAuth token from the sandbox. */
export async function paypalPing() {
  await accessToken();
  return true;
}
