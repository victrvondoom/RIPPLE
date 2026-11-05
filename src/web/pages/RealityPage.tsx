import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { Banner, Empty, ErrorView, Loading, useAction } from '../components/ui';
import type { Me } from '../App';
import { ArenaPanel } from './ArenaPanel';
import { CrossDomainPanel } from './CrossDomainPanel';

/**
 * Reality Gap Engine surfaces. Renders server read models only (no business rules here):
 * every count, state and badge comes from /api/reality/* or /api/rigor/*.
 */
const TABS = [['command', 'Reality Command Center'], ['crossdomain', 'Cross-Domain Command Center'], ['arena', 'Compound Failure Arena'], ['showcase', 'Split-Brain showcase'], ['gaps', 'Reality Gap Inbox'], ['explorer', 'Causal Reality Explorer'], ['recovery', 'Recovery Simulator'], ['passports', 'Proof-of-Outcome'], ['rigor', 'RIGOR Benchmark Lab']] as const;
const TONE: Record<string, string> = { VERIFIED: 'b-ok', RECOVERED: 'b-ok', CANCELLED: '', REQUIRES_HUMAN: 'b-bad', FAILED: 'b-bad', PARTIALLY_COMPLETED: 'b-bad', RECONCILIATION_REQUIRED: 'b-bad', EXECUTION_UNKNOWN: 'b-bad', RECOVERING: 'b-warn', OBSERVATION_PENDING: 'b-warn', VERIFICATION_PENDING: 'b-info', EXECUTING: 'b-info', AUTHORIZED: 'b-info', AUTHORIZATION_PENDING: 'b-warn', PLANNED: '', open: 'b-bad', prevented: 'b-warn', resolved: 'b-ok', critical: 'b-bad', high: 'b-warn', medium: 'b-info', low: '' };
const B = ({ s }: { s?: string | null }) => (s ? <span className={`badge ${TONE[s] ?? ''}`}>{s.replace(/_/g, ' ')}</span> : null);
const pct = (m: any) => (m?.rate === null || m?.rate === undefined ? '—' : `${(m.rate * 100).toFixed(1)}%`);
const J = ({ v }: { v: unknown }) => <pre className="mono rge-json">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>;
const useRealityRoute = () => {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const parts = h.replace(/^#\//, '').split('/');
  return { tab: parts[1] || 'command', wf: parts[2] || '' };
};
const link = (tab: string, wf = '') => `#/reality/${tab}${wf ? `/${wf}` : ''}`;

export function RealityPage({ me }: { me: Me }) {
  const { tab, wf } = useRealityRoute();
  return <div>
    {tab !== 'arena' && tab !== 'crossdomain' && <Hero />}
    <div className="tabs rge-tabs" role="tablist">{TABS.map(([k, l]) => <a key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} href={link(k, ['command', 'gaps', 'rigor', 'arena', 'crossdomain'].includes(k) ? '' : wf)}>{l}</a>)}</div>
    {tab === 'command' && <CommandCenter />}
    {tab === 'arena' && <ArenaPanel me={me} caseId={wf} />}
    {tab === 'crossdomain' && <CrossDomainPanel me={me} />}
    {tab === 'showcase' && <Showcase me={me} wf={wf} />}
    {tab === 'gaps' && <GapInbox />}
    {tab === 'explorer' && <WorkflowPicker tab="explorer" wf={wf}>{(id) => <Explorer id={id} />}</WorkflowPicker>}
    {tab === 'recovery' && <WorkflowPicker tab="recovery" wf={wf}>{(id) => <RecoverySim id={id} me={me} />}</WorkflowPicker>}
    {tab === 'passports' && <WorkflowPicker tab="passports" wf={wf}>{(id) => <Passports id={id} />}</WorkflowPicker>}
    {tab === 'rigor' && <RigorLab me={me} />}
  </div>;
}

// ------------------------------------------------------------------ Hero (live counts from /reality/overview)
function Hero() {
  const { data: o } = useApi<any>('/reality/overview', 6000);
  return <div className="rge-hero">
    <div>
      <div className="rge-kicker">Reality Gap Engine · Flip the Switch · sandboxed</div>
      <div className="rge-title">Did it <span className="pill">really</span> happen?</div>
      <p className="rge-lede">RIPPLE compares what was <b>intended</b>, what agents and tools <b>declared</b>, and what <b>independent reads</b> of the connected systems show, then plans, gates and verifies recovery. Connected systems are the <b>Reality Lab sandbox</b>: controlled and labelled, not production integrations.</p>
    </div>
    <div className="term" aria-label="Live reality status">
      <div className="dots"><i /><i /><i />~/ripple/reality</div>
      <div><span className="prompt">$</span> reality --status</div>
      {!o ? <div className="ln"><span className="k">loading</span><span className="v">…</span></div> : <>
        <div className={`ln ${o.workflows.active ? 'warn' : ''}`}><span className="k">live workflows</span><span className="v">{o.workflows.total} total · {o.workflows.active} active</span></div>
        <div className={`ln ${o.gaps.open ? 'bad' : ''}`}><span className="k">open reality gaps</span><span className="v">{o.gaps.open}</span></div>
        <div className="ln"><span className="k">verified recoveries</span><span className="v">{o.recoveries.verified}</span></div>
        <div className={`ln ${o.collab.mode === 'switch' && o.collab.connected ? '' : 'warn'}`}><span className="k">collaboration</span><span className="v">{o.collab.mode === 'switch' ? 'Switch adapter' : 'LOCAL MODE (not Switch)'}</span></div>
      </>}
      <div><span className="prompt">$</span> <span className="caret" /></div>
    </div>
  </div>;
}

