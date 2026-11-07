import { useState } from 'react';
import { api, fmtTime, useApi } from '../api';
import { ErrorView, Loading, StateBadge, useAction } from '../components/ui';

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
    <LiveRun />
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

/**
 * Live sandbox (session 20): start one labelled sample change in any workflow, then press "Next step". Each press makes
 * the server perform ONE real engine step as the person the rules name (answer, approve, execute + independent
 * read-back, acknowledge, complete), and the page shows who did what and where the change now is.
 */
const STAGES = [['intake', 'Intake'], ['analyze', 'Analyze'], ['decide', 'Decide'], ['act', 'Act'], ['verify', 'Verify'], ['complete', 'Complete']] as const;
function LiveRun() {
  const { data: packs } = useApi<any>('/packs');
  const { busy, run } = useAction();
  const [pack, setPack] = useState('');
  const [mission, setMission] = useState<any>(null);
  const [log, setLog] = useState<{ stage: string; did: string; by: string; at: string }[]>([]);
  const [done, setDone] = useState(false);
  const impl = packs?.packs?.filter((p: any) => p.status === 'implemented') ?? [];
  const chosen = pack || impl[0]?.id || '';
  const reached = new Set<string>(['intake', ...(mission ? ['analyze'] : []), ...log.map((l) => l.stage)]);
  if (log.some((l) => l.stage === 'verify' || l.stage === 'complete')) reached.add('act');
  const start = async () => {
    const r = await run('start', () => api<any>('POST', `/packs/${chosen}/demo`, { runAnalysis: true }), 'Change submitted and analysed');
    if (r) { setMission(r.mission); setLog([]); setDone(r.mission.state === 'completed'); }
  };
  const step = async () => {
    const r = await run('step', () => api<any>('POST', `/demo/step/${mission.id}`));
    if (!r) return;
    setMission(r.mission);
    if (!r.step) { setDone(true); return; }
    setLog((l) => [...l, { ...r.step, at: new Date().toISOString() }]);
    if (r.step.stage === 'complete') setDone(true);
  };
  const toEnd = async () => { for (let i = 0; i < 40; i++) { const r = await api<any>('POST', `/demo/step/${mission.id}`).catch(() => null); if (!r) break; setMission(r.mission); if (!r.step) { setDone(true); break; } setLog((l) => [...l, { ...r.step, at: new Date().toISOString() }]); if (r.step.stage === 'complete') { setDone(true); break; } } };
  return <div className="card hw-live">
    <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
      <div><h3 style={{ margin: 0 }}>Run one change, live</h3><p className="small muted" style={{ margin: '2px 0 0' }}>Pick a workflow and watch a labelled sample change ripple through it. Every step is a real engine call, done as the person the rules name.</p></div>
      <div className="row" style={{ gap: 8 }}>
        <select aria-label="Workflow to run" value={chosen} onChange={(e) => { setPack(e.target.value); setMission(null); setLog([]); setDone(false); }}>{impl.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="primary" disabled={!chosen || busy === 'start'} onClick={start}>{mission ? 'Start again' : 'Start'}</button>
      </div>
    </div>
    <ol className="hw-stages">{STAGES.map(([k, l]) => <li key={k} className={reached.has(k) ? 'on' : ''}>{l}</li>)}</ol>
    {mission && <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div><a href={`#/mission/${mission.id}`}><strong>{mission.title}</strong></a> <StateBadge state={mission.state} /><div className="small muted">{mission.state_reason}</div></div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" disabled={done || busy === 'step'} onClick={step}>{done ? 'Nothing left to do' : busy === 'step' ? 'Working…' : 'Next step'}</button>
          <button disabled={done || !!busy} onClick={toEnd}>Run to the end</button>
        </div>
      </div>
      <ul className="list hw-log">{log.map((l, i) => <li key={i}><span className={`badge ${l.stage === 'complete' ? 'b-ok' : l.stage === 'verify' ? 'b-info' : ''}`}>{l.stage}</span> <strong>{l.by}</strong> {l.did} <span className="small muted">· {fmtTime(l.at)}</span></li>)}</ul>
      {done && mission.state !== 'completed' && <p className="small muted">The rules allow nothing more without new information (for example follow-up evidence). Open the mission to see what it is waiting for.</p>}
    </>}
  </div>;
}
