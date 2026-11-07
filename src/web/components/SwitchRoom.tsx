import { useEffect, useRef, useState } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { useToast } from './ui';
import type { Me } from '../App';

const DOT: Record<string, string> = { connected: 'on', off: 'off', not_configured: 'warn', unreachable: 'bad', disconnected: 'warn' };
const STATUS_LABEL: Record<string, string> = { connected: 'Connected to Switch', off: 'Switch is off — chatting with RIPPLE here only', not_configured: 'Switch is not set up on this server — chatting here only', unreachable: 'Switch did not answer — chatting here only', disconnected: 'Switch was disconnected — chatting here only' };
const SUGGEST = ['what needs attention', 'status', 'list approvals', 'list questions', 'brief me', 'verify the ledger'];

/**
 * The Switch room: reachable from every page. Talk to RIPPLE in plain language; anything that changes state is proposed first
 * and runs only after you confirm, under your own identity and role. The switch toggles the connection to a Switch room;
 * the console works locally either way.
 */
export function SwitchRoom({ me, mode = 'dock' }: { me: Me; mode?: 'dock' | 'page' }) {
  const [open, setOpen] = useState(mode === 'page');
  const { data, reload, setData } = useApi<any>('/console', open ? 4000 : 20000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const toast = useToast();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canToggle = ['owner', 'manager'].includes(me.user.role);
  const st = data?.state;
  const count = data?.messages?.length ?? 0;

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [open, count]);
  useEffect(() => { if (open && mode === 'dock') inputRef.current?.focus(); }, [open, mode]);
  useEffect(() => {
    if (mode !== 'dock') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [mode]);

  const after = (msgs: any[]) => {
    setData((d: any) => d ? { ...d, messages: [...d.messages, ...msgs] } : d);
    const nav = msgs.map((m) => m.data?.navigate).find(Boolean);
    if (nav) go(nav);
    void reload();
  };
  const send = async (t: string) => {
    const body = t.trim(); if (!body || busy) return;
    setBusy(true); setText('');
    try { const r = await api<any>('POST', '/console/say', { text: body }); after(r.messages); }
    catch (e) { toast.err(e); setText(body); } finally { setBusy(false); }
  };
  const confirm = async (id: string) => { setBusy(true); try { const r = await api<any>('POST', `/console/confirm/${id}`); after([r.message]); } catch (e) { toast.err(e); void reload(); } finally { setBusy(false); } };
  const cancel = async (id: string) => { setBusy(true); try { await api('POST', `/console/cancel/${id}`); void reload(); } catch (e) { toast.err(e); } finally { setBusy(false); } };
  const toggle = async () => {
    if (!st) return; setBusy(true);
    try { const s = await api<any>('POST', '/console/switch', { enabled: !st.enabled }); setData((d: any) => d ? { ...d, state: s } : d); void reload(); }
    catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;
  const listen = () => {
    if (!SR) return;
    const rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (ev: any) => { const said = ev.results?.[0]?.[0]?.transcript ?? ''; setText(said); if (said) void send(said); };
    rec.onend = () => setListening(false); rec.onerror = () => setListening(false);
    setListening(true); rec.start();
  };

  const panel = <section className={`sw-panel ${mode === 'page' ? 'sw-page' : ''}`} aria-label="Switch room">
    <header className="sw-head">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="sw-title"><span className={`sw-dot ${DOT[st?.status] ?? 'off'}`} aria-hidden /> Switch room</div>
          <div className="sw-sub">{st ? STATUS_LABEL[st.status] ?? st.status : 'Loading…'}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button role="switch" aria-checked={!!st?.enabled} aria-label="Connect to Switch" className={`sw-toggle ${st?.enabled ? 'on' : ''}`} disabled={!canToggle || busy || !st} onClick={toggle} title={canToggle ? 'Turn the Switch connection on or off' : 'Only a manager or owner can change the Switch connection'}><span /></button>
          {mode === 'dock' && <button className="sm sw-x" aria-label="Close Switch room" onClick={() => setOpen(false)}>✕</button>}
        </div>
      </div>
      {st && <details className="sw-detail"><summary>Technical details</summary><div>{st.detail}</div><div className="sw-mute">Interpreter: {st.interpreter}. Changes need your confirmation and your role.</div></details>}
    </header>
    <div className="sw-log" aria-live="polite">
      {!data && <div className="sw-mute">Loading…</div>}
      {data && !data.messages.length && <div className="sw-hello"><strong>Ask RIPPLE anything about your missions, or tell it what to do.</strong><div>Try “what needs attention”, “list approvals” or “approve 1”.</div></div>}
      {data?.messages.map((m: any) => <Msg key={m.id} m={m} onConfirm={confirm} onCancel={cancel} busy={busy} canAct={me.user.role !== 'viewer'} />)}
      <div ref={endRef} />
    </div>
    <div className="sw-suggest">{SUGGEST.map((s) => <button key={s} className="chip" disabled={busy} onClick={() => send(s)}>{s}</button>)}</div>
    <form className="sw-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
      <input ref={inputRef} aria-label="Message RIPPLE" value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? 'Listening…' : 'Type a message, e.g. “approve 1”'} maxLength={1000} disabled={busy} />
      {SR && <button type="button" className={`sm ${listening ? 'primary' : ''}`} onClick={listen} disabled={busy || listening} aria-label="Speak a message">🎙</button>}
      <button className="primary sm" type="submit" disabled={busy || !text.trim()}>{busy ? '…' : 'Send'}</button>
    </form>
  </section>;

  if (mode === 'page') return panel;
  return <>
    {!open && <button className="sw-fab" onClick={() => setOpen(true)} aria-label="Open the Switch room (Ctrl+K)" title="Switch room (Ctrl+K)">
      <span className={`sw-dot ${DOT[st?.status] ?? 'off'}`} aria-hidden /> Switch room
    </button>}
    {open && <div className="sw-drawer">{panel}</div>}
  </>;
}

function Msg({ m, onConfirm, onCancel, busy, canAct }: { m: any; onConfirm: (id: string) => void; onCancel: (id: string) => void; busy: boolean; canAct: boolean }) {
  const d = m.data ?? {};
  const pending = d.pending && !d.resolved && Date.parse(d.pending.expiresAt) > Date.now();
  return <div className={`sw-msg sw-${m.author}`}>
    <div className="sw-meta">{m.author_name}{m.author === 'switch' && <span className="badge b-warn" style={{ marginLeft: 6 }}>from the Switch room · advice only</span>}{d.interpreter && d.interpreter !== 'deterministic' && <span className="badge b-info" style={{ marginLeft: 6 }}>{d.interpreter}</span>} · {fmtTime(m.created_at)}</div>
    <div className="sw-body">{m.body}</div>
    {d.links?.length > 0 && <div className="sw-links">{d.links.map((l: any, i: number) => <a key={i} className="chip" href={l.href}>{l.label} →</a>)}</div>}
    {d.pending && <div className="sw-pending">
      {pending ? (canAct ? <><span className="small" style={{ marginRight: 8 }}>Do this now, under your name?</span><button className="primary sm" disabled={busy} onClick={() => onConfirm(m.id)}>Yes, do it</button><button className="sm" disabled={busy} onClick={() => onCancel(m.id)}>No</button></> : <span className="small">A manager has to say yes to this.</span>)
        : <span className={`badge ${d.result === 'done' ? 'b-ok' : d.result === 'refused' ? 'b-bad' : ''}`}>{d.result === 'done' ? `confirmed by ${d.confirmedBy}` : d.result === 'refused' ? `refused: ${d.error}` : d.result === 'cancelled' ? `cancelled by ${d.cancelledBy}` : 'expired'}</span>}
    </div>}
  </div>;
}