// ------------------------------------------------------------------ Command Center
function CommandCenter() {
  const { data: o, error, loading, reload } = useApi<any>('/reality/overview', 5000);
  const { data: audit } = useApi<any>('/reality/mission-audit', 15000);
  const { data: list } = useApi<any>('/reality/workflows?source=live', 5000);
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !o) return <Loading />;
  const tiles: [string, number, string][] = [
    ['Active workflows', o.workflows.active, ''], ['Open reality gaps', o.gaps.open, o.gaps.open ? 'bad' : ''], ['Open partial commits', o.partialCommits, o.partialCommits ? 'bad' : ''],
    ['Stale / unreadable evidence', o.staleEvidence, o.staleEvidence ? 'warn' : ''], ['Recoveries in progress', o.recoveries.inProgress, ''], ['Verified recoveries', o.recoveries.verified, 'ok'],
    ['Failed recoveries', o.recoveries.failed, o.recoveries.failed ? 'bad' : ''], ['Needs a human', o.workflows.requiresHuman, o.workflows.requiresHuman ? 'warn' : ''], ['Verified operations (passports)', o.verifiedOutcomes, 'ok'],
  ];
  return <div>
    <Banner tone={o.collab.mode === 'switch' && o.collab.connected ? 'ok' : 'warn'} title={`Collaboration: ${o.collab.mode === 'switch' ? 'Switch adapter' : 'LOCAL MODE (not Switch)'}`}>{o.collab.detail}</Banner>
    <div className="grid g3 rge-tiles">{tiles.map(([l, v, t]) => <div key={l} className={`card rge-tile ${t}`}><div className="muted small">{l}</div><div className="rge-big">{v}</div></div>)}</div>
    <div className="grid g2">
      <div className="card"><h3>Live reality workflows</h3>
        {!list?.workflows?.length ? <Empty>No live workflows yet. Start the <a href={link('showcase')}>Split-Brain showcase</a>.</Empty> :
          <div className="table-wrap"><table><thead><tr><th>Workflow</th><th>State</th><th>Declared</th><th>Observed</th><th>Open gaps</th></tr></thead><tbody>
            {list.workflows.map((w: any) => <tr key={w.id}><td><a href={link('showcase', w.id)}>{w.title}</a><div className="muted small">{w.family} · {fmtTime(w.created_at)}</div></td><td><B s={w.state} /></td><td className="small">{w.declared_status ?? '—'}</td><td className="small">{w.observed_status ?? '—'}</td><td>{w.openGaps}</td></tr>)}
          </tbody></table></div>}
      </div>
      <div className="card"><h3>Agents and their access boundaries</h3>
        <div className="table-wrap"><table><thead><tr><th>Agent</th><th>Reads</th><th>Writes</th><th>Ops</th><th>Open tasks</th></tr></thead><tbody>
          {o.agents.map((a: any) => <tr key={a.id} title={a.duty}><td>{a.name}<div className="muted small">{a.role}</div></td><td>{a.observe ? 'yes' : '—'}</td><td className="small">{a.mutate.join(', ') || '—'}</td><td>{a.ops}</td><td>{a.openTasks}</td></tr>)}
        </tbody></table></div>
        <p className="muted small">Deterministic agents with enforced capabilities: a verifier cannot write; an executor writes only its own system. No LLM is involved.</p>
      </div>
    </div>
    <div className="grid g2">
      <div className="card"><h3>Connected systems (sandbox)</h3>
        {!o.systems.length ? <Empty>No live observations yet.</Empty> : <table><thead><tr><th>System</th><th>Reads</th><th>Readable</th><th>Last read</th></tr></thead><tbody>{o.systems.map((s: any) => <tr key={s.system}><td>{s.system}</td><td>{s.reads}</td><td>{s.ok}/{s.reads}</td><td className="small">{fmtTime(s.last)}</td></tr>)}</tbody></table>}
        <p className="muted small">Reality Lab sandbox. Benchmark workflows ({o.benchmarkWorkflows}) are excluded from these live counts.</p>
      </div>
      <div className="card"><h3>Reality audit of the mission action ledger</h3>
        {!audit ? <Loading /> : !audit.actions.length ? <Empty>No executed mission actions to audit yet.</Empty> : <>
          <p className="small">{audit.actions.length} executed/verified mission action(s) re-read from their connectors at {fmtTime(audit.checkedAt)}: <b>{audit.gaps}</b> disagreement(s).</p>
          <table><tbody>{audit.actions.slice(0, 8).map((x: any) => <tr key={x.actionId}><td className="small">{x.title}<div className="muted">{x.mission}</div></td><td className="small">{x.status}</td><td className="small">{x.gap ? <span className="badge b-bad">{x.gap.replace(/_/g, ' ')}</span> : 'matches'}<div className="muted">{x.detail}</div></td></tr>)}</tbody></table>
        </>}
      </div>
    </div>
  </div>;
}

