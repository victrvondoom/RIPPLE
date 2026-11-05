import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { Banner, Empty, ErrorView, Loading, useAction } from '../components/ui';
import { Constellation3D, type GNode } from '../components/Constellation3D';
import type { Me } from '../App';

/**
 * Cross-Domain Command Center. Renders server read models only (no business rules here): every status, count,
 * edge, evidence reference and metric comes from /api/crossdomain/* (and the existing passport verifier).
 */
const SURFACES = [['constellation', 'Constellation'], ['inbox', 'Intersection inbox'], ['invariants', 'Invariant inspector'], ['plans', 'Plan collision'], ['impact', 'Impact explorer'], ['resolution', 'Resolution'], ['passport', 'Consistency passport']] as const;
const TONE: Record<string, string> = { RESOLVED: 'b-ok', CONSISTENT: 'b-ok', VERIFIED: 'b-ok', RECOVERED: 'b-ok', satisfied: 'b-ok', feasible: 'b-ok', resolved: 'b-ok', verified: 'b-ok', compensated: 'b-ok', recorded: 'b-info', CONFLICTED: 'b-bad', REQUIRES_HUMAN: 'b-bad', violated: 'b-bad', rejected: 'b-bad', unresolved: 'b-bad', failed: 'b-bad', invalidated: 'b-bad', critical: 'b-bad', unknown: 'b-warn', ARBITRATION: 'b-warn', AWAITING_APPROVAL: 'b-warn', EXECUTING: 'b-info', high: 'b-warn', medium: 'b-info', escalation: 'b-warn', pending: 'b-info', superseded: '', not_applicable: '', cancelled: '', AUTHORIZED: 'b-info', AUTHORIZATION_PENDING: 'b-warn', PARTIALLY_COMPLETED: 'b-bad', RECOVERING: 'b-warn', OPEN: '' };
const B = ({ s }: { s?: string | null }) => (s ? <span className={`badge ${TONE[s] ?? ''}`}>{String(s).replace(/_/g, ' ')}</span> : null);
const J = ({ v }: { v: unknown }) => <pre className="mono rge-json">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>;
const pct = (m: any) => (!m || m.den === 0 ? 'N/A' : `${((m.num / m.den) * 100).toFixed(1)}%`);
const link = (cid: string, surface = 'constellation', extra = '') => `#/reality/crossdomain/${cid || '-'}/${surface}${extra ? `/${encodeURIComponent(extra)}` : ''}`;
type Act = (k: string, m: string, p: string, b?: unknown, ok?: string) => Promise<any>;
const useCdRoute = () => {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const p = h.replace(/^#\//, '').split('/');
  return { cid: p[2] && p[2] !== '-' ? p[2] : '', surface: p[3] || 'constellation', extra: p[4] ? decodeURIComponent(p[4]) : '' };
};

export function CrossDomainPanel({ me }: { me: Me }) {
  const { cid, surface, extra } = useCdRoute();
  const { data: meta } = useApi<any>('/crossdomain/meta');
  const { data: list, reload } = useApi<any>('/crossdomain/campaigns?source=live', 6000);
  const { busy, run } = useAction();
  const [scenario, setScenario] = useState('cd-booking-payment-inventory');
  const canManage = ['owner', 'manager'].includes(me.user.role);
  const start = async () => { const d = await run('start', () => api<any>('POST', '/crossdomain/campaigns', { scenario }), 'Campaign created: workflows planned in one shared sandbox world.'); if (d) { reload(); go(link(d.campaign.id)); } };
  return <div className="cd">
    <div className="cd-hero">
      <div>
        <div className="rge-kicker">Cross-Domain Invariant Intelligence · Reality Lab sandbox</div>
        <div className="cd-title">Every workflow is right. <span className="pill">Are they right together?</span></div>
        <p className="rge-lede">RIPPLE evaluates every workflow against its own contract <b>and</b> against every other active workflow, shared budget, capacity, policy, evidence and time window. Conflicts go through constrained arbitration: simulated candidate plans, hard constraints nobody can override, a hash-bound approval, basis revalidation, guarded writes and independent verification.</p>
        <p className="small muted">{meta?.sandbox ?? 'Sandbox'} · Collaboration: {meta?.collab?.mode === 'switch' && meta?.collab?.connected ? 'Switch adapter' : 'LOCAL MODE (not Switch)'} · Agents are deterministic code (no LLM).</p>
      </div>
      <div className="cd-start card">
        <h3 style={{ marginTop: 0 }}>Start a cross-domain scenario</h3>
        <select aria-label="Scenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>{(meta?.scenarios ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
        <p className="small muted">{meta?.scenarios?.find((s: any) => s.id === scenario)?.story}</p>
        <div className="row"><button className="primary" disabled={!canManage || !!busy} onClick={start}>{busy === 'start' ? 'Seeding world…' : 'Start live scenario'}</button>{!canManage && <span className="muted small">Managers and owners start scenarios.</span>}<a className="small" href={link(cid, 'bench')}>RIGOR · cross-domain benchmark →</a></div>
      </div>
    </div>
    <div className="cd-campaigns">{!list?.campaigns?.length ? <span className="muted small">No live campaigns yet.</span> : list.campaigns.map((c: any) => <a key={c.id} href={link(c.id, surface === 'bench' ? 'constellation' : surface)} className={`cd-chip ${c.id === cid ? 'active' : ''}`}><B s={c.state} /> {c.title.split(' — ')[0]} <span className="muted">· {c.openFindings} blocking · {fmtTime(c.created_at)}</span></a>)}</div>
    {surface === 'bench' ? <BenchPanel me={me} cid={cid} /> : cid ? <Campaign id={cid} surface={surface} extra={extra} me={me} meta={meta} /> : <Empty>Start a scenario above, or open a campaign. Packs available: {(meta?.packs ?? []).map((p: any) => p.label).join(' · ')}.</Empty>}
  </div>;
}

// ------------------------------------------------------------------ one campaign
function Campaign({ id, surface, extra, me, meta }: { id: string; surface: string; extra: string; me: Me; meta: any }) {
  const { data: d, error, loading, reload } = useApi<any>(`/crossdomain/campaigns/${id}`, 5000);
  const { busy, run } = useAction();
  const canManage = ['owner', 'manager'].includes(me.user.role);
  const act: Act = async (key, method, path, body, ok) => { const r = await run(key, () => api<any>(method, path, body), ok); if (r) reload(); return r; };
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !d) return <Loading />;
  const c = d.campaign; const blocking = d.findings.filter((f: any) => f.blocks && f.status !== 'resolved');
  const plan = d.plans[d.plans.length - 1];
  return <div>
    <div className="card cd-camp">
      <div className="cd-camp-head">
        <div><h2 style={{ margin: 0 }}>{c.title}</h2><p className="small muted" style={{ margin: '4px 0 0' }}>{d.scenario.story}</p></div>
        <div className="cd-state"><B s={c.state} /><div className="small muted">{c.state_reason}</div><div className="small muted">analysis round {c.round} · graph {d.graphStats.nodes} nodes / {d.graphStats.edges} edges</div></div>
      </div>
      <div className="row cd-actions">
        <button className="primary" disabled={!canManage || !!busy} onClick={() => act('analyze', 'POST', `/crossdomain/campaigns/${id}/analyze`, undefined, 'Intersection analysis complete.')}>{busy === 'analyze' ? 'Analysing…' : 'Run intersection analysis'}</button>
        <button disabled={!canManage || !!busy || !['CONFLICTED', 'ARBITRATION', 'REQUIRES_HUMAN', 'AWAITING_APPROVAL'].includes(c.state) || !blocking.length} onClick={async () => { const r = await act('arb', 'POST', `/crossdomain/campaigns/${id}/arbitrate`, undefined, 'Candidate plans simulated.'); if (r) go(link(id, 'plans')); }}>{busy === 'arb' ? 'Simulating plans…' : 'Arbitrate'}</button>
        <button disabled={!canManage || !!busy} onClick={async () => { const r = await act('pp', 'POST', `/crossdomain/campaigns/${id}/passport`, undefined, 'Proof-of-consistency passport issued.'); if (r) go(link(id, 'passport', r.passportId)); }}>Issue consistency passport</button>
        <span className="muted small">{d.scenario.events.length ? `Scripted concurrent events (sandbox): ${d.scenario.events.join(' · ')}` : ''}{d.scenario.faults.length ? ` Faults: ${d.scenario.faults.join(' · ')}` : ''}</span>
      </div>
      <div className="cd-wfs">{d.workflows.map((w: any) => <WorkflowCard key={w.id} w={w} cid={id} canManage={canManage} busy={busy} act={act} />)}</div>
    </div>
    <div className="tabs rge-tabs" role="tablist">{SURFACES.map(([k, l]) => <a key={k} role="tab" aria-selected={surface === k} className={surface === k ? 'active' : ''} href={link(id, k)}>{l}{k === 'inbox' && blocking.length ? <span className="count">{blocking.length}</span> : null}{k === 'plans' && plan?.status === 'proposed' ? <span className="count">!</span> : null}</a>)}</div>
    {surface === 'constellation' && <ConstellationSurface id={id} d={d} />}
    {surface === 'inbox' && <Inbox id={id} meta={meta} focus={extra} />}
    {surface === 'invariants' && <Invariants d={d} focus={extra} />}
    {surface === 'plans' && <Plans d={d} id={id} canManage={canManage} busy={busy} act={act} />}
    {surface === 'impact' && <Impact id={id} focus={extra} />}
    {surface === 'resolution' && <Resolution d={d} id={id} me={me} busy={busy} act={act} />}
    {surface === 'passport' && <Passport d={d} id={id} focus={extra} />}
  </div>;
}

