import { redis, storeConfigured } from "./store";
import { clientIp } from "./http";
import { hasServiceKey } from "./auth";

/** Fixed-window per-IP limit in Upstash (one INCR + EXPIRE). Service-key calls (the agent) are exempt. */
export async function rateLimit(req: Request, bucket: string, limit: number, windowSec: number) {
  if (!storeConfigured() || hasServiceKey(req)) return;
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const k = `room:rl:${bucket}:${clientIp(req)}:${win}`;
  let n = 0;
  try {
    n = Number(await redis("INCR", k));
    if (n === 1) await redis("EXPIRE", k, windowSec + 5);
  } catch {
    return; // storage hiccup: do not block, the route itself will fail honestly if storage is down
  }
  if (n > limit) throw Object.assign(new Error(`Too many requests: ${limit} per ${windowSec}s for ${bucket}. Try again shortly.`), { status: 429 });
}