// ------------------------------------------------------------------ Workflow picker
function WorkflowPicker({ tab, wf, children }: { tab: string; wf: string; children: (id: string) => ReactNode }) {
  const [src, setSrc] = useState('live');
  const { data } = useApi<any>(`/reality/workflows?source=${src}`, 8000);
  const items = data?.workflows ?? [];
  return <div>
    <div className="row rge-picker">
      <label className="small">Workflow&nbsp;<select value={wf} onChange={(e) => go(link(tab, e.target.value))}><option value="">— choose —</option>{wf && !items.some((w: any) => w.id === wf) && <option value={wf}>{wf}</option>}{items.map((w: any) => <option key={w.id} value={w.id}>{w.title.slice(0, 70)} · {w.baseline} · {w.state}</option>)}</select></label>
      <label className="small">Source&nbsp;<select value={src} onChange={(e) => setSrc(e.target.value)}><option value="live">live</option><option value="benchmark">benchmark cases</option><option value="all">all</option></select></label>
    </div>
    {wf ? children(wf) : <Empty>Choose a workflow (or start the <a href={link('showcase')}>Split-Brain showcase</a>).</Empty>}
  </div>;
}

// ------------------------------------------------------------------ Showcase / workflow view
function Showcase({ me, wf }: { me: Me; wf: string }) {
  const { data: meta } = useApi<any>('/reality/meta');
  const { busy, run } = useAction();
  const [scenario, setScenario] = useState('split-brain');
  const canManage = ['owner', 'manager'].includes(me.user.role);
  const start = async () => { const d = await run('start', () => api<any>('POST', '/reality/workflows', { scenario }), 'Workflow created; awaiting approval.'); if (d) go(link('showcase', d.workflow.id)); };
  return <div>
    <div className="card">
      <h3 style={{ marginTop: 0 }}>THE SPLIT-BRAIN INCIDENT — when every agent says success, but the workflow is broken</h3>
      <p className="small muted">Capture payment → issue hotel booking → confirm to the client. A booking-provider outage window and a one-off unreadable status API are <b>injected deterministically</b> and labelled below. Every button is a server call that writes persisted records; nothing in this view is simulated in the browser.</p>
      <div className="row">
        <select value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Scenario">{(meta?.scenarios ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.showcase ? '★ ' : ''}{s.family} · {s.title}</option>)}</select>
        <button className="primary" disabled={!canManage || !!busy} onClick={start}>{busy === 'start' ? 'Starting…' : 'Start live workflow'}</button>
        {!canManage && <span className="muted small">Managers and owners start workflows.</span>}
      </div>
    </div>
    {wf ? <WorkflowView id={wf} me={me} /> : <Empty>Start the showcase above, or open a workflow from the Command Center.</Empty>}
  </div>;
}