function WorkflowCard({ w, cid, canManage, busy, act }: { w: any; cid: string; canManage: boolean; busy: string | null; act: Act }) {
  const pending = w.operations.some((o: any) => o.status === 'pending');
  const approved = w.approvals.some((a: any) => a.status === 'recorded');
  return <div className={`cd-wf ${w.global?.startsWith('blocked') ? 'blocked' : ''}`}>
    <div className="cd-wf-top"><span className={`cd-dom d-${w.pack}`}>{w.domain}</span><B s={w.state} /></div>
    <div className="cd-wf-title">{w.title}</div>
    <div className="small muted">{w.intent}</div>
    <div className="cd-validity">
      <span className={w.local?.valid ? 'ok' : 'bad'}>{w.local?.valid ? '✓ locally valid' : '✗ locally invalid'}</span>
      <span className={w.global?.startsWith('blocked') ? 'bad' : w.global === 'clear' ? 'ok' : ''}>{w.global?.startsWith('blocked') ? `✗ globally ${w.global}` : w.global === 'clear' ? '✓ globally clear' : 'not yet analysed'}</span>
    </div>
    <div className="cd-ops">{w.operations.map((o: any) => <span key={o.id} className={`cd-op s-${o.status}`} title={`${o.label} — ${o.status}${o.idempotencyKey ? ` · key ${o.idempotencyKey}` : ''}${o.lastError ? ` · ${o.lastError}` : ''}`}>{o.key}</span>)}</div>
    <div className="row">
      {!approved && canManage && <button className="sm" disabled={!!busy} onClick={() => act(`ap-${w.key}`, 'POST', `/crossdomain/campaigns/${cid}/workflows/${w.key}/approve`, undefined, 'Plan approval recorded (bound to the plan hash).')}>Approve plan</button>}
      {pending && canManage && <button className="sm" disabled={!!busy} onClick={() => act(`ex-${w.key}`, 'POST', `/crossdomain/campaigns/${cid}/workflows/${w.key}/execute`, undefined, 'Executed through the intersection gate.')}>{busy === `ex-${w.key}` ? 'Gate check…' : 'Execute through gate'}</button>}
      <span className="muted small mono">plan {String(w.planHash).slice(0, 10)}</span>
    </div>
  </div>;
}

