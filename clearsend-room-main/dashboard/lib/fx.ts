// Real mid-market FX: open.er-api.com first, frankfurter fallback. No hardcoded rates.
export const PLATFORM_FEE_RATE = 0.025;
export const FX_SPREAD_RATE = 0.012;

const cache = new Map<string, { rate: number; source: string; at: number }>();

async function erApi(from: string, to: string) {
  const r = await fetch(`https://open.er-api.com/v6/latest/${from}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`open.er-api.com HTTP ${r.status}`);
  const j = (await r.json()) as { result?: string; rates?: Record<string, number> };
  const rate = j.rates?.[to];
  if (j.result !== "success" || typeof rate !== "number") throw new Error(`open.er-api.com has no ${from}->${to}`);
  return rate;
}

async function frankfurter(from: string, to: string) {
  const r = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`frankfurter HTTP ${r.status}`);
  const j = (await r.json()) as { rates?: Record<string, number> };
  const rate = j.rates?.[to];
  if (typeof rate !== "number") throw new Error(`frankfurter has no ${from}->${to}`);
  return rate;
}

export async function midRate(fromRaw: string, toRaw: string) {
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  if (from === to) return { rate: 1, source: "same-currency" };
  const key = `${from}:${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return { rate: hit.rate, source: hit.source };
  const errors: string[] = [];
  for (const [source, fn] of [["open.er-api.com", erApi], ["frankfurter.app", frankfurter]] as const) {
    try {
      const rate = await fn(from, to);
      cache.set(key, { rate, source, at: Date.now() });
      return { rate, source };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`No FX rate for ${from}->${to}: ${errors.join("; ")}`);
}

export type Quote = {
  baseAmount: number;
  baseCurrency: string;
  payCurrency: string;
  midRate: number;
  appliedRate: number;
  rateSource: string;
  converted: number;
  platformFee: number;
  fxSpreadCost: number;
  total: number;
  quotedAt: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Quote what the payer pays in payCurrency for an amount priced in baseCurrency. */
export async function quote(baseAmount: number, baseCurrency: string, payCurrency: string): Promise<Quote> {
  if (!(baseAmount > 0)) throw new Error("Amount must be positive");
  const { rate, source } = await midRate(baseCurrency, payCurrency);
  const spread = baseCurrency.toUpperCase() === payCurrency.toUpperCase() ? 0 : FX_SPREAD_RATE;
  const converted = baseAmount * rate;
  const fxSpreadCost = converted * spread;
  const platformFee = converted * PLATFORM_FEE_RATE;
  return {
    baseAmount: r2(baseAmount),
    baseCurrency: baseCurrency.toUpperCase(),
    payCurrency: payCurrency.toUpperCase(),
    midRate: rate,
    appliedRate: rate * (1 + spread),
    rateSource: source,
    converted: r2(converted),
    platformFee: r2(platformFee),
    fxSpreadCost: r2(fxSpreadCost),
    total: r2(converted + fxSpreadCost + platformFee),
    quotedAt: new Date().toISOString(),
  };
}
