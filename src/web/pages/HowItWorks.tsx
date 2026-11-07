import { fmtTime, useApi } from '../api';
import { ErrorView, Loading } from '../components/ui';

type Node = { icon: string; title: string; text: string; count: string; hl?: boolean };

/** Architecture view, driven by live counts from this workspace (GET /api/dash/how). Every number is a recorded row count. */
export function HowItWorks() {
  const { data, error, loading, reload } = useApi<any>('/dash/how', 8000);
  const { data: mc } = useApi<any>('/dash/mission-control', 8000);
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} retry={reload} />; if (!data) return null;
  const s = data.stages;
  const cols: { head: string; nodes: Node[] }[] = [
    { head: 'Intake', nodes: [
      { icon: '📝', title: 'Change submitted', text: 'A person enters or uploads a change to an approved plan.', count: `${s.changes} change(s)` },
      { icon: '💬', title: 'Room message', text: `People talk to RIPPLE in the Switch room or mission rooms (${data.collab.mode === 'switch' ? 'Switch adapter configured' : 'local mode, not Switch'}).`, count: `${s.chatMessages} message(s)` } ] },
    { head: 'Analyze', nodes: [
      { icon: '🕸', title: 'Impact graph', text: 'Diffs against the approved baseline and walks the dependency graph.', count: `${s.graphNodes} node(s)` },
      { icon: '🧮', title: 'Role analyzers', text: `Deterministic analyzers, each finding labelled with its analyzer id. Wording provider: ${data.provider.name}.`, count: `${s.analyzerRuns} run(s) · ${s.analyzers} analyzer(s)` } ] },
    { head: 'Decide', nodes: [
      { icon: '🔒', title: 'Approval gate', text: 'Blocks with a question when a human decision is missing. Humans approve; agents never do.', count: `${s.questionsOpen} open question(s) · ${s.approvalsPending} pending · ${s.approvalsDecided} decided`, hl: true } ] },
    { head: 'Act & verify', nodes: [
      { icon: '📤', title: 'Connectors', text: 'Idempotent local, dry-run and sandbox connectors. Nothing is sent externally.', count: `${s.executed} executed · ${s.unknown} unknown · ${s.recoveredByReadBack} recovered by read-back` },
      { icon: '✅', title: 'Read-back verification', text: 'An action is “verified” only after its effect is re-read and checked.', count: `${s.verified} verified · ${s.checksPassed} checks passed · ${s.checksFailed} failed` } ] },
  ];
  const inv = data.lastInvariant;
  return <div>
    <h2>How RIPPLE works</h2>
    <p className="muted">Live view of this workspace. Every count below is read from the database on each refresh.</p>
    <h3>Sources → system of record → lifecycle stages</h3>
    <div className="erp-flow">
      <div className="erp-sources">{data.connectors.map((c: any) => <div key={c.key} className="erp-chip" title={c.description}>{c.name} · {c.mode}</div>)}</div>
      <div className="erp-line" aria-hidden />
      <div className="erp-core"><span className="erp-chip brand">RIPPLE</span><span className="erp-chip">{data.collab.mode === 'switch' ? 'Switch collaboration' : 'Local collaboration (not Switch)'}</span></div>
      <div className="erp-line" aria-hidden />
      {(mc?.pipeline ?? []).map((p: any) => <div key={p.stage} className="erp-step">{p.stage} · {p.count}</div>)}
      {inv ? <><div className="row" style={{ gap: 12 }}><div className="erp-total">{inv.passed ? 'Invariant held' : 'Invariant FAILED'} <strong>{inv.detail}</strong></div></div>
        <p className="muted small">Latest business-invariant check: “{inv.check_name}” on <a href={`#/mission/${inv.mission_id}`}>{inv.mission_title}</a> · {fmtTime(inv.created_at)}.</p></>
        : <p className="muted small">No business-invariant check has run yet. Start the Revenue Recovery workflow to produce one.</p>}
    </div>
    <h3>Intake → Analyze → Decide → Act</h3>
    <div className="pipe-grid">
      {cols.map((c, ci) => <div key={c.head} className="pipe-col">
        <div className="pipe-head">{c.head}{ci < cols.length - 1 ? ' →' : ''}</div>
        {c.nodes.map((n) => <div key={n.title} className={`pipe-node${n.hl ? ' hl' : ''}`}><span className="pipe-ic">{n.icon}</span><div><strong>{n.title}</strong><p className="small muted">{n.text}</p><span className="badge">{n.count}</span></div></div>)}
      </div>)}
    </div>
    <p className="muted small">{s.auditEvents} audit event(s) recorded. Every step is in the audit log; see Trust &amp; Evidence for the hash chain.</p>
  </div>;
}
