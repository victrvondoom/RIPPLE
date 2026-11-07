import { useEffect, useRef, useState } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { Empty, Loading, Status, useToast } from '../components/ui';

type Msg = { who: 'you' | 'agent'; text: string; links?: { label: string; href: string }[] };
const SR: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : undefined;

/**
 * Case review over a REAL mission: steps are its completion criteria, the table is its actions, the chat is the
 * RIPPLE console (same interpreter and confirmation rules as the Switch room), annotations are posted to the mission room.
 */
export function CaseReview() {
  const { data: ov } = useApi<any>('/overview', 10000);
  const [id, setId] = useState<string>('');
  const missions: any[] = ov?.missions ?? [];
  useEffect(() => { if (!id && missions.length) setId((missions.find((x) => !['completed', 'cancelled'].includes(x.state)) ?? missions[0]).id); }, [id, missions]);
  const { data: m, reload } = useApi<any>(id ? `/missions/${id}` : null, 6000);
  const [tab, setTab] = useState<'Chat' | 'Annotations' | 'Details'>('Chat');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState<'idle' | 'listening' | 'unsupported' | 'denied'>('idle');
  const rec = useRef<any>(null);
  const toast = useToast();

  if (!ov) return <Loading />;
  if (!missions.length) return <Empty>No cases yet. Start one from Workflow Packs, or say “start demo revenue-recovery” in the Switch room.</Empty>;
  if (!m) return <Loading />;

  const checks: any[] = m.completion.checks;
  const flagged = checks.filter((c) => !c.passed);
  const annotations = m.messages.filter((x: any) => x.sender_kind === 'human');
  const ask = async (q: string) => {
    if (busy) return; setBusy(true); setMsgs((x) => [...x, { who: 'you', text: q }]);
    try { const r = await api<any>('POST', '/console/say', { text: q }); const out = r.messages[1]; setMsgs((x) => [...x, { who: 'agent', text: out.body, links: out.data?.links }]); if (out.data?.navigate) go(out.data.navigate); reload(); }
    catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  const annotate = async (text: string) => {
    try { await api('POST', `/missions/${id}/messages`, { body: `Annotation: ${text}` }); reload(); setTab('Annotations'); } catch (e) { toast.err(e); }
  };
  const voice = () => {
    if (!SR) { setMic('unsupported'); return; }
    if (mic === 'listening') { rec.current?.stop(); return; }
    const r = new SR(); rec.current = r; r.lang = navigator.language || 'en-US';
    r.onresult = (e: any) => setDraft(e.results[0][0].transcript);
    r.onerror = (e: any) => setMic(e.error === 'not-allowed' ? 'denied' : 'idle');
    r.onend = () => setMic((s) => (s === 'listening' ? 'idle' : s));
    setMic('listening'); r.start();
  };
  const suggestions = [
    flagged.length ? 'what needs attention' : 'status',
    m.questions.some((q: any) => q.status === 'open') ? 'list questions' : 'list approvals',
    m.actions.some((a: any) => ['approved', 'failed', 'execution_unknown'].includes(a.status)) ? 'list actions' : 'brief me',
  ];
  const current = m.actions.filter((a: any) => a.current);
  return <div className="case-layout">
    <section>
      <div className="row between">
        <p className="muted small" style={{ margin: 0 }}>{m.mission.pack_name} · {m.mission.domain} · <span className={`badge ${flagged.length ? 'b-warn' : 'b-ok'}`}>{flagged.length ? `${flagged.length} criteria open` : 'all criteria met'}</span></p>
        <select aria-label="Case" value={id} onChange={(e) => { setId(e.target.value); setMsgs([]); }} style={{ width: 'auto', maxWidth: 340 }}>{missions.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
      </div>
      <h2><a href={`#/mission/${id}`}>{m.mission.title}</a></h2>
      <p>State <Status s={m.mission.state} /> · {m.mission.state_reason || m.mission.state_label}</p>
      <ol className="pipeline" aria-label="Completion criteria">
        {checks.map((c) => <li key={c.key} className={c.passed ? 'ok' : 'flag'} title={c.detail}><i>{c.passed ? '✓' : '!'}</i><span>{c.label}</span></li>)}
      </ol>
      <div className="card">
        <div className="row between"><strong>Actions</strong><span className="muted small">analysis rev {m.mission.analysis_rev}</span></div>
        {current.length ? <table className="tbl"><thead><tr><th>Action</th><th>Connector</th><th>Status</th><th>Approved by</th><th>Attempts</th></tr></thead>
          <tbody>{current.map((a: any) => <tr key={a.id}><td>{a.title}</td><td>{a.connector} ({a.connector_mode})</td><td><Status s={a.status} /></td><td>{a.approval?.decided_by_name ?? '—'}</td><td>{a.attempts}</td></tr>)}</tbody></table>
          : <p className="muted small">No actions proposed yet{m.questions.some((q: any) => q.status === 'open' && q.blocking) ? ': a blocking question needs an answer first.' : '.'}</p>}
        <p className="muted small">{m.evidence.length} evidence record(s) · {m.evidence.filter((e: any) => e.passed).length} passed.</p>
      </div>
    </section>
    <aside className="case-chat" aria-label="Case assistant">
      <div className="tabs">{(['Chat', 'Annotations', 'Details'] as const).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}{t === 'Annotations' && annotations.length ? ` ${annotations.length}` : ''}</button>)}</div>
      {tab === 'Chat' && <div className="chat-body">
        {!msgs.length && <><h3>Let's review this.</h3><p className="muted small">The assistant is the RIPPLE console: it answers from recorded state, and anything that changes state asks you to confirm.</p>
          {suggestions.map((q) => <button key={q} className="ask" onClick={() => ask(q)} disabled={busy}>{q} <span>↗</span></button>)}</>}
        {msgs.map((x, i) => <div key={i}><p className={`bubble ${x.who}`} style={{ whiteSpace: 'pre-wrap' }}>{x.text}</p>{x.links?.map((l, j) => <a key={j} className="chip" href={l.href} style={{ marginRight: 4 }}>{l.label} →</a>)}</div>)}
      </div>}
      {tab === 'Annotations' && <div className="chat-body">{annotations.length ? annotations.map((n: any) => <p key={n.id} className="bubble you"><strong>{n.sender_name}</strong> · {fmtTime(n.created_at)}<br />{n.body}</p>) : <p className="muted small">No annotations yet. Type a note below and press “Annotate”; it is posted to the mission room.</p>}</div>}
      {tab === 'Details' && <div className="chat-body small">
        <p>Criteria open: {flagged.length} of {checks.length}</p>
        {flagged.map((c) => <p key={c.key} className="muted">• {c.label}: {c.detail}</p>)}
        <p>Questions open: {m.questions.filter((q: any) => q.status === 'open').length} · Approvals pending: {m.approvals.filter((a: any) => a.status === 'pending').length}</p>
        <p>Agents: {m.agents.map((a: any) => `${a.name} (${a.status})`).join(', ')}</p>
      </div>}
      {mic === 'listening' && <p className="mic-pop">● Listening… speak now</p>}
      {mic === 'unsupported' && <p className="mic-pop">Voice input needs a browser with speech recognition (e.g. Chrome).</p>}
      {mic === 'denied' && <p className="mic-pop">Microphone access was blocked. Allow it in the browser and try again.</p>}
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (!t) return; setDraft(''); if (tab === 'Annotations') void annotate(t); else void ask(t); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask anything about this case…" aria-label="Message" disabled={busy} />
        <button type="button" className="sm" onClick={voice} aria-label="Voice input">🎤</button>
        <button type="button" className="sm" onClick={() => { const t = draft.trim(); if (t) { setDraft(''); void annotate(t); } }}>Annotate</button>
      </form>
    </aside>
  </div>;
}
