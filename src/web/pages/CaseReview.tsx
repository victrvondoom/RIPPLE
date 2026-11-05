import { useRef, useState } from 'react';

type StepState = 'ok' | 'flag';
const STEPS: { label: string; state: StepState }[] = [
  { label: 'Bank deposit', state: 'ok' }, { label: 'Signed client agreement', state: 'ok' },
  { label: 'Signed fee agreement', state: 'ok' }, { label: 'Signed distribution', state: 'ok' },
  { label: 'Distribution proposal', state: 'flag' }, { label: 'Distribution draft', state: 'ok' },
  { label: 'Fee check', state: 'flag' }, { label: 'Human review', state: 'flag' },
];
const ROW = { client: 'Client A', gross: 3750000, cost: 135000, fee: 937500, net: 2677500 };
const usd = (n: number) => '$' + n.toLocaleString('en-US');
const feePct = (ROW.fee / ROW.gross) * 100;
const netCheck = ROW.gross - ROW.cost - ROW.fee;

const ANSWERS: Record<string, string> = {
  'Start the analysis': `Gross ${usd(ROW.gross)} − costs ${usd(ROW.cost)} − fee ${usd(ROW.fee)} = ${usd(netCheck)}; proposal says ${usd(ROW.net)}. ${netCheck === ROW.net ? 'Arithmetic matches.' : 'Arithmetic does not match.'} Fee is ${feePct.toFixed(1)}% of gross; whether that is allowed depends on the signed fee agreement, which a person must confirm.`,
  'Why was this flagged?': `Three steps are open: Distribution proposal, Fee check and Human review. The fee check needs the percentage in the signed fee agreement to be compared with ${feePct.toFixed(1)}%.`,
  'Show the conflicting evidence': 'Evidence on file: bank deposit, signed client agreement, signed fee agreement, signed distribution. Not yet recorded: the fee percentage extracted from the fee agreement. No conflict can be asserted until it is.',
};

type Msg = { who: 'you' | 'agent'; text: string };
const SR: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : undefined;

/** Case review (reference: Mangekyo settlement-fee review). Synthetic case, deterministic answers — no model. */
export function CaseReview() {
  const [tab, setTab] = useState<'Chat' | 'Annotations' | 'Details'>('Chat');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [mic, setMic] = useState<'idle' | 'listening' | 'unsupported' | 'denied'>('idle');
  const rec = useRef<any>(null);
  const ask = (q: string) => setMsgs((m) => [...m, { who: 'you', text: q }, { who: 'agent', text: ANSWERS[q] ?? 'This demo answers only the three suggested questions, from the case data above. It is not a language model.' }]);
  const voice = () => {
    if (!SR) { setMic('unsupported'); return; }
    if (mic === 'listening') { rec.current?.stop(); return; }
    const r = new SR(); rec.current = r; r.lang = 'en-US';
    r.onresult = (e: any) => setDraft(e.results[0][0].transcript);
    r.onerror = (e: any) => setMic(e.error === 'not-allowed' ? 'denied' : 'idle');
    r.onend = () => setMic((s) => (s === 'listening' ? 'idle' : s));
    setMic('listening'); r.start();
  };
  return <div className="case-layout">
    <section>
      <p className="muted small">Settlement fee review · <span className="badge">synthetic demo case</span> <span className="badge b-warn">Needs escalation</span></p>
      <h2>Client A / Settlement fee review</h2>
      <p>Amount <strong>{usd(ROW.gross)}</strong></p>
      <ol className="pipeline" aria-label="Case steps">
        {STEPS.map((s) => <li key={s.label} className={s.state}><i>{s.state === 'ok' ? '✓' : '!'}</i><span>{s.label}</span></li>)}
      </ol>
      <div className="card">
        <div className="row between"><strong>Distribution proposal</strong><span className="muted small">Snapshot 5</span></div>
        <table className="tbl"><thead><tr><th>Client</th><th>Gross (USD)</th><th>Cost (USD)</th><th>Fee (USD)</th><th>Client (USD)</th></tr></thead>
          <tbody><tr><td>{ROW.client}</td><td>{usd(ROW.gross)}</td><td>{usd(ROW.cost)}</td><td>{usd(ROW.fee)}</td><td>{usd(ROW.net)}</td></tr></tbody></table>
        <p className="muted small">1 record · recorded observation, not a legal conclusion.</p>
      </div>
    </section>
    <aside className="case-chat" aria-label="Case assistant">
      <div className="tabs">{(['Chat', 'Annotations', 'Details'] as const).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}{t === 'Annotations' && notes.length ? ` ${notes.length}` : ''}</button>)}</div>
      {tab === 'Chat' && <div className="chat-body">
        {!msgs.length && <><h3>Let's review this.</h3><p className="muted small">Would you like to start with the analysis now?</p>
          {Object.keys(ANSWERS).map((q) => <button key={q} className="ask" onClick={() => ask(q)}>{q} <span>↗</span></button>)}</>}
        {msgs.map((m, i) => <p key={i} className={`bubble ${m.who}`}>{m.text}</p>)}
      </div>}
      {tab === 'Annotations' && <div className="chat-body">{notes.length ? notes.map((n, i) => <p key={i} className="bubble you">{n}</p>) : <p className="muted small">No annotations yet. Type a note below and press “Annotate”.</p>}</div>}
      {tab === 'Details' && <div className="chat-body small"><p>Steps flagged: {STEPS.filter((s) => s.state === 'flag').length} of {STEPS.length}</p><p>Fee ratio: {feePct.toFixed(1)}%</p><p className="muted">Answers are computed from this case's numbers by fixed rules.</p></div>}
      {mic === 'listening' && <p className="mic-pop">● Listening… speak now</p>}
      {mic === 'unsupported' && <p className="mic-pop">Voice input needs a browser with speech recognition (e.g. Chrome).</p>}
      {mic === 'denied' && <p className="mic-pop">Microphone access was blocked. Allow it in the browser and try again.</p>}
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) return; if (tab === 'Annotations') setNotes((n) => [...n, draft]); else ask(draft); setDraft(''); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask anything about this case…" aria-label="Message" />
        <button type="button" className="sm" onClick={voice} aria-label="Voice input">🎤</button>
        <button type="button" className="sm" onClick={() => { if (draft.trim()) { setNotes((n) => [...n, draft]); setDraft(''); } }}>Annotate</button>
      </form>
    </aside>
  </div>;
}
