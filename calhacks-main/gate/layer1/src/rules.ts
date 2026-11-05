import { sameAddress } from "./lookalike.ts";
import type { Check, GateInput, Layer1Context, Layer1Result, RuleId } from "./types.ts";

const EPS = 1e-9;

function toBaseUnits(usd: number, decimals: number): bigint {
  return BigInt(Math.round(usd * 10 ** decimals));
}

export function isKnownWallet(x: GateInput): boolean {
  return x.references.known_sellers.some((k) => sameAddress(k.pay_to, x.listing.checkout.pay_to));
}

// Every rule runs and reports; any failed check means skip. Checks come back in RULE_IDS order.
export function checkLayer1(x: GateInput, ctx: Layer1Context): Layer1Result {
  const { listing: l, mandate: m } = x;
  const { allowlist } = ctx;
  const co = l.checkout;
  const checks: Check[] = [];
  const add = (rule: RuleId, passed: boolean, detail: string | null = null) => checks.push({ rule, passed, detail });

  add("L1_PAYTO_MISMATCH", sameAddress(co.pay_to, l.seller.pay_to),
    sameAddress(co.pay_to, l.seller.pay_to) ? null : `402 pays ${co.pay_to}, store.json says ${l.seller.pay_to}`);

  // Seller trust: a known wallet is trusted; an unknown wallet only up to the cap (then Layer 2 decides).
  const known = isKnownWallet(x);
  add("L1_UNKNOWN_SELLER_CAP", known || l.item.price <= allowlist.unknown_seller_cap_usd + EPS,
    known ? "known wallet" : `unknown wallet: price ${l.item.price} vs cap ${allowlist.unknown_seller_cap_usd}`);

  let charged = Number.POSITIVE_INFINITY;
  let amountOk = false;
  if (/^[0-9]+$/.test(co.amount)) {
    const amount = BigInt(co.amount);
    amountOk = amount === toBaseUnits(l.item.price, allowlist.usdc_decimals);
    charged = Number(amount) / 10 ** allowlist.usdc_decimals;
  }
  add("L1_AMOUNT_MISMATCH", amountOk, amountOk ? null : `402 amount ${co.amount} vs listed ${l.item.price}`);

  const cost = Math.max(l.item.price, charged);
  add("L1_OVER_MAX", cost <= m.max_price + EPS, `cost ${cost} vs max ${m.max_price}`);
  add("L1_OVER_BUDGET", cost <= m.spend_remaining + EPS, `cost ${cost} vs remaining ${m.spend_remaining}`);

  add("L1_NETWORK", allowlist.networks.includes(co.network), co.network);
  const asset = allowlist.assets[co.network];
  add("L1_ASSET", Boolean(asset) && sameAddress(asset, co.asset), co.asset);
  add("L1_ITEM_MISMATCH", co.item_id === l.item.id, co.item_id === l.item.id ? null : `checkout ${co.item_id} vs listing ${l.item.id}`);
  add("L1_PRODUCT_MISMATCH", l.item.product_key === m.product_key,
    l.item.product_key === m.product_key ? null : `listing ${l.item.product_key} vs mandate ${m.product_key}`);

  const t = co.max_timeout_seconds;
  add("L1_TIMEOUT", t == null || (t > 0 && t <= allowlist.max_timeout_s), t == null ? "not provided" : `${t}s`);

  return { listing_id: l.listing_id, checks };
}

export function failedRule(r: Layer1Result): RuleId | null {
  return r.checks.find((c) => !c.passed)?.rule ?? null;
}
