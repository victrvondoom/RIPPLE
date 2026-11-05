// Upstash Redis REST client. No in-memory fallback: if storage is not configured we fail honestly.
export class StoreError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message);
    this.name = "StoreError";
  }
}

function config() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new StoreError("Storage is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
  return { url: url.replace(/\/$/, ""), token };
}

export function storeConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export async function redis<T = unknown>(...command: (string | number)[]): Promise<T> {
  const { url, token } = config();
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command.map(String)),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new StoreError(`Upstash ${command[0]} failed: ${body.error ?? res.status}`, 502);
  return body.result as T;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis<string | null>("GET", key);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function setJson(key: string, value: unknown) {
  await redis("SET", key, JSON.stringify(value));
}

export async function listJson<T>(indexKey: string, limit = 100): Promise<T[]> {
  const ids = await redis<string[]>("ZREVRANGE", indexKey, 0, limit - 1);
  if (!ids?.length) return [];
  const raws = await redis<(string | null)[]>("MGET", ...ids);
  return raws.filter((r): r is string => Boolean(r)).map((r) => JSON.parse(r) as T);
}

export async function indexAdd(indexKey: string, key: string, score = Date.now()) {
  await redis("ZADD", indexKey, score, key);
}

export async function del(...keys: string[]) {
  await redis("DEL", ...keys);
}

export function newId(prefix: string) {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Date.now().toString(36)}${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