// ------------------------------------------------------------------ A. constellation
function ConstellationSurface({ id, d }: { id: string; d: any }) {
  const { data: g } = useApi<any>(`/crossdomain/campaigns/${id}/graph`, 6000);
  const [sel, setSel] = useState<GNode | null>(null);
  if (!g) return <Loading />;
  const edges = sel ? g.edges.filter((e: any) => e.from_node === sel.id || e.to_node === sel.id) : [];
  const findingRow = sel?.type === 'finding' ? d.findings.find((f: any) => f.id === sel.ref_id) : null;
  const counts = g.nodes.reduce((m: Record<string, number>, n: any) => ({ ...m, [n.type]: (m[n.type] ?? 0) + 1 }), {});
  return <div className="grid cd-split">
    <div className="card cd-3d-card"><Constellation3D nodes={g.nodes} edges={g.edges} selected={sel?.id ?? null} onSelect={setSel} /><p className="small muted" style={{ margin: '6px 4px 0' }}>{g.nodes.length} persisted nodes · {g.edges.length} typed edges · {g.provenanceNote} Drag to orbit, scroll to zoom, click a node.</p></div>
    <div className="card cd-side">
      {!sel ? <><h3 style={{ marginTop: 0 }}>Select a node</h3><p className="small muted">Domains sit on the ring; workflows above their domain; shared resources are pulled into the core; invariants form the upper halo and findings the lower one. Red dashed edges are <b>conflicts_with</b>; amber are <b>shares_constraint_with</b>.</p>
        <table className="small"><tbody>{Object.entries(counts).map(([t, n]) => <tr key={t}><td>{t}</td><td>{String(n)}</td></tr>)}</tbody></table></>
        : <>
          <div className="small muted">{sel.type}</div><h3 style={{ marginTop: 2 }}>{sel.label}</h3>
          <J v={sel.data} />
          <div className="row">
            <a className="btn sm" href={link(id, 'impact', sel.id)}>Explore impact</a>
            {findingRow && <a className="btn sm" href={link(id, 'inbox', findingRow.id)}>Open finding</a>}
            {(sel.type === 'invariant' || sel.type === 'policy') && <a className="btn sm" href={link(id, 'invariants', sel.id.slice(4))}>Inspect invariant</a>}
          </div>
          <h3>Edges ({edges.length}) with provenance</h3>
          <div className="cd-edges">{edges.map((e: any) => <div key={e.id} className="small"><span className={`badge rel-${e.rel}`}>{e.rel}</span> {e.from_node === sel.id ? `→ ${e.to_node}` : `← ${e.from_node}`}<div className="muted">source: {e.provenance.source} · {e.provenance.why} · causal {String(e.causal_id).slice(0, 12)}{e.evidence_id ? ` · evidence ${e.evidence_id}` : ''}</div></div>)}</div>
        </>}
    </div>
  </div>;
}

// ------------------------------------------------------------------ B. intersection inbox
function Inbox({ id, meta, focus }: { id: string; meta: any; focus: string }) {
  const [f, setF] = useState({ severity: '', domain: '', status: '', pattern: '', scope: 'campaign' });
  const q = new URLSearchParams(Object.entries({ severity: f.severity, domain: f.domain, status: f.status, pattern: f.pattern, ...(f.scope === 'campaign' ? { campaign: id } : {}) }).filter(([, v]) => v) as [string, string][]).toString();
  const { data } = useApi<any>(`/crossdomain/findings?${q}`, 6000);
  const items = data?.findings ?? [];
  const [open, setOpen] = useState(focus);
  const domains = [...new Set((meta?.packs ?? []).map((p: any) => p.domain))] as string[];
  return <div className="grid cd-split">
    <div className="card">
      <div className="row cd-filters">
        <label className="small">Scope <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="campaign">this campaign</option><option value="workspace">all live campaigns</option></select></label>
        <label className="small">Severity <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="">any</option>{['critical', 'high', 'medium', 'low'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="small">Domain <select value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })}><option value="">any</option>{domains.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="small">Status <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">any</option>{['unresolved', 'unknown', 'resolved'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="small">Pattern <select value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })}><option value="">any</option>{Object.entries(meta?.patterns ?? {}).map(([k, l]) => <option key={k} value={k}>{String(l)}</option>)}</select></label>
      </div>
      {!items.length ? <Empty>No findings match. Run the intersection analysis.</Empty> : <div className="cd-inbox">{items.map((x: any) => <button key={x.id} className={`cd-find ${open === x.id ? 'active' : ''} ${x.blocks && x.status !== 'resolved' ? 'blocking' : ''}`} onClick={() => setOpen(x.id)}>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="cd-pat">{x.label}</span><span><B s={x.severity} /> <B s={x.status} /></span></div>
        <div className="cd-find-title">{x.title}</div>
        <div className="small muted">{x.workflows.join(' × ')} · {x.domains.join(', ')} · {x.blocks ? 'blocks execution' : 'advisory'} · evidence {x.evidence.length}{x.hypothesis ? ' · HYPOTHESIS' : ''}{f.scope !== 'campaign' ? ` · ${x.campaign_title}` : ''}</div>
      </button>)}</div>}
    </div>
    <div className="card cd-side">{open ? <FindingDetail id={id} fid={open} rows={items} /> : <Empty>Select a finding.</Empty>}</div>
  </div>;
}
function FindingDetail({ id, fid, rows }: { id: string; fid: string; rows: any[] }) {
  const x = rows.find((r) => r.id === fid);
  const [chain, setChain] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { setChain(null); setErr(''); }, [fid]);
  if (!x) return <Empty>Finding not in the current filter.</Empty>;
  const campaignId = x.campaign_id ?? id;
  const load = async () => { try { setChain(await api('GET', `/crossdomain/campaigns/${campaignId}/findings/${fid}/evidence`)); } catch (e) { setErr((e as Error).message); } };
  return <div>
    <div className="small muted">{x.label} · round {x.round} · detected {fmtTime(x.detected_at)}</div>
    <h3 style={{ marginTop: 2 }}>{x.title}</h3>
    <p className="small">{x.explanation}</p>
    <Banner tone={x.blocks && x.status !== 'resolved' ? 'bad' : 'info'} title={x.blocks ? 'Blocks execution' : 'Advisory'}>{x.recommendation} Approval required: <b>{x.approval_required}</b>.</Banner>
    <table className="small cd-kv"><tbody>
      <tr><th>Workflows</th><td>{x.workflows.join(', ')}</td></tr><tr><th>Operations</th><td>{x.operations.join(', ') || '—'}</td></tr>
      <tr><th>Domains</th><td>{x.domains.join(', ')}</td></tr><tr><th>Resources</th><td className="mono">{x.resources.join(', ')}</td></tr>
      <tr><th>Invariant</th><td className="mono">{x.invariant_key}</td></tr><tr><th>Severity / blast</th><td>{x.severity} · workflows {x.blast_radius.workflows?.join(', ') || '—'} · invariants {x.blast_radius.invariants?.length ?? 0}</td></tr>
      <tr><th>Confidence</th><td>{x.confidence} — {x.uncertainty}</td></tr><tr><th>Status</th><td><B s={x.status} />{x.resolved_at ? ` resolved ${fmtTime(x.resolved_at)}` : ''}</td></tr>
    </tbody></table>
    <div className="cd-three"><div><h3>Intended</h3><J v={x.intended} /></div><div><h3>Declared</h3><J v={x.declared} /></div><div><h3>Observed</h3><J v={x.observed} /></div></div>
    <h3>Evidence ({x.evidence.length}) <button className="sm" onClick={load}>Trace evidence chain</button></h3>
    {err && <Banner tone="bad">{err}</Banner>}
    {chain && <div className="cd-chain">{chain.chain.map((e: any) => <div key={e.id} className="cd-chain-row small">
      <b className="mono">{e.id}</b> · {e.observerName ?? e.observer} read <span className="mono">{e.system}/{e.resource}</span> at {fmtTime(e.at)} ({e.purpose})
      <div>workflow: {e.workflow} · invariants: {(e.invariants ?? []).map((i: any) => `${i.inv_key} [${i.last_result}]`).join(', ') || '—'}</div>
      <div>fresh at decision: <b>{e.freshAtDecision ? 'yes' : 'no'}</b>{e.invalidated ? ` · invalidated: ${e.invalidated}` : ''}{e.laterChange ? ` · later change ${e.laterChange.id} (${e.laterChange.purpose})` : ''}</div>
      <div>used by plans: {(e.usedByPlans ?? []).join(', ') || '—'} · approvals relying: {(e.approvalsRelying ?? []).map((a: any) => `${a.by} ${a.subject} [${a.status}]`).join(', ') || '—'}</div>
      <div>resulting actions: {(e.resultingActions ?? []).map((a: any) => `${a.op} ${a.status}`).join(', ') || '—'} · final verification: {e.finalVerification ? `${e.finalVerification.purpose} ${fmtTime(e.finalVerification.at)} (${e.finalVerification.matchesThisRead ? 'unchanged since' : 'changed since'})` : '—'}</div>
      <div className="muted">observed state: {JSON.stringify(e.observed?.state)}</div>
    </div>)}</div>}
  </div>;
}