function WorkflowView({ id, me }: { id: string; me: Me }) {
  const { data: d, error, loading, reload, setData } = useApi<any>(`/reality/workflows/${id}`, 4000);
  const { busy, run } = useAction();
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !d) return <Loading />;
  const w = d.workflow; const canManage = ['owner', 'manager'].includes(me.user.role);
  const act = async (key: string, path: string, body: unknown = {}, ok?: string) => { const r = await run(key, () => api<any>('POST', `/reality/workflows/${id}${path}`, body), ok); if (r) setData(r); else reload(); };
  const plan = d.recoveryPlans.at(-1);
  const claims = d.declaredVsObserved.claims as any[];
  const observedTone = w.observed_status === 'consistent' ? 'ok' : w.observed_status ? 'bad' : '';
  return <div>
    <div className="grid g2 rge-punch">
      <div className="card rge-declared"><div className="muted small">AGENT DECLARATION</div><div className="rge-big">{claims.length ? 'COMPLETED' : (w.declared_status ?? 'nothing declared yet').replace(/_/g, ' ')}</div><div className="small">{claims.length ? claims.map((c) => `${c.agentName}: "${c.claim}"`).join(' · ') : 'No agent has claimed completion.'}</div></div>
      <div className={`card rge-observed ${observedTone}`}><div className="muted small">INDEPENDENTLY OBSERVED REALITY</div><div className="rge-big">{(w.observed_status ?? 'not observed yet').replace(/_/g, ' ').toUpperCase()}</div><div className="small">Workflow state <B s={w.state} /> — {w.state_reason}</div></div>
    </div>
    <div className="card">
      <div className="between"><div><h3 style={{ margin: 0 }}>{w.title}</h3><div className="muted small">{w.intent} · plan v{w.plan_version} <span className="mono">{String(w.plan_hash).slice(0, 12)}</span> · {d.baseline.label}</div></div>
        <div className="row">
          {w.state === 'AUTHORIZATION_PENDING' && <button disabled={!canManage || !!busy} onClick={() => act('ap', '/approve', { subject: 'plan' }, 'Plan approval recorded (bound to the plan hash).')}>Approve plan v{w.plan_version}</button>}
          {['AUTHORIZATION_PENDING', 'AUTHORIZED'].includes(w.state) && <button className="primary" disabled={!canManage || !!busy} onClick={() => act('run', '/run', {}, 'Executed; reconciliation finished.')}>{busy === 'run' ? 'Running…' : 'Run workflow'}</button>}
          {w.state === 'RECONCILIATION_REQUIRED' && <a className="linkish" href={link('recovery', id)}>Open Recovery Simulator →</a>}
          {['VERIFIED', 'RECOVERED'].includes(w.state) && <button disabled={!!busy || me.user.role === 'viewer'} onClick={() => act('ra', '/reaudit', {}, 'Re-audit finished.')}>Re-audit against reality</button>}
          <a className="linkish" href={link('explorer', id)}>Causal graph</a><a className="linkish" href={link('passports', id)}>Passports</a>
        </div></div>
      <div className="small muted" style={{ marginTop: 6 }}>Collaboration: <b>{d.collab.mode === 'switch' ? 'Switch' : 'LOCAL MODE (not Switch)'}</b> — {d.collab.note}</div>
      {d.scenario.faults.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Injected faults:</b> {d.scenario.faults.map((f: any) => <span key={f.label} className="badge b-warn" style={{ marginRight: 4 }}>{f.kind}: {f.label}</span>)}</div>}
      {d.scenario.events.length > 0 && <div className="small" style={{ marginTop: 4 }}><b>External events:</b> {d.scenario.events.join(' · ')}</div>}
    </div>
    {plan && w.state === 'RECONCILIATION_REQUIRED' && <Banner tone="bad" title="Reality gap detected — recovery needs a human decision">Recommended: <b>{plan.options.find((o: any) => o.id === plan.recommended)?.label}</b>. <a href={link('recovery', id)}>Compare options →</a></Banner>}
    <div className="grid g2">
      <div className="card"><h3>Operations (declared vs settled)</h3>
        {!d.operations.length ? <Empty>Nothing executed yet.</Empty> : <table><thead><tr><th>Step</th><th>Agent</th><th>State</th><th>Declared</th><th>Settled</th></tr></thead><tbody>
          {d.operations.map((o: any) => <tr key={o.id}><td className="small">{o.kind !== 'forward' && <span className="badge b-info">{o.kind}</span>} {o.label}<div className="muted mono">{o.idempotency_key ?? 'no idempotency key'}</div></td><td className="small">{o.agent}</td><td><B s={o.state} /></td><td className="small">{o.declared.status ?? '—'}{o.declared.claim && <div><b>claims:</b> {o.declared.claim}</div>}{o.last_error && <div className="muted">{o.last_error}</div>}</td><td className="small">{o.declared.settled ?? '—'}</td></tr>)}
        </tbody></table>}
      </div>
      <div className="card"><h3>Reality gaps</h3>{!d.gaps.length ? <Empty>No gaps recorded.</Empty> : d.gaps.map((g: any) => <GapCard key={g.id} g={g} />)}</div>
    </div>
    <div className="grid g2">
      <div className="card"><h3>Hand-offs</h3>{!d.handoffs.length ? <Empty>No hand-offs yet.</Empty> : <table><tbody>{d.handoffs.map((h: any) => <tr key={h.id}><td className="small">{h.from_agent} → <b>{h.to_agent}</b>: {h.action}<div className="muted">scope {h.body.permissionScope} · deliveries {h.deliveries}</div></td><td><span className={`badge ${h.status === 'completed' ? 'b-ok' : h.status === 'lost' || h.status === 'failed' ? 'b-bad' : 'b-info'}`}>{h.status}</span></td></tr>)}</tbody></table>}</div>
      <div className="card"><h3>Approvals</h3>{!d.approvals.length ? <Empty>No approvals yet.</Empty> : <table><tbody>{d.approvals.map((a: any) => <tr key={a.id}><td className="small"><b>{a.subject}</b> by {a.user_name} ({a.role_at_decision}, {a.channel})<div className="muted mono">bound to {String(a.subject_hash).slice(0, 12)} · plan v{a.plan_version} · expires {fmtTime(a.expires_at)}</div></td><td><span className={`badge ${a.status === 'recorded' ? 'b-ok' : ''}`}>{a.status}</span></td></tr>)}</tbody></table>}</div>
    </div>
    <details className="card"><summary><b>Sandbox state and ground-truth effect log</b> <span className="muted small">— {d.sandbox.label}</span></summary>
      <p className="small muted">{d.sandbox.effectLogNote}</p>
      <div className="grid g2"><div><h4>Resources</h4>{d.sandbox.resources.map((r: any) => <div key={`${r.system}/${r.resource}`} className="small"><b>{r.system}/{r.resource}</b> v{r.version} by {r.updated_by}<J v={r.state} /></div>)}</div>
        <div><h4>Effect log</h4><table><tbody>{d.sandbox.effectLog.map((e: any) => <tr key={e.seq}><td className="small">#{e.seq} {e.op}</td><td className="small">{e.actor}</td><td>{e.applied ? <span className="badge b-ok">applied</span> : <span className="badge">not applied</span>}</td><td className="small muted">{e.note}</td></tr>)}</tbody></table></div></div>
    </details>
  </div>;
}

function GapCard({ g }: { g: any }) {
  return <details className="rge-gap" open={g.status === 'open'}>
    <summary><B s={g.severity} /> <B s={g.status} /> <b>{g.label}</b> — {g.title}</summary>
    <div className="grid g3 small" style={{ marginTop: 6 }}>
      <div><div className="muted">Expected</div><J v={g.expected} /></div>
      <div><div className="muted">Declared</div><J v={g.declared} /></div>
      <div><div className="muted">Observed</div><J v={g.observed} /></div>
    </div>
    <div className="small"><b>Systems:</b> {g.systems.join(', ') || '—'} · <b>Agents:</b> {g.agents.join(', ')} · <b>Confidence:</b> {g.confidence} — {g.uncertainty}</div>
    <div className="small"><b>Cause hypothesis:</b> {g.hypothesis}</div>
    <div className="small"><b>Investigation:</b> {g.investigation.join(' → ')}</div>
    <div className="small"><b>Approval required:</b> {g.approval_required} · <b>Evidence:</b> <span className="mono">{g.evidence.slice(0, 6).join(', ')}</span> · detected {fmtTime(g.detected_at)}</div>
  </details>;
}

// ------------------------------------------------------------------ Gap inbox
function GapInbox() {
  const [status, setStatus] = useState('open'); const [source, setSource] = useState('live');
  const { data, error, loading, reload } = useApi<any>(`/reality/gaps?status=${status}&source=${source}`, 6000);
  if (error) return <ErrorView error={error} retry={reload} />;
  return <div>
    <div className="row"><label className="small">Status <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">all</option><option value="open">open</option><option value="prevented">prevented</option><option value="resolved">resolved</option></select></label>
      <label className="small">Source <select value={source} onChange={(e) => setSource(e.target.value)}><option value="live">live</option><option value="benchmark">benchmark</option><option value="">all</option></select></label></div>
    {loading || !data ? <Loading /> : !data.gaps.length ? <Empty>No {status || ''} gaps.</Empty> : data.gaps.map((g: any) => <div key={g.id} className="card"><div className="small muted"><a href={link('showcase', g.workflow_id)}>{g.workflow_title}</a> · {g.baseline} · workflow <B s={g.workflow_state} /> {g.workflow_state === 'RECONCILIATION_REQUIRED' && <a href={link('recovery', g.workflow_id)}>recovery options →</a>}</div><GapCard g={g} /></div>)}
  </div>;
}

// ------------------------------------------------------------------ Causal Reality Explorer
const COL: Record<string, number> = { intent: 0, approval: 1, handoff: 1, agent: 2, operation: 3, recovery: 3, compensation: 3, observation: 4, resource: 5, invariant: 6, gap: 6, recovery_plan: 7, passport: 7 };
const NCOLOR: Record<string, string> = { intent: '#38bdf8', approval: '#a78bfa', handoff: '#94a3b8', agent: '#64748b', operation: '#10b981', recovery: '#22d3ee', compensation: '#f59e0b', observation: '#64748b', resource: '#cbd5e1', invariant: '#facc15', gap: '#ef4444', recovery_plan: '#fb923c', passport: '#34d399' };
function Explorer({ id }: { id: string }) {
  const { data: g, error, loading, reload } = useApi<any>(`/reality/workflows/${id}/graph`, 0);
  const { data: d } = useApi<any>(`/reality/workflows/${id}`, 0);
  const [sel, setSel] = useState<any>(null); const [trav, setTrav] = useState<any>(null);
  const layout = useMemo(() => {
    if (!g) return null;
    const cols: Record<number, any[]> = {};
    for (const n of g.nodes) (cols[COL[n.type] ?? 4] ??= []).push(n);
    const pos: Record<string, { x: number; y: number }> = {}; let h = 0;
    for (const [c, ns] of Object.entries(cols)) ns.forEach((n, i) => { pos[n.id] = { x: 10 + Number(c) * 148, y: 20 + i * 40 }; h = Math.max(h, 60 + i * 40); });
    return { pos, h: Math.max(h, 200), w: 10 + 8 * 148 };
  }, [g]);
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !g || !layout) return <Loading />;
  const hl = new Set<string>(trav ? [trav.start, ...trav.nodes.map((n: any) => n.id)] : []);
  const record = (n: any) => {
    if (!d || !n) return null;
    if (n.type === 'intent') return d.workflow.contract;
    if (!n.ref) return null;
    const pools = [d.operations, d.approvals, d.handoffs, d.gaps, d.observations, d.recoveryPlans, d.passports];
    for (const p of pools) { const hit = p.find((x: any) => x.id === n.ref); if (hit) return hit; }
    return null;
  };
  const traverse = async (dir: 'down' | 'up') => { if (sel) setTrav(await api<any>('GET', `/reality/workflows/${id}/traverse?node=${encodeURIComponent(sel.id)}&dir=${dir}`)); };
  return <div className="grid rge-explorer">
    <div className="card" style={{ overflow: 'auto' }}>
      <div className="small muted">intent → approval / hand-off → agent → operation → observation → resource → invariant / gap → recovery / passport · {g.nodes.length} nodes, {g.edges.length} edges, all from persisted records. Click a node.</div>
      <div className="rge-canvas" style={{ overflow: 'auto', marginTop: 8 }}><svg width={layout.w} height={layout.h} role="img" aria-label="Causal reality graph">
        {g.edges.map((e: any, i: number) => { const a = layout.pos[e.from]; const b = layout.pos[e.to]; if (!a || !b) return null; const on = hl.has(e.from) && hl.has(e.to); return <line key={i} x1={a.x + 128} y1={a.y + 13} x2={b.x} y2={b.y + 13} stroke={on ? '#f6a17c' : 'rgba(243,230,221,.16)'} strokeWidth={on ? 2 : 1}><title>{e.rel}</title></line>; })}
        {g.nodes.map((n: any) => { const p = layout.pos[n.id]; const active = sel?.id === n.id || hl.has(n.id); const pick = () => { setSel(n); setTrav(null); }; return <g key={n.id} transform={`translate(${p.x},${p.y})`} onClick={pick} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`${n.type}: ${n.label}`} onKeyDown={(e) => { if (e.key === 'Enter') pick(); }}>
          <rect width={128} height={27} rx={6} fill="#2a2523" stroke={NCOLOR[n.type] ?? '#888'} strokeWidth={active ? 2.5 : 1} />
          <text x={6} y={11} fontSize={8} fill={NCOLOR[n.type] ?? '#888'}>{n.type}</text>
          <text x={6} y={22} fontSize={9} fill="#f3e6dd">{String(n.label).slice(0, 24)}</text><title>{n.label}</title></g>; })}
      </svg></div>
    </div>
    <div className="card">{!sel ? <Empty>Select a node to see its real linked record.</Empty> : <>
      <div className="small muted">{sel.type}</div><h3 style={{ marginTop: 2 }}>{sel.label}</h3>
      <div className="row"><button className="sm" onClick={() => traverse('down')}>What depends on this?</button><button className="sm" onClick={() => traverse('up')}>What led to this?</button></div>
      {trav && <div className="small" style={{ marginTop: 6 }}><b>{trav.direction === 'down' ? 'Downstream' : 'Upstream'}:</b> {trav.nodes.length} node(s) — {trav.nodes.slice(0, 14).map((n: any) => n.label).join(' · ')}</div>}
      <J v={record(sel) ?? sel} />
    </>}</div>
  </div>;
}

