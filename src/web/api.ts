import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}
/** Loads data, exposes loading/error, optional polling. */
export function useApi<T = any>(path: string | null, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    if (!quiet) setLoading(true);
    try { const d = await api<T>('GET', path); if (alive.current) { setData(d); setError(null); } }
    catch (e) { if (alive.current) setError(e as ApiError); }
    finally { if (alive.current) setLoading(false); }
  }, [path]);
  useEffect(() => { alive.current = true; setData(null); load(); const t = pollMs ? setInterval(() => load(true), pollMs) : undefined; return () => { alive.current = false; if (t) clearInterval(t); }; }, [load, pollMs]);
  return { data, error, loading, reload: () => load(true), setData };
}
export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const go = (hash: string) => { location.hash = hash; };