// ------------------------------------------------------------------ C. invariant inspector
function Invariants({ d, focus }: { d: any; focus: string }) {
  const [sel, setSel] = useState(focus || d.invariants[0]?.key);
  const groups = useMemo(() => { const m: Record<string, any[]> = {}; for (const i of d.invariants) (m[i.provenance.source] ??= []).push(i); return m; }, [d.invariants]);
  const i = d.invariants.find((x: any) => x.key === sel);
  const affected = i ? [...new Set([...(i.evaluation?.current?.participants ?? []), ...(i.evaluation?.projected?.participants ?? [])])] : [];
  return <div className="grid cd-split">
    <div className="card cd-invlist">{Object.entries(groups).map(([src, list]) => <div key={src}><h3>{src === 'policy' ? 'Workspace policy' : src === 'pack' ? 'Domain-pack evaluators' : src === 'inferred' ? 'Inferred from plans and evidence' : src} ({list.length})</h3>
      {list.map((x: any) => <button key={x.key} className={`cd-inv ${sel === x.key ? 'active' : ''}`} onClick={() => setSel(x.key)}><B s={x.result ?? 'not evaluated'} /> <span>{x.name}</span><span className="muted small"> · {x.type} · {x.strength}</span></button>)}</div>)}</div>
    <div className="card cd-side">{!i ? <Empty>Select an invariant.</Empty> : <>
      <div className="small muted mono">{i.key} · v{i.version}</div><h3 style={{ marginTop: 2 }}>{i.name}</h3>
      <p className="small">{i.explanation}</p>
      <Banner tone={i.result === 'violated' ? 'bad' : i.result === 'unknown' ? 'warn' : 'ok'} title={`Current evaluator result: ${String(i.result ?? 'not evaluated').replace(/_/g, ' ')}`}>{i.evaluation?.current?.result === 'violated' || i.evaluation?.current?.result === 'unknown' ? i.evaluation.current.detail : i.evaluation?.projected?.detail}</Banner>
      <table className="small cd-kv"><tbody>
        <tr><th>Type</th><td>{i.type}</td></tr><tr><th>Scope</th><td>{i.scope}{i.owner ? ` (owner ${i.owner})` : ''}</td></tr><tr><th>Strength</th><td>{i.strength}{i.spec.__condition ? ` — while ${i.spec.__condition} is active` : ''}</td></tr>
        <tr><th>Severity / impact</th><td>{i.severity} — {i.impact}</td></tr><tr><th>Approval level</th><td>{i.approvalLevel}</td></tr><tr><th>Resolution policy</th><td>{i.resolutionPolicy}</td></tr>
        <tr><th>Auto-restorable</th><td>{i.autoRestorable ? 'yes' : 'no'}</td></tr><tr><th>Provenance</th><td>{i.provenance.source} · {i.provenance.by}</td></tr>
        <tr><th>Confidence</th><td>{i.confidence} — {i.uncertainty}</td></tr><tr><th>Resources</th><td className="mono">{i.resources.join(', ') || '—'}</td></tr>
        <tr><th>Required evidence</th><td>{i.requiredEvidence.join('; ') || '—'}</td></tr><tr><th>Depends on</th><td>{i.dependsOn.join(', ') || '—'}</td></tr>
        <tr><th>Affected workflows</th><td>{affected.join(', ') || '—'}</td></tr>
        <tr><th>Evidence used</th><td className="mono">{(i.evaluation?.evidence ?? []).join(', ') || '—'}</td></tr>
        <tr><th>Evaluated</th><td>round {i.evaluation?.round ?? '—'} · {fmtTime(i.evaluation?.at)}</td></tr>
      </tbody></table>
      <div className="cd-three two"><div><h3>On current reads</h3><J v={i.evaluation?.current ?? '—'} /></div><div><h3>With every pending plan</h3><J v={i.evaluation?.projected ?? '—'} /></div></div>
      <h3>Typed specification (no expressions, no eval)</h3><J v={i.spec} />
    </>}</div>
  </div>;
}

