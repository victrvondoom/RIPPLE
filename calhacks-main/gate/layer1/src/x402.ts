import type { Address, Checkout } from "./types.ts";

interface Accept {
  scheme: string;
  network: string;
  amount: string | number;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds?: number;
}

interface PaymentRequiredHeader {
  x402Version: number;
  resource?: { url?: string };
  accepts: Accept[];
}

// Decode a PAYMENT-REQUIRED header (base64 JSON, x402 v2) into the Checkout the Gate checks: accepts[0].
// item_id is the last path segment of resource.url (/api/checkout/{id}) unless given explicitly.
export function decodePaymentRequired(header: string, itemId?: string): Checkout {
  const body = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentRequiredHeader;
  const first = body.accepts?.[0];
  if (!first) throw new Error("PAYMENT-REQUIRED header has no accepts[] entry");
  const id = itemId ?? body.resource?.url?.split("?")[0].split("/").filter(Boolean).pop();
  if (!id) throw new Error("cannot tell which item the 402 charges for (no resource.url)");
  return {
    pay_to: first.payTo,
    amount: String(first.amount),
    network: first.network,
    asset: first.asset,
    item_id: decodeURIComponent(id),
    max_timeout_seconds: first.maxTimeoutSeconds ?? null,
  };
}
