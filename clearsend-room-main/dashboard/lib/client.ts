"use client";
// Browser helper: JSON fetch with consistent errors and an Idempotency-Key for money-moving calls.
export class ApiFail extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (init.idempotent) headers["idempotency-key"] = crypto.randomUUID().replace(/-/g, "");
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? (init.body ? "POST" : "GET"), headers, body: init.body ? JSON.stringify(init.body) : undefined, cache: "no-store" });
  } catch {
    throw new ApiFail("Network error: could not reach the ClearSend API.", 0);
  }
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string; code?: string };
  if (!res.ok || json.ok === false) throw new ApiFail(json.error ?? `HTTP ${res.status}`, res.status, json.code);
  return json;
}

// Private links the payer created on this device (trip tokens, escrow role tokens). Never sent to PayPal.
type Cred = { kind: "trip"; id: string; token: string } | { kind: "escrow"; id: string; role: string; token: string };
const KEY = "clearsend-room:creds";
export function saveCred(c: Cred) {
  const all = loadCreds().filter((x) => !(x.kind === c.kind && x.id === c.id && ("role" in x ? x.role : "") === ("role" in c ? c.role : "")));
  localStorage.setItem(KEY, JSON.stringify([c, ...all].slice(0, 50)));
}
export function loadCreds(): Cred[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Cred[];
  } catch {
    return [];
  }
}
export function findCred(kind: "trip" | "escrow", id: string) {
  return loadCreds().find((c) => c.kind === kind && c.id === id && (c.kind === "trip" || c.role === "payer")) ?? null;
}
