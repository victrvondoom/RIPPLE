import { NextResponse } from "next/server";
import { appUrl } from "@/lib/links";
import { DEFAULT_MODEL } from "@/lib/llm";
import { paypalConfigured, paypalPing } from "@/lib/paypal";
import { redis, storeConfigured } from "@/lib/store";

export const dynamic = "force-dynamic";

type Check = { configured: boolean; ok: boolean | null; ms?: number; detail: string };
let cache: { at: number; checks: Record<string, Check> } | null = null;

async function timed(configured: boolean, fn: () => Promise<string>): Promise<Check> {
  if (!configured) return { configured, ok: null, detail: "not configured" };
  const t = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise<string>((_, r) => setTimeout(() => r(new Error("timeout after 8s")), 8000))]);
    return { configured, ok: true, ms: Date.now() - t, detail };
  } catch (e) {
    return { configured, ok: false, ms: Date.now() - t, detail: (e as Error).message.slice(0, 160) };
  }
}

async function runChecks() {
  const [storage, paypal, model, fx, openflights] = await Promise.all([
    timed(storeConfigured(), async () => `PING ${await redis<string>("PING")}`),
    timed(paypalConfigured(), async () => (await paypalPing(), "sandbox OAuth token fetched")),
    timed(Boolean(process.env.OPENROUTER_API_KEY), async () => {
      const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, cache: "no-store" });
      if (!r.ok) throw new Error(`OpenRouter key check HTTP ${r.status}`);
      const m = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
      if (!m.endsWith(":free")) throw new Error("configured model is not :free");
      return `key valid; model ${m}`;
    }),
    timed(true, async () => {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
      if (!r.ok) throw new Error(`open.er-api.com HTTP ${r.status}`);
      return "open.er-api.com reachable";
    }),
    timed(true, async () => {
      const r = await fetch("https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat", { method: "HEAD", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return "routes/airports data reachable";
    }),
  ]);
  return {
    storage,
    paypalSandbox: paypal,
    freeModel: model,
    fx,
    openflights,
    skyScrapper: { configured: Boolean(process.env.RAPIDAPI_KEY), ok: null, detail: process.env.RAPIDAPI_KEY ? "configured (not pinged: quota is scarce)" : "not configured: priced fares unavailable" },
    escrowLinkSecret: { configured: Boolean(process.env.ESCROW_LINK_SECRET), ok: null, detail: "presence only" },
    serviceKey: { configured: Boolean(process.env.CLEARSEND_API_KEY), ok: null, detail: "presence only" },
  } as Record<string, Check>;
}

// Real checks, cached for 60s per instance. Never returns secret values.
export async function GET() {
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), checks: await runChecks() };
  const c = cache.checks;
  return NextResponse.json({
    ok: Object.values(c).every((x) => x.ok !== false),
    checkedAt: new Date(cache.at).toISOString(),
    cachedForSeconds: 60,
    dashboardUrl: appUrl(),
    sandboxOnly: true,
    checks: c,
    // Flat booleans kept for the agent CLI and older clients.
    storage: c.storage.ok === true,
    paypalSandbox: c.paypalSandbox.ok === true,
    freeModel: c.freeModel.ok === true,
    skyScrapper: c.skyScrapper.configured,
    openData: ["OpenFlights airports/airlines/routes.dat", "OpenSky REST", "open.er-api.com", "frankfurter.app"],
  });
}