// ------------------------------------------------------------------ Recovery simulator
function RecoverySim({ id, me }: { id: string; me: Me }) {
  const { data: d, error, loading, reload, setData } = useApi<any>(`/reality/workflows/${id}`, 4000);
  const { busy, run } = useAction();
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !d) return <Loading />;
  const plan = d.recoveryPlans.at(-1);
  if (!plan) return <Empty>This workflow has no recovery plan (state {d.workflow.state}).</Empty>;
  const canManage = ['owner', 'manager'].includes(me.user.role);
  const post = async (k: string, path: string, body: unknown, ok: string) => { const r = await run(k, () => api<any>('POST', `/reality/workflows/${id}${path}`, body), ok); if (r) setData(r); else reload(); };
  const recApproved = d.approvals.some((a: any) => a.subject === 'recovery' && a.status === 'recorded' && a.subject_hash === plan.plan_hash);
  return <div>
    <Banner tone="info" title="Simulation, not execution">Each option was applied to a copy of the <b>observed</b> state and the invariants re-evaluated. Nothing below has run unless the plan status says so. Plan <span className="mono">{String(plan.plan_hash).slice(0, 12)}</span> · status <b>{plan.status}</b>{plan.chosen ? <> · chosen <b>{plan.chosen}</b></> : null}.</Banner>
    <div className="grid g2">{plan.options.map((o: any) => <div key={o.id} className={`card rge-option ${plan.recommended === o.id ? 'rec' : ''} ${o.policy !== 'allowed' ? 'rej' : ''}`}>
      <div className="between"><b>{o.label}</b><span>{plan.recommended === o.id && <span className="badge b-ok">recommended</span>}{o.policy !== 'allowed' && <span className="badge b-bad">rejected by policy</span>}</span></div>
      <table className="small"><tbody>
        <tr><td className="muted">Feasible</td><td>{o.feasible ? 'yes' : `no — ${o.blockedBy.join('; ')}`}</td></tr>
        <tr><td className="muted">Risk</td><td>{o.risk}</td></tr><tr><td className="muted">Reversibility</td><td>{o.reversibility}</td></tr>
        <tr><td className="muted">Cost</td><td>{o.cost}</td></tr><tr><td className="muted">Blast radius</td><td>{o.blastRadius.join(', ') || 'none'}</td></tr>
        <tr><td className="muted">Writes</td><td>{o.writes.map((x: any) => x.label).join(' → ') || 'none'}</td></tr>
        {o.notes?.length ? <tr><td className="muted">Notes</td><td>{o.notes.join('; ')}</td></tr> : null}
      </tbody></table>
      <div className="small"><b>Predicted invariants</b>{o.predicted ? <ul>{o.predicted.invariants.map((i: any) => <li key={i.id}>{i.ok ? '✓' : '✗'} {i.label} <span className="muted">({i.detail})</span></li>)}</ul> : <div className="muted">cannot simulate (unreadable state)</div>}
        {o.predicted && <div>Intent achieved: <b>{o.predicted.intentAchieved ? 'yes' : 'no'}</b>{o.predicted.duplicates?.length ? <> · duplicates: <b>{o.predicted.duplicates.join(', ')}</b></> : null}</div>}</div>
      {plan.objections.filter((x: any) => x.option === o.id || x.option === '*').map((x: any, i: number) => <div key={i} className="small muted">⚑ {x.by}: {x.text}</div>)}
      {['proposed', 'awaiting_approval'].includes(plan.status) && <button className="sm" style={{ marginTop: 6 }} disabled={!canManage || !o.feasible || o.policy !== 'allowed' || !!busy} onClick={() => post('choose', '/recovery/choose', { optionId: o.id }, 'Option chosen. The approval must bind to the new plan hash.')}>{plan.chosen === o.id ? 'Chosen ✓' : 'Choose this option'}</button>}
    </div>)}</div>
    {plan.status === 'awaiting_approval' && <div className="card row">
      <button disabled={!canManage || recApproved || !!busy} onClick={() => post('ap', '/approve', { subject: 'recovery' }, 'Recovery approval recorded (bound to the plan hash).')}>{recApproved ? 'Approved ✓' : `Approve "${plan.chosen}"`}</button>
      <button className="primary" disabled={!canManage || !recApproved || !!busy} onClick={() => post('ex', '/recovery/execute', {}, 'Recovery executed and re-verified.')}>{busy === 'ex' ? 'Executing…' : 'Execute guarded recovery'}</button>
      <span className="small muted">The executor re-reads the simulated basis first and refuses if anything changed.</span>
    </div>}
    {plan.result && <div className="card"><h3>Result <B s={plan.status === 'verified' ? 'RECOVERED' : plan.status === 'failed' ? 'FAILED' : plan.status} /></h3><J v={plan.result} /></div>}
    <p className="small"><a href={link('showcase', id)}>← back to the workflow</a></p>
  </div>;
}