// ------------------------------------------------------------------ D. plan collision workspace
function Plans({ d, id, canManage, busy, act }: { d: any; id: string; canManage: boolean; busy: string | null; act: Act }) {
  const plan = d.plans[d.plans.length - 1];
  const [open, setOpen] = useState<string>('');
  if (!plan) return <Empty>No arbitration yet. Run the analysis, then Arbitrate.</Empty>;
  const opts: any[] = plan.options;
  const totalInv = d.invariants.length;
  const choose = (o: any) => act(`ch-${o.id}`, 'POST', `/crossdomain/campaigns/${id}/choose`, { optionId: o.id }, o.kind === 'escalate' ? 'Escalated.' : 'Choice recorded; an approval bound to the plan hash is required.').then((r) => { if (r && o.kind !== 'escalate') go(link(id, 'resolution')); });
  return <div>
    <Banner tone={plan.status === 'superseded' ? 'warn' : 'info'} title={`Arbitration ${plan.id} — ${plan.status.replace(/_/g, ' ')}`}>Recommended: <b>{opts.find((o) => o.id === plan.recommended)?.label}</b>. Chosen: <b>{plan.chosen ?? '—'}</b>. Hard-constraint violators are rejected; nobody can approve them. Simulated on {Object.keys(plan.basis.refs ?? {}).length} independent reads; the executor re-reads them before writing.</Banner>
    <div className="card table-wrap"><table className="cd-matrix"><thead><tr><th>Candidate plan</th><th>Status</th><th>Preserved</th><th>Violated</th><th>Unknown</th><th>Breaks what held</th><th>Reversibility</th><th>Evidence</th><th>Approval</th><th>Cost</th><th /></tr></thead><tbody>
      {opts.map((o) => <tr key={o.id} className={`${o.id === plan.recommended ? 'rec' : ''} ${o.status}`} onClick={() => setOpen(open === o.id ? '' : o.id)}>
        <td><b>{o.label}</b><div className="small muted">{o.kind}{o.id === plan.recommended ? ' · recommended' : ''}{plan.chosen === o.id ? ' · chosen' : ''}</div></td>
        <td><B s={o.status} /></td><td>{o.preserved.length}/{totalInv}</td><td className={o.violated.length ? 'bad' : ''}>{o.violated.length}</td><td className={o.unknown.length ? 'warn' : ''}>{o.unknown.length}</td><td className={o.newlyBroken.length ? 'bad' : ''}>{o.newlyBroken.length}</td>
        <td>{o.reversibility}</td><td>{(o.evidenceStrength.score * 100).toFixed(0)}% ({o.evidenceStrength.readable}/{o.evidenceStrength.total})</td><td>{o.approvalLevel}</td><td>{o.cost}</td>
        <td><button className="sm primary" disabled={!canManage || !!busy || o.status === 'rejected' || !['proposed', 'awaiting_approval'].includes(plan.status)} title={o.status === 'rejected' ? 'Violates hard constraints — cannot be chosen by anyone' : ''} onClick={(e) => { e.stopPropagation(); void choose(o); }}>{o.kind === 'escalate' ? 'Escalate' : 'Choose'}</button></td>
      </tr>)}</tbody></table></div>
    <div className="cd-optgrid">{opts.filter((o) => !open || o.id === open).map((o) => <div key={o.id} className={`card cd-opt ${o.status}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{o.label}</b><B s={o.status} /></div>
      <p className="small">{o.why}</p><p className="small muted">{o.rationale}</p>
      {o.violated.length > 0 && <><h3>Violated</h3><ul className="small">{o.violated.map((v: any) => <li key={v.key}><b>{v.name}</b> ({v.strength}) — {v.detail}</li>)}</ul></>}
      {o.unknown.length > 0 && <><h3>Unknown</h3><ul className="small">{o.unknown.map((v: any) => <li key={v.key}>{v.key} — {v.detail}</li>)}</ul></>}
      {o.rejectedActions.length > 0 && <><h3>Would be refused at execution</h3><ul className="small">{o.rejectedActions.map((r: any, i: number) => <li key={i}>{r.workflow}:{r.op} — {r.reason}</li>)}</ul></>}
      <h3>Actions ({o.actions.length})</h3><ol className="small">{o.actions.map((a: any, i: number) => <li key={i}><span className={`badge k-${a.kind}`}>{a.kind}</span> {a.workflow}:{a.op}{a.override?.resource ? ` → ${a.override.resource}` : ''}{a.newOp ? ` (${a.newOp.label})` : ''}{a.note ? <span className="muted"> — {a.note}</span> : null}</li>)}</ol>
      <h3>Expected effects ({o.expectedEffects.length})</h3><div className="cd-effects small">{o.expectedEffects.slice(0, 12).map((e: any, i: number) => <div key={i} className="mono">{e.ref}: {diff(e.before, e.after)} <span className="muted">({e.action})</span></div>)}</div>
      <div className="small muted">Affected workflows: {o.affectedWorkflows.join(', ') || '—'} · plan hash <span className="mono">{o.hash.slice(0, 16)}</span> · {o.uncertainty.join(' ')}</div>
      {plan.objections.filter((x: any) => x.option === o.id).length > 0 && <><h3>Adversarial objections (preserved)</h3><ul className="small">{plan.objections.filter((x: any) => x.option === o.id).map((x: any, i: number) => <li key={i}>{x.text}</li>)}</ul></>}
    </div>)}</div>
    {d.plans.length > 1 && <div className="card"><h3 style={{ marginTop: 0 }}>Earlier arbitration rounds</h3><table className="small"><tbody>{d.plans.slice(0, -1).map((p: any) => <tr key={p.id}><td className="mono">{p.id}</td><td><B s={p.status} /></td><td>chosen {p.chosen ?? '—'}</td><td>{p.result?.drift ? `basis drift: ${p.result.drift.map((x: any) => x.ref).join(', ')}` : p.result?.outcome ?? ''}</td><td>{fmtTime(p.created_at)}</td></tr>)}</tbody></table></div>}
  </div>;
}
function diff(a: any, b: any) { const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])); return keys.map((k) => `${k}: ${JSON.stringify(a?.[k] ?? null)} → ${JSON.stringify(b?.[k] ?? null)}`).join('; ') || 'no change'; }

// ------------------------------------------------------------------ E. impact explorer
function Impact({ id, focus }: { id: string; focus: string }) {
  const { data: g } = useApi<any>(`/crossdomain/campaigns/${id}/graph`);
  const [node, setNode] = useState(focus || '');
  const { data: imp, error } = useApi<any>(node ? `/crossdomain/campaigns/${id}/impact?node=${encodeURIComponent(node)}` : null);
  const options = (g?.nodes ?? []).filter((n: any) => ['resource', 'invariant', 'policy', 'workflow'].includes(n.type));
  return <div className="card">
    <div className="row"><label className="small">If this changes… <select value={node} onChange={(e) => setNode(e.target.value)}><option value="">— choose a resource, invariant or workflow —</option>{options.map((n: any) => <option key={n.id} value={n.id}>{n.type}: {n.label}</option>)}</select></label></div>
    {!node ? <Empty>Pick a node to see which workflows, operations, invariants, evidence and approvals a change to it would reach, by traversing the persisted graph.</Empty> : error ? <ErrorView error={error} /> : !imp ? <Loading /> : <div className="cd-impact">
      <Box title={`Affected workflows (${imp.workflows.length})`}>{imp.workflows.map((w: string) => <span key={w} className="cd-chip">{w}</span>)}</Box>
      <Box title={`Invariants (${imp.invariants.length})`}>{imp.invariants.map((w: string) => <a key={w} className="cd-chip" href={link(id, 'invariants', w)}>{w}</a>)}</Box>
      <Box title={`Operations (${imp.operations.length})`}>{imp.operations.map((w: string) => <span key={w} className="cd-chip mono">{w}</span>)}</Box>
      <Box title={`Resources (${imp.resources.length})`}>{imp.resources.map((w: string) => <span key={w} className="cd-chip mono">{w}</span>)}</Box>
      <Box title={`Evidence that would be invalidated / already invalid (${imp.evidence.length})`}>{imp.evidence.map((e: any) => <div key={e.id} className="small"><span className="mono">{e.id}</span> {e.purpose} of {e.ref} · {fmtTime(e.at)} {e.wouldBeInvalidated ? <span className="badge b-warn">would be invalidated</span> : null}{e.invalidated ? <span className="badge b-bad">invalid: {e.invalidated.slice(0, 60)}</span> : null}</div>)}</Box>
      <Box title={`Approvals relying on it (${imp.approvals.length})`}>{imp.approvals.map((a: any) => <div key={a.id} className="small">{a.user_name} · {a.subject} · <B s={a.status} /> · bound {String(a.subject_hash).slice(0, 10)}</div>)}</Box>
      <Box title={`Findings (${imp.findings.length})`}>{imp.findings.map((f: any) => <a key={f.id} className="small" href={link(id, 'inbox', f.id)} style={{ display: 'block' }}>{f.pattern}: {f.title} <B s={f.status} /></a>)}</Box>
      <Box title={`Traversal path (${imp.path.length} edges)`}><div className="cd-path small mono">{imp.path.slice(0, 60).map((p: any, i: number) => <div key={i}>{p.from} —{p.rel}→ {p.to}</div>)}</div></Box>
    </div>}
  </div>;
}
const Box = ({ title, children }: { title: string; children: ReactNode }) => <div className="cd-box"><h3>{title}</h3><div>{children}</div></div>;

// ------------------------------------------------------------------ F. resolution workspace
function Resolution({ d, id, me, busy, act }: { d: any; id: string; me: Me; busy: string | null; act: Act }) {
  const plan = d.plans[d.plans.length - 1]; const c = d.campaign;
  const opt = plan?.chosen ? plan.options.find((o: any) => o.id === plan.chosen) : null;
  const canApprove = !!opt && (opt.approvalLevel === 'owner' ? me.user.role === 'owner' : ['owner', 'manager'].includes(me.user.role));
  const [last, setLast] = useState<any>(null);
  const steps: [string, boolean][] = [['Analysed', c.round > 0], ['Arbitrated', !!plan], ['Chosen', !!plan?.chosen], ['Approved (hash-bound)', d.approvals.some((a: any) => a.status === 'recorded' && opt && a.subject_hash === opt.hash) || ['verified', 'failed', 'executing'].includes(plan?.status)], ['Executed (guarded)', ['verified', 'failed'].includes(plan?.status)], ['Verified', plan?.status === 'verified']];
  return <div>
    <div className="cd-stepper">{steps.map(([l, on], i) => <div key={l} className={`cd-step ${on ? 'on' : ''}`}><span>{i + 1}</span>{l}</div>)}</div>
    <div className="grid g2">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Chosen resolution</h3>
        {!opt ? <Empty>No option chosen. Use the Plan collision workspace.</Empty> : <>
          <b>{opt.label}</b><div className="small muted mono">plan hash {opt.hash} · {opt.approvalLevel} approval</div>
          <ol className="small">{opt.actions.map((a: any, i: number) => <li key={i}><span className={`badge k-${a.kind}`}>{a.kind}</span> {a.workflow}:{a.op}{a.override?.resource ? ` → ${a.override.resource}` : ''}</li>)}</ol>
          <div className="row">
            <button className="primary" disabled={!canApprove || !!busy || plan.status !== 'awaiting_approval'} onClick={() => act('approve', 'POST', `/crossdomain/campaigns/${id}/approve`, undefined, `Approval recorded, bound to ${opt.hash.slice(0, 12)}.`)}>Approve (bound to plan hash)</button>
            <button className="primary" disabled={!['owner', 'manager'].includes(me.user.role) || !!busy || plan.status !== 'awaiting_approval'} onClick={async () => { const r = await act('resolve', 'POST', `/crossdomain/campaigns/${id}/resolve`); if (r) setLast(r); }}>{busy === 'resolve' ? 'Revalidating · executing · verifying…' : 'Execute guarded resolution'}</button>
            {!canApprove && <span className="small muted">Needs {opt.approvalLevel === 'owner' ? 'an owner (sign in as Sam)' : 'a manager or owner'}.</span>}
          </div>
          {last && <Banner tone={last.outcome === 'verified' ? 'ok' : last.outcome === 'replanned' ? 'warn' : 'bad'} title={`Outcome: ${last.outcome}`}>{last.outcome === 'replanned' ? `The world changed after approval (${last.drift.join(', ')}). The approval bound to the old basis was rejected and a new plan was simulated — review it in Plan collision.` : last.outcome === 'verified' ? 'Every affected invariant was re-read and holds.' : 'Execution did not restore consistency; see findings.'}</Banner>}
          {plan.result && <><h3>Result</h3><J v={plan.result} /></>}
        </>}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Approvals (structured, hash-bound, expiring)</h3>
        {!d.approvals.length ? <Empty>None yet.</Empty> : <table className="small"><thead><tr><th>By</th><th>Bound hash</th><th>Status</th><th>Why</th></tr></thead><tbody>{d.approvals.map((a: any) => <tr key={a.id}><td>{a.user_name}<div className="muted">{a.role_at_decision} · {a.channel}</div></td><td className="mono">{String(a.subject_hash).slice(0, 12)}</td><td><B s={a.status} /></td><td className="small">{a.invalid_reason ?? `expires ${fmtTime(a.expires_at)}`}</td></tr>)}</tbody></table>}
      </div>
    </div>
    <div className="card table-wrap"><h3 style={{ marginTop: 0 }}>Guarded execution and read-back verification</h3>
      <table className="small"><thead><tr><th>Operation</th><th>Status</th><th>Idempotency key</th><th>Approval</th><th>Verifier (independent read)</th></tr></thead><tbody>
        {d.workflows.flatMap((w: any) => w.operations.filter((o: any) => o.attempts > 0 || o.status === 'cancelled').map((o: any) => <tr key={o.id}><td>{w.key}:{o.key}<div className="muted">{o.label}{o.origin !== 'plan' ? ` · ${o.origin}` : ''}</div></td><td><B s={o.status} /></td><td className="mono">{o.idempotencyKey ? o.idempotencyKey.split(':').slice(-3).join(':') : '—'}</td><td className="mono">{o.approvalId ?? '—'}</td><td>{(o.verifier ?? []).map((v: any, i: number) => <div key={i} className={v.ok ? 'ok' : 'bad'}>{v.ok ? '✓' : '✗'} {v.label} <span className="muted">({JSON.stringify(v.got)})</span></div>)}{o.lastError ? <div className="muted">{o.lastError}</div> : null}</td></tr>))}
      </tbody></table>
    </div>
    <div className="card"><h3 style={{ marginTop: 0 }}>Campaign timeline (causal ledger)</h3>
      <div className="cd-timeline">{d.timeline.slice(-60).reverse().map((e: any) => <div key={e.id} className={`cd-tl t-${e.cause_type}`}><span className="mono muted">{fmtTime(e.created_at)}</span> <span className="badge">{e.lifecycle_state}</span> <b>{e.actor}</b> {e.summary}</div>)}</div>
    </div>
  </div>;
}

// ------------------------------------------------------------------ G. proof-of-consistency passport
function Passport({ d, id, focus }: { d: any; id: string; focus: string }) {
  const [sel, setSel] = useState(focus || d.passports[d.passports.length - 1]?.id || '');
  const { data: p } = useApi<any>(sel ? `/crossdomain/campaigns/${id}/passports/${sel}` : null);
  const [ver, setVer] = useState<any>(null);
  useEffect(() => setVer(null), [sel]);
  if (!d.passports.length) return <Empty>No passport yet. Issue one from the campaign header (one is also issued automatically after every executed resolution).</Empty>;
  return <div className="grid cd-split">
    <div className="card">
      <div className="row"><select value={sel} onChange={(e) => setSel(e.target.value)}>{d.passports.map((x: any) => <option key={x.id} value={x.id}>{fmtTime(x.created_at)} · {x.status} · {x.id}</option>)}</select>
        <button className="sm" disabled={!sel} onClick={async () => setVer(await api('GET', `/reality/passports/${sel}/verify`))}>Verify integrity (recompute sha256)</button>
        <a className="btn sm" href={`/api/crossdomain/campaigns/${id}/passports/${sel}`} target="_blank" rel="noreferrer">Raw JSON</a></div>
      {ver && <Banner tone={ver.intact ? 'ok' : 'bad'} title={ver.intact ? 'Body intact' : 'TAMPERED: hash mismatch'}>stored <span className="mono">{ver.storedHash.slice(0, 24)}…</span> · recomputed <span className="mono">{ver.recomputedHash.slice(0, 24)}…</span></Banner>}
      {!p ? <Loading /> : <>
        <div className={`cd-verdict v-${p.body.verdict}`}>{p.body.verdict}</div>
        <p className="small"><b>{p.body.summary.satisfied}</b> satisfied · <b>{p.body.summary.violated}</b> violated · <b>{p.body.summary.unknown}</b> unknown · {p.body.summary.notApplicable} not applicable · of {p.body.summary.total} invariants evaluated (analysis round {p.body.analysisRound}).</p>
        <Banner tone="info" title="What the hash proves">{p.body.integrityNote}</Banner>
        {p.body.resolution && <div className="small">Resolution: <b>{p.body.resolution.label}</b> · plan hash <span className="mono">{String(p.body.resolution.planHash).slice(0, 16)}</span> · approvals: {p.body.resolution.approvals.map((a: any) => `${a.user_name} [${a.status}]`).join(', ')}</div>}
        <div className="small muted">{p.body.sandbox} · collaboration {p.body.collaboration.mode}</div>
      </>}
    </div>
    <div className="card cd-side">{p && <table className="small cd-pp"><thead><tr><th>Invariant</th><th>Result</th><th>Evidence</th></tr></thead><tbody>{p.body.invariants.map((i: any) => <tr key={i.key}><td>{i.name}<div className="muted mono">{i.type} · {i.strength} · {i.provenance.source}</div></td><td><B s={i.result} /><div className="muted">{String(i.detail).slice(0, 120)}</div></td><td>{i.evidence.map((e: any) => <div key={e.id} className="mono">{e.observer} {e.system}/{e.resource} {fmtTime(e.observedAt)} {String(e.stateHash ?? 'unreadable').slice(0, 8)}</div>)}</td></tr>)}</tbody></table>}</div>
  </div>;
}

// ------------------------------------------------------------------ H. cross-domain benchmark
function BenchPanel({ me, cid }: { me: Me; cid: string }) {
  const { data: defs } = useApi<any>('/crossdomain/bench/definitions');
  const { data: runs, reload } = useApi<any>('/crossdomain/bench/runs', 3000);
  const [sel, setSel] = useState('');
  const latest = sel || runs?.runs?.[0]?.id || '';
  const running = runs?.runs?.find((r: any) => r.id === latest)?.status === 'running';
  const { data: rep } = useApi<any>(latest ? `/crossdomain/bench/runs/${latest}` : null, running ? 2000 : 0);
  const { busy, run } = useAction();
  const [seed, setSeed] = useState('cd-demo-1'); const [seeds, setSeeds] = useState(2);
  const canRun = ['owner', 'manager'].includes(me.user.role);
  const start = async () => { const r = await run('bench', () => api<any>('POST', '/crossdomain/bench/runs', { seed, seeds }), 'Cross-domain RIGOR run started.'); if (r) { setSel(r.id); reload(); } };
  const baselines: string[] = rep?.run?.baselines ?? [];
  return <div>
    {cid && <p className="small"><a href={link(cid)}>← back to the campaign</a></p>}
    <div className="card">
      <h3 style={{ marginTop: 0 }}>RIGOR · Cross-domain reliability benchmark</h3>
      <p className="small muted">Every case runs a cross-domain scenario through the same campaign runner under a baseline's controls, then is scored against sandbox ground truth the engine never reads. Every metric is numerator / denominator summed from persisted case rows; N/A when the denominator is zero. <b>Baselines are the existing RIGOR controls switched off — not other products.</b> {defs?.mapping}</p>
      <div className="row"><label className="small">Seed <input value={seed} onChange={(e) => setSeed(e.target.value)} /></label><label className="small">Seeds <select value={seeds} onChange={(e) => setSeeds(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</select></label>
        <button className="primary" disabled={!canRun || !!busy} onClick={start}>{busy === 'bench' ? 'Starting…' : `Run ${(defs?.scenarios?.length ?? 0) * (defs?.baselines?.length ?? 0) * seeds} cases`}</button>
        <select value={latest} onChange={(e) => setSel(e.target.value)}>{(runs?.runs ?? []).map((r: any) => <option key={r.id} value={r.id}>{fmtTime(r.started_at)} · {r.seed} · {r.status} {r.done}/{r.total}</option>)}</select>
        {latest && <><a className="btn sm" href={`/api/crossdomain/bench/runs/${latest}/export.csv`}>CSV</a><a className="btn sm" href={`/api/crossdomain/bench/runs/${latest}/export.json`}>JSON</a></>}</div>
    </div>
    {!rep ? (latest ? <Loading /> : <Empty>No cross-domain run yet.</Empty>) : <>
      <div className="card table-wrap"><h3 style={{ marginTop: 0 }}>Results — run {rep.run.id} · {rep.run.status} · {rep.cases.length}/{rep.run.total} cases · seeds {(rep.run.scenarios.seeds ?? []).join(', ')} · code {rep.run.code_version}</h3>
        <table className="cd-bench"><thead><tr><th>Metric</th>{baselines.map((b) => <th key={b}>{defs?.baselines?.find((x: any) => x.id === b)?.label ?? b}</th>)}</tr></thead><tbody>
          {(defs?.metrics ?? []).map((m: any) => <tr key={m.key} title={m.definition}><td>{m.label}{m.lowerIsBetter ? <span className="muted small"> (lower is better)</span> : null}<div className="muted small">{m.definition}</div></td>{baselines.map((b) => { const v = rep.metrics?.[b]?.[m.key]; return <td key={b} className="cd-num"><b>{pct(v)}</b><div className="muted small">{v ? `${v.num}/${v.den}` : '—'}</div></td>; })}</tr>)}
        </tbody></table></div>
      <div className="card table-wrap"><h3 style={{ marginTop: 0 }}>Cases</h3><table className="small"><thead><tr><th>Scenario</th><th>Baseline</th><th>Seed</th><th>Final state</th><th>Raised patterns</th><th>Engine log</th><th>Signature</th><th>ms</th></tr></thead><tbody>
        {rep.cases.map((c: any) => <tr key={c.id}><td>{c.scenario}</td><td>{c.baseline}</td><td className="mono">{c.seed}</td><td><B s={c.declared.campaignState} /></td><td>{(c.declared.raisedPatterns ?? []).join(', ') || '—'}</td><td className="muted">{(c.declared.log ?? []).join(' › ')}</td><td className="mono">{c.evaluation.signature}</td><td>{c.durationMs}</td></tr>)}
      </tbody></table></div>
    </>}
  </div>;
}
