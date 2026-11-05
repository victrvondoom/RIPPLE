type Node = { icon: string; title: string; text: string; hl?: boolean };

const SOURCES = ['Trust documents', 'Payments', 'Client ledgers'];
const FLOW_STEPS = ['Index source documents', 'Settlement received', 'Reconcile client ledgers', 'Settlement fee review'];

const COLS: { head: string; nodes: Node[] }[] = [
  { head: 'Intake', nodes: [
    { icon: '📝', title: 'Change submitted', text: 'A person enters or uploads a change to an approved plan.' },
    { icon: '💬', title: 'Chat message', text: 'Someone raises it in the team room (via Switch adapter — mock-tested only).' } ] },
  { head: 'Analyze', nodes: [
    { icon: '🕸', title: 'Impact graph', text: 'Diffs against the approved baseline and walks the dependency graph.' },
    { icon: '🧮', title: 'Role analyzers', text: 'Deterministic, rule-based; each finding is labelled with its analyzer id.' } ] },
  { head: 'Decide', nodes: [
    { icon: '🔒', title: 'Approval gate', text: 'Weighs findings; blocks with a question when a human decision is missing. Humans approve — agents never do.', hl: true } ] },
  { head: 'Act & verify', nodes: [
    { icon: '📤', title: 'Dry-run connectors', text: 'Idempotent local outbox. Nothing is sent externally.' },
    { icon: '✅', title: 'Read-back verification', text: 'An action is “verified” only after its effect is re-read.' } ] },
];

/** Architecture views (references: ERP flow diagram, Sense→Read→Decide→Speak pipeline). Static explanation of this repo. */
export function HowItWorks() {
  return <div>
    <h2>How RIPPLE works</h2>
    <p className="muted">Static diagrams of this repository's flow. Nothing here is live telemetry.</p>
    <h3>Sources → system of record → case steps</h3>
    <div className="erp-flow">
      <div className="erp-sources">{SOURCES.map((s) => <div key={s} className="erp-chip">{s}</div>)}</div>
      <div className="erp-line" aria-hidden />
      <div className="erp-core"><span className="erp-chip brand">RIPPLE</span><span className="erp-chip">ERP / ledger connector (local dry-run)</span></div>
      <div className="erp-line" aria-hidden />
      {FLOW_STEPS.map((s) => <div key={s} className="erp-step">{s}</div>)}
      <div className="row" style={{ gap: 12 }}><div className="erp-total">Ledger <strong>$302,500.00</strong></div><div className="erp-total">Cash <strong>$302,500.00</strong></div></div>
      <p className="muted small">Example figures from the synthetic case; matching totals are what a reconciliation step would assert.</p>
    </div>
    <h3>Intake → Analyze → Decide → Act</h3>
    <div className="pipe-grid">
      {COLS.map((c, ci) => <div key={c.head} className="pipe-col">
        <div className="pipe-head">{c.head}{ci < COLS.length - 1 ? ' →' : ''}</div>
        {c.nodes.map((n) => <div key={n.title} className={`pipe-node${n.hl ? ' hl' : ''}`}><span className="pipe-ic">{n.icon}</span><div><strong>{n.title}</strong><p className="small muted">{n.text}</p></div></div>)}
      </div>)}
    </div>
    <p className="muted small">Every step is written to the audit log and can be replayed from the Audit trail.</p>
  </div>;
}