// ------------------------------------------------------------------ Passports
function Passports({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<any>(`/reality/workflows/${id}/passports`, 0);
  const [open, setOpen] = useState<string | null>(null); const [ver, setVer] = useState<Record<string, any>>({});
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !data) return <Loading />;
  if (!data.passports.length) return <Empty>No passports yet. They are issued when a workflow reaches a decision point or a terminal state.</Empty>;
  const verify = async (pid: string) => { const v = await api('GET', `/reality/passports/${pid}/verify`); setVer((x) => ({ ...x, [pid]: v })); };
  return <div>
    <div className="row"><a className="linkish" href={`/api/reality/workflows/${id}/passport.json`} download>Download all passports (JSON)</a><button className="sm" onClick={reload}>Refresh</button></div>
    {data.passports.map((p: any) => <div key={p.id} className="card">
      <div className="between"><div><b>{p.operation_id ? p.body.executionContract.label : 'Workflow passport'}</b> <B s={p.status} /> <span className="small muted">{p.operation_id ? `${p.body.executionContract.kind} · ${p.body.externalResource.system}/${p.body.externalResource.resource} · ${p.body.proofBasis}` : `declared ${p.body.declaredStatus} · observed ${p.body.observedStatus}`}</span></div>
        <div className="row"><button className="sm" onClick={() => verify(p.id)}>Verify hash</button><button className="sm" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide' : 'Inspect'}</button></div></div>
      <div className="small mono muted">sha256 {p.body_hash}</div>
      {ver[p.id] && <div className={`small ${ver[p.id].intact ? '' : 'rge-badtext'}`}>{ver[p.id].intact ? '✓ intact: the recomputed hash matches' : `✗ TAMPERED: recomputed ${ver[p.id].recomputedHash}`}</div>}
      {open === p.id && <J v={p.body} />}
    </div>)}
  </div>;
}

