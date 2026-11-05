// The agent API's origin, inlined at build time (NEXT_PUBLIC_AGENT_API_URL on Vercel).
export const API = process.env.NEXT_PUBLIC_AGENT_API_URL ?? "http://localhost:8000";

// Calls the agent API and returns its JSON body (empty for 204). `json` is sent as the request body. A failed call
// throws the API's own error message.
export async function api<T = unknown>(path: string, { json, ...init }: RequestInit & { json?: unknown } = {}): Promise<T> {
  if (json !== undefined) {
    init = { ...init, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) };
  }
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `The agent API answered ${res.status}.`);
  return body as T;
}
