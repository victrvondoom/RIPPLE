import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

export const STATE_TONE: Record<string, string> = { draft: '', baseline_ready: 'b-info', analyzing: 'b-info', blocked: 'b-warn', awaiting_approval: 'b-warn', executing: 'b-info', verifying: 'b-info', recovery_required: 'b-bad', completed: 'b-ok', failed: 'b-bad', cancelled: '' };
export const STATE_NAME: Record<string, string> = { draft: 'Draft', baseline_ready: 'Baseline ready', analyzing: 'Analyzing', blocked: 'Blocked', awaiting_approval: 'Awaiting approval', executing: 'Executing', verifying: 'Verifying', recovery_required: 'Recovery required', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
export const StateBadge = ({ state }: { state: string }) => <span className={`badge ${STATE_TONE[state] ?? ''}`}>{STATE_NAME[state] ?? state}</span>;
const AT: Record<string, string> = { proposed: 'b-warn', approved: 'b-info', executed: 'b-info', verified: 'b-ok', failed: 'b-bad', verification_failed: 'b-bad', execution_unknown: 'b-bad', stale: 'b-bad', rejected: '', superseded: '', pending: 'b-warn', acknowledged: 'b-ok', open: 'b-warn', done: 'b-ok', answered: 'b-ok', working: 'b-info', waiting_on_human: 'b-warn', idle: '', draft: 'b-info', provisional: 'b-warn' };
export const Status = ({ s }: { s: string }) => <span className={`badge ${AT[s] ?? ''}`}>{s.replace(/_/g, ' ')}</span>;
export const Banner = ({ tone, title, children }: { tone: 'warn' | 'bad' | 'ok' | 'info'; title?: string; children?: ReactNode }) => <div className={`banner ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>{title && <strong>{title}</strong>}{children}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Loading = () => <div className="empty" aria-busy="true"><span className="spin" /> Loading…</div>;
export const ErrorView = ({ error, retry }: { error: ApiError | Error; retry?: () => void }) => <Banner tone="bad" title="Something went wrong">{error.message} {retry && <button className="sm" onClick={retry}>Retry</button>}</Banner>;

type Toast = { msg: string; err?: boolean } | null;
const ToastCtx = createContext<{ ok: (m: string) => void; err: (e: unknown) => void }>({ ok: () => {}, err: () => {} });
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const show = useCallback((x: Toast) => { setT(x); setTimeout(() => setT(null), 5000); }, []);
  return <ToastCtx.Provider value={{ ok: (m) => show({ msg: m }), err: (e) => show({ msg: e instanceof Error ? e.message : String(e), err: true }) }}>{children}{t && <div className={`toast ${t.err ? 'err' : ''}`} role="status">{t.msg}</div>}</ToastCtx.Provider>;
}
/** Runs an API call; toast only after the server confirms (success) or rejects (error). */
export function useAction() {
  const toast = useToast(); const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(key);
    try { const r = await fn(); if (okMsg) toast.ok(okMsg); return r; } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  return { busy, run };
}