// ------------------------------------------------------------------ RIGOR lab
function RigorLab({ me }: { me: Me }) {
  const { data: defs } = useApi<any>('/rigor/definitions');
  const { data: runs, reload } = useApi<any>('/rigor/runs', 3000);
  const [sel, setSel] = useState(''); const [seed, setSeed] = useState('rigor-demo-1');
  const [bl, setBl] = useState<string[]>([]); const [sc, setSc] = useState<string[]>([]);
  const { busy, run } = useAction();
  const current = sel || runs?.runs?.[0]?.id || '';
  const { data: rep } = useApi<any>(current ? `/rigor/runs/${current}` : null, 2500);
  const canManage = ['owner', 'manager'].includes(me.user.role);
  const launch = async () => { const r = await run('go', () => api<any>('POST', '/rigor/runs', { seed, baselines: bl, scenarios: sc }), 'RIGOR run started.'); if (r) { setSel(r.id); reload(); } };
  const metrics = rep?.run?.metrics?.byBaseline ?? rep?.live?.byBaseline;
  const baselines = metrics ? Object.keys(metrics) : [];
  const completed = (runs?.runs ?? []).filter((r: any) => r.status === 'completed').slice(0, 10).reverse();
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return <div>
    <div className="card">
      <h3 style={{ marginTop: 0 }}>RIGOR — Reality Integrity and Governance Outcome Reliability</h3>
      <p className="small muted">Same runner and scenarios for every baseline; only the controls differ. Ground truth is read from the sandbox effect log, which the engine never reads. Leave the selections empty to run everything ({defs?.scenarios?.length ?? '…'} scenarios × {defs?.baselines?.length ?? '…'} baselines).</p>
      <div className="row"><label className="small">Seed <input value={seed} onChange={(e) => setSeed(e.target.value)} /></label><button className="primary" disabled={!canManage || !!busy} onClick={launch}>Run RIGOR</button>{!canManage && <span className="small muted">Managers and owners run benchmarks.</span>}</div>
      <details><summary className="small">Select baselines / scenarios</summary>
        <div className="small">{defs?.baselines?.map((b: any) => <label key={b.id} style={{ marginRight: 10 }}><input type="checkbox" checked={bl.includes(b.id)} onChange={() => toggle(bl, b.id, setBl)} /> {b.id}</label>)}</div>
        <div className="small rge-scen">{defs?.scenarios?.map((s: any) => <label key={s.id}><input type="checkbox" checked={sc.includes(s.id)} onChange={() => toggle(sc, s.id, setSc)} /> {s.family} {s.id}</label>)}</div>
      </details>
    </div>
    <div className="row"><label className="small">Run <select value={current} onChange={(e) => setSel(e.target.value)}>{(runs?.runs ?? []).map((r: any) => <option key={r.id} value={r.id}>{fmtTime(r.started_at)} · {r.seed} · {r.status} {r.done}/{r.total}</option>)}</select></label>
      {current && <><a className="linkish" href={`/api/rigor/runs/${current}/export.json`} download>Download JSON</a><a className="linkish" href={`/api/rigor/runs/${current}/export.csv`} download>Download CSV</a></>}</div>
    {!rep ? (runs?.runs?.length ? <Loading /> : <Empty>No runs yet. Launch one above.</Empty>) : <>
      {rep.run.status === 'running' && <div className="card"><div className="small">Running… {rep.run.done}/{rep.run.total} cases</div><div className="rge-progress"><div style={{ width: `${(100 * rep.run.done) / Math.max(1, rep.run.total)}%` }} /></div></div>}
      {rep.run.status === 'failed' && <Banner tone="bad" title="Run failed">{rep.run.error}</Banner>}
      <div className="card"><h3>Metrics (raw numerator / denominator)</h3><div className="small muted">Seed <span className="mono">{rep.run.seed}</span> · code version <span className="mono">{rep.run.code_version}</span> · {rep.cases.length} case rows{rep.run.status === 'running' ? ' (partial, live)' : ''}</div>
        {!metrics ? <Empty>No cases yet.</Empty> : <div className="table-wrap"><table className="rge-metrics"><thead><tr><th>Metric</th>{baselines.map((b) => <th key={b}>{b}</th>)}</tr></thead><tbody>
          {(defs?.metrics ?? []).map((m: any) => <tr key={m.key}><td title={m.definition}>{m.label}{m.target && <div className="muted small">target {m.target}</div>}</td>{baselines.map((b) => { const v = metrics[b][m.key]; const bad = m.lowerIsBetter && v?.num > 0; return <td key={b} className={bad ? 'rge-badtext' : ''}>{m.key === 'medianRecoveryMs' ? (v?.num === null || v?.num === undefined ? '—' : `${Number(v.num).toFixed(1)} ms`) : pct(v)}<div className="muted small">{m.key === 'medianRecoveryMs' ? `n=${v?.den ?? 0}` : `${v?.num ?? 0}/${v?.den ?? 0}`}</div></td>; })}</tr>)}
        </tbody></table></div>}
      </div>
      {completed.length > 1 && <div className="card"><h3>Trend across completed runs — false success rate</h3><Trend runs={completed} /></div>}
      <div className="card"><h3>Cases</h3><div className="table-wrap"><table><thead><tr><th>Scenario</th><th>Baseline</th><th>Declared</th><th>Ground truth</th><th>Gaps raised</th><th>Key counts</th><th /></tr></thead><tbody>
        {rep.cases.map((c: any) => <tr key={c.id}><td className="small">{c.family} · {c.scenario}<div className="muted">{c.faults.join(' | ')}</div></td><td className="small">{c.baseline}</td><td><B s={c.declared.state} /><div className="small">{c.declared.status}</div></td><td className={`small ${c.counts.falseSuccess ? 'rge-badtext' : ''}`}>{c.truth.status}{c.counts.falseSuccess ? ' — FALSE SUCCESS' : ''}</td><td className="small">{c.declared.gaps.join(', ') || '—'}</td><td className="small">dup {c.counts.duplicates} · unauth {c.counts.unauthorized} · bypass {c.counts.bypass} · stale {c.counts.staleAccepted}</td><td><a className="small" href={link('showcase', c.workflow_id)}>open</a></td></tr>)}
      </tbody></table></div></div>
    </>}
    <details className="card"><summary><b>Baselines and the exact controls enabled</b></summary>
      <div className="table-wrap"><table><thead><tr><th>Control</th>{defs?.baselines?.map((b: any) => <th key={b.id}>{b.id}</th>)}</tr></thead><tbody>
        {defs?.baselines?.[0]?.controls.map((c: any) => <tr key={c.key}><td className="small">{c.label}</td>{defs.baselines.map((b: any) => <td key={b.id}>{b.controls.find((x: any) => x.key === c.key).enabled ? '✓' : '—'}</td>)}</tr>)}
      </tbody></table></div>
      {defs?.baselines?.map((b: any) => <p key={b.id} className="small"><b>{b.label}:</b> {b.description}</p>)}
    </details>
    <details className="card"><summary><b>Metric definitions</b></summary>{defs?.metrics?.map((m: any) => <p key={m.key} className="small"><b>{m.label}</b>: {m.definition}</p>)}
      <p className="small muted">Engineering targets measured in a controlled sandbox. They are not claims about production systems or about other projects, none of which were run here.</p></details>
  </div>;
}
function Trend({ runs }: { runs: any[] }) {
  const series = ['B1-single-agent', 'B2-handoffs-no-reconciliation', 'B3-approval-no-verification', 'B4-resolve-full'];
  const colors = ['#ef4444', '#f59e0b', '#a78bfa', '#10b981'];
  const W = 560, H = 150, P = 30;
  const x = (i: number) => P + (i * (W - 2 * P - 40)) / Math.max(1, runs.length - 1);
  const y = (r: number) => H - P - r * (H - 2 * P);
  return <svg width={W} height={H} role="img" aria-label="False success rate per run" style={{ maxWidth: '100%' }}>
    <line x1={P} y1={H - P} x2={W - P - 40} y2={H - P} stroke="var(--line)" /><text x={2} y={y(1) + 4} fontSize={9} fill="var(--muted)">100%</text><text x={10} y={y(0) + 4} fontSize={9} fill="var(--muted)">0%</text>
    {series.map((s, k) => { const pts = runs.map((r, i) => ({ i, v: r.metrics?.byBaseline?.[s]?.falseSuccess?.rate })).filter((p): p is { i: number; v: number } => typeof p.v === 'number'); return <g key={s}><polyline fill="none" stroke={colors[k]} strokeWidth={2} points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')} />{pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={3} fill={colors[k]}><title>{s}: {(p.v * 100).toFixed(1)}% (seed {runs[p.i].seed})</title></circle>)}<text x={W - P - 30} y={16 + k * 13} fontSize={10} fill={colors[k]}>{s.split('-')[0]}</text></g>; })}
  </svg>;
}
