import { NextResponse } from "next/server";
import { z } from "zod";
import { log } from "./log";

/** Consistent error JSON: { ok:false, error:"message", code:"CODE", issues? } */
export type ApiError = Error & { status?: number; code?: string; issues?: unknown };

const CODES: Record<number, string> = { 400: "BAD_REQUEST", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 422: "UNPROCESSABLE", 423: "LOCKED", 428: "CONFIRMATION_REQUIRED", 429: "RATE_LIMITED", 502: "UPSTREAM_ERROR", 503: "NOT_CONFIGURED" };

export function errorJson(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error: message, code: CODES[status] ?? "ERROR", ...extra }, { status });
}

export function fail(e: unknown, route?: string) {
  const err = e as ApiError;
  const status = typeof err.status === "number" ? err.status : 500;
  if (status >= 500) log("error", "api.error", { route, status, message: err.message });
  else log("warn", "api.reject", { route, status, message: err.message });
  return errorJson(err.message ?? String(e), status, { ...(err.code ? { code: err.code } : {}), ...(err.issues ? { issues: err.issues } : {}) });
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function bad(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export const str = (v: unknown, name: string, max = 2000) => {
  if (typeof v !== "string" || !v.trim()) bad(`${name} is required`);
  return (v as string).trim().slice(0, max);
};

/** Validate with zod; on failure throw a 400 listing each field problem. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw Object.assign(new Error(`Invalid input: ${issues.map((i) => `${i.path || "body"} ${i.message}`).join("; ")}`), { status: 400, issues });
  }
  return r.data;
}

export function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
}
