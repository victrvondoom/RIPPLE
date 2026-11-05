import { NextResponse } from "next/server";
import { redis, storeConfigured } from "./store";

/**
 * Idempotency for money-moving routes. If the caller sends `Idempotency-Key`, the first
 * successful/declined response is stored for 24h and replayed for repeats with the same key.
 * A concurrent duplicate gets 409 while the first is still running.
 */
export async function idempotent(req: Request, scope: string, run: () => Promise<NextResponse>): Promise<NextResponse> {
  const key = req.headers.get("idempotency-key");
  if (!key || !storeConfigured()) return run();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return NextResponse.json({ ok: false, error: "Idempotency-Key must be 8-80 chars [A-Za-z0-9_-]", code: "BAD_REQUEST" }, { status: 400 });
  const k = `room:idem:${scope}:${key}`;
  const claimed = await redis<string | null>("SET", k, JSON.stringify({ pending: true }), "NX", "EX", 120);
  if (claimed !== "OK") {
    const raw = await redis<string | null>("GET", k);
    const prev = raw ? (JSON.parse(raw) as { pending?: boolean; status?: number; body?: unknown }) : null;
    if (prev?.pending) return NextResponse.json({ ok: false, error: "The same request is still running.", code: "CONFLICT" }, { status: 409 });
    if (prev) return NextResponse.json(prev.body, { status: prev.status, headers: { "idempotent-replay": "true" } });
  }
  try {
    const res = await run();
    const json = await res.clone().json().catch(() => null);
    if (res.status >= 500) await redis("DEL", k);
    else await redis("SET", k, JSON.stringify({ status: res.status, body: json }), "EX", 86400);
    return res;
  } catch (e) {
    await redis("DEL", k);
    throw e;
  }
}
