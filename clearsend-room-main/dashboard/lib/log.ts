// Structured JSON logs. Never logs secrets: known secret-looking keys and long tokens are redacted.
const SECRET_KEY = /(secret|token|key|authorization|password|email|dob|dateOfBirth)/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v.replace(/[0-9a-f]{40,}/gi, "[redacted]");
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : scrub(x, depth + 1)]));
  }
  return v;
}

export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...(scrub(fields) as object) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
