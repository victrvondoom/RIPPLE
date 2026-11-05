import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, go, useApi } from '../api';
import { Banner, Empty, ErrorView, Loading, useAction } from '../components/ui';
import type { Me } from '../App';

/**
 * RIGOR Compound Failure Arena — renders /api/arena/* only. No client-side scoring, no simulated progress:
 * every count, verdict and timeline event is a persisted server record.
 */
const KIND_LABEL: Record<string, string> = { operation: 'Normal operation', fault: 'Injected fault', declaration: 'Agent declaration', observation: 'System observation', gap: 'Reality gap', approval: 'Approval decision', recovery: 'Recovery action', verification: 'Independent verification' };
const KINDS = Object.keys(KIND_LABEL);
const pct = (m: any) => (m?.rate === null || m?.rate === undefined ? 'N/A' : `${(m.rate * 100).toFixed(1)}%`);
const BL_SHORT: Record<string, string> = { 'B1-single-agent': 'B1', 'B2-handoffs-no-reconciliation': 'B2', 'B3-approval-no-verification': 'B3', 'B4-resolve-full': 'B4 · full' };
const Verdict = ({ v }: { v?: string }) => <span className={`verdict ${v === 'PASS' ? 'pass' : v === 'FAIL' ? 'fail' : 'na'}`}>{v ?? '—'}</span>;
const J = ({ v }: { v: unknown }) => <pre className="mono rge-json">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>;

export function ArenaPanel({ me, caseId }: { me: Me; caseId: string }) {
  const { data: lib, error, reload: reloadLib } = useApi<any>('/arena/campaigns', 0);
  const { data: runs, reload: reloadRuns } = useApi<any>('/arena/runs', 2500);
  const [sel, setSel] = useState(''); const [seed, setSeed] = useState('arena-demo-1');
  const [bl, setBl] = useState<string[]>([]);
  const { busy, run } = useAction();
  const current = sel || runs?.runs?.[0]?.id || '';
  const { data: rep } = useApi<any>(current ? `/arena/runs/${current}` : null, 1500);
  const canManage = ['owner', 'manager'].includes(me.user.role);
  const running = rep?.run?.status === 'running';
  const status = rep?.run?.status; const runId = rep?.run?.id;
  useEffect(() => { if (status === 'completed') reloadLib(); }, [status, runId, reloadLib]);
  if (error) return <ErrorView error={error} retry={reloadLib} />;
  if (!lib) return <Loading />;
  const launch = async (body: any, msg: string) => { const r = await run('go', () => api<any>('POST', '/arena/runs', body), msg); if (r) { setSel(r.id); reloadRuns(); go('#/reality/arena'); } };
  const toggle = (v: string) => { const base = bl.length ? bl : Object.keys(BL_SHORT); setBl(base.includes(v) ? base.filter((x) => x !== v) : [...base, v]); };
  const chosen = bl.length ? bl : Object.keys(BL_SHORT);
  const metrics = rep?.run?.metrics?.byBaseline ?? rep?.live?.byBaseline;
  const baselines: string[] = metrics ? Object.keys(metrics) : [];
  const cases: any[] = (rep?.cases ?? []).filter((c: any) => !c.counts.replayed);
  const campaignsInRun: string[] = [...new Set(cases.map((c) => c.scenario as string))];

  return <div>
    <div className="rge-hero">
      <div>
        <div className="rge-kicker">RIGOR · Compound Failure Arena · {lib.campaigns.length} campaigns</div>
        <div className="rge-title">Break it <span className="pill">on purpose.</span></div>
        <p className="rge-lede">Each campaign chains several faults at named lifecycle points: lost acknowledgements, stale replicas, replayed approvals, basis drift, poisoned compensation. Then an <b>independent evaluator</b> reads the sandbox's ground truth and decides whether RIPPLE's own claims hold. Engine outcome, ground truth and verdict are stored separately.</p>
      </div>
      <div className="term" aria-label="Arena status">
        <div className="dots"><i /><i /><i />~/rigor/compound-arena</div>
        <div><span className="prompt">$</span> arena --status</div>
        <div className={`ln ${running ? 'warn' : ''}`}><span className="k">{running ? 'run in progress' : 'last run'}</span><span className="v">{rep ? `${rep.run.done}/${rep.run.total} cases · ${rep.run.status}` : 'none yet'}</span></div>
        <div className="ln"><span className="k">sandbox</span><span className="v">Reality Lab (not production)</span></div>
        <div className={`ln ${lib.collab.mode === 'switch' ? '' : 'warn'}`}><span className="k">collaboration</span><span className="v">{lib.collab.mode === 'switch' ? 'Switch adapter' : 'LOCAL MODE (not Switch)'}</span></div>
        <div className="ln"><span className="k">campaign set</span><span className="v">v{lib.version}</span></div>
        <div><span className="prompt">$</span> <span className="caret" /></div>
      </div>
    </div>

    <div className="card" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>Run campaigns</h3>
      <div className="row">
        <label className="small" style={{ margin: 0 }}>Seed <input value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: 200 }} /></label>
        {Object.keys(BL_SHORT).map((b) => <label key={b} className="inline"><input type="checkbox" checked={chosen.includes(b)} onChange={() => toggle(b)} /> {BL_SHORT[b]}</label>)}
        <button className="primary" disabled={!canManage || !!busy || running} onClick={() => launch({ seed, baselines: chosen }, 'Run-all started.')}>Run all campaigns</button>
        {current && <button disabled={!canManage || !!busy || running} onClick={() => launch({ replayOf: current }, 'Replay started with the same seed.')}>Replay selected run</button>}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>Campaigns are deterministic. The seed is recorded and identifies the run; <b>Replay</b> re-executes the same campaigns and baselines with the same seed in fresh sandboxes and compares result fingerprints. Each B4 case is also re-run once inside the run to measure reproducibility.{!canManage && ' Managers and owners can launch runs.'}</p>
    </div>

    <h3>Campaign library</h3>
    <div className="arena-grid">{lib.campaigns.map((c: any) => <div key={c.id} className="card arena-card">
      <div className="between row"><span className="chip dark">Campaign {c.code}</span><span className="small muted">{c.stages.length} fault stage{c.stages.length > 1 ? 's' : ''}</span></div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20, letterSpacing: '-.02em' }}>{c.name}</div>
      <div className="small">{c.summary}</div>
      <div className="chain">{c.stages.map((s: any, i: number) => <span key={s.id}>{i > 0 && <span className="arrow">→ </span>}<span className="chip" title={`${s.trigger} · ${s.target}`}>{s.label}</span></span>)}</div>
      <div className="small muted">Systems: {c.systems.join(', ')} · Expected: {c.expectedRecovery}</div>
      <details><summary>{c.safety.length} safety properties checked on ground truth</summary><ul className="small" style={{ margin: '4px 0 0 16px', padding: 0 }}>{c.safety.map((s: string) => <li key={s}>{s}</li>)}</ul></details>
      <div className="foot">
        <span className="small">Last (B4): {c.lastResult ? <><Verdict v={c.lastResult.verdict} /> <span className="muted">· engine {c.lastResult.engine} · truth {c.lastResult.truth}</span></> : <span className="muted">not run yet</span>}</span>
        <span className="row" style={{ gap: 6 }}>
          {c.lastResult && <a className="small" href={`#/reality/arena/${c.lastResult.caseId}`}>Open</a>}
          <button className="sm" disabled={!canManage || !!busy || running} onClick={() => launch({ seed, campaigns: [c.id], baselines: chosen }, `Campaign ${c.code} started.`)}>Run</button>
          {c.lastResult && <button className="sm" disabled={!canManage || !!busy || running} onClick={() => launch({ seed: c.lastResult.seed, campaigns: [c.id], baselines: chosen }, `Campaign ${c.code} replayed with seed ${c.lastResult.seed}.`)}>Replay</button>}
        </span>
      </div>
    </div>)}</div>

    <h3>Runs</h3>
    {!runs?.runs?.length ? <Empty>No Arena runs yet. Run a campaign above.</Empty> : <>
      <div className="row">
        <label className="small" style={{ margin: 0 }}>Run <select value={current} onChange={(e) => { setSel(e.target.value); go('#/reality/arena'); }}>{runs.runs.map((r: any) => <option key={r.id} value={r.id}>{fmtTime(r.started_at)} · seed {r.seed} · {r.scenarios.campaigns?.length ?? '?'} campaign(s) · {r.status} {r.done}/{r.total}{r.scenarios.replayOf ? ' · replay' : ''}</option>)}</select></label>
        {current && <><a href={`/api/arena/runs/${current}/export.json`} download>Download JSON</a><a href={`/api/arena/runs/${current}/export.csv`} download>Download CSV</a></>}
      </div>
      {rep && <>
        {running && <div className="card"><div className="small">Executing… {rep.run.done}/{rep.run.total} cases persisted</div><div className="rge-progress"><div style={{ width: `${(100 * rep.run.done) / Math.max(1, rep.run.total)}%` }} /></div></div>}
        {rep.run.status === 'failed' && <Banner tone="bad" title="Run failed">{rep.run.error}</Banner>}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Campaign × baseline verdicts</h3>
          <div className="table-wrap"><table><thead><tr><th>Campaign</th>{baselines.map((b) => <th key={b}>{BL_SHORT[b] ?? b}</th>)}</tr></thead><tbody>
            {campaignsInRun.map((cid) => { const meta = lib.campaigns.find((x: any) => x.id === cid); return <tr key={cid}><td><b>{meta?.code}</b> · {meta?.name}</td>{baselines.map((b) => { const k = cases.find((c) => c.scenario === cid && c.baseline === b); return <td key={b}>{k ? <a href={`#/reality/arena/${k.id}`} title={`engine ${k.declared.declaredStatus} · truth ${k.truth.status}`}><Verdict v={k.evaluation.verdict} /><div className="small muted">engine {k.declared.declaredStatus} · truth {k.truth.status}</div></a> : '—'}</td>; })}</tr>; })}
          </tbody></table></div>
        </div>
        {metrics && <div className="card">
          <h3 style={{ marginTop: 0 }}>Compound reliability (numerator / denominator)</h3>
          <div className="small muted">Seed <span className="mono">{rep.run.seed}</span> · campaign set v{rep.run.code_version} · computed from {rep.cases.length} persisted case rows{running ? ' (partial, live)' : ''}. N/A means the denominator is 0.</div>
          <div className="table-wrap"><table className="rge-metrics"><thead><tr><th>Metric</th>{baselines.map((b) => <th key={b}>{BL_SHORT[b] ?? b}</th>)}</tr></thead><tbody>
            {lib.metrics.map((m: any) => <tr key={m.key}><td title={m.definition}>{m.label}{m.target && <div className="small muted">target {m.target}</div>}</td>{baselines.map((b) => { const x = metrics[b][m.key]; const bad = m.lowerIsBetter && x?.num > 0; return <td key={b} className={bad ? 'rge-badtext' : ''}>{pct(x)}<div className="small muted">{x?.num ?? 0}/{x?.den ?? 0}</div></td>; })}</tr>)}
          </tbody></table></div>
          <details><summary>Baselines and their disabled controls</summary>{lib.baselines.map((b: any) => <p key={b.id} className="small"><b>{b.label}</b> — {b.description}<br /><span className="muted">Disabled: {b.disabled.join('; ') || 'none'}</span></p>)}<p className="small muted">These are controlled configurations of this codebase, not other products. No other project was run.</p></details>
          <details><summary>Metric definitions</summary>{lib.metrics.map((m: any) => <p key={m.key} className="small"><b>{m.label}</b>: {m.definition}</p>)}</details>
        </div>}
      </>}
    </>}

    {caseId && <CaseDetail id={caseId} />}
  </div>;
}

function CaseDetail({ id }: { id: string }) {
  const { data: d, error, loading, reload } = useApi<any>(`/arena/cases/${id}`, 0);
  const [kinds, setKinds] = useState<string[]>(KINDS);
  const tl = useMemo(() => (d?.timeline ?? []).filter((e: any) => kinds.includes(e.kind)), [d, kinds]);
  useEffect(() => { if (d) document.getElementById('arena-case')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [d]);
  if (error) return <ErrorView error={error} retry={reload} />;
  if (loading || !d) return <Loading />;
  const c = d.case; const ev = c.evaluation; const wf = d.workflow; const plan = wf.recoveryPlans.at(-1);
  const t = (iso: string) => { const x = new Date(iso); return `${x.toLocaleTimeString([], { hour12: false })}.${String(x.getMilliseconds()).padStart(3, '0')}`; };
  return <div className="card" id="arena-case" style={{ marginTop: 18 }}>
    <div className="between row">
      <div><div className="rge-kicker">Campaign {d.campaign?.code} · {c.baseline} · case {c.id}</div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 28, letterSpacing: '-.03em' }}>{d.campaign?.name}</div><div className="small muted">seed <span className="mono">{c.seed}</span> · workflow <a href={`#/reality/showcase/${c.workflow_id}`}>{c.workflow_id}</a> · fingerprint <span className="mono">{ev.fingerprint}</span>{ev.replay ? <> · replay {ev.replay.match ? 'matches' : 'DIFFERS from'} the original</> : null}</div></div>
      <a className="small" href="#/reality/arena">Close</a>
    </div>

    <div className="three-col" style={{ marginTop: 14 }}>
      <div className="eng"><div className="muted small">1 · ENGINE-REPORTED OUTCOME</div><div className="rge-big" style={{ color: '#f6c8a3' }}>{c.declared.declaredStatus}</div><div className="small">state {c.declared.state} · observed {c.declared.observedStatus ?? '—'}</div>{c.declared.claims.length > 0 && <div className="small" style={{ marginTop: 6 }}>Agent claims: {c.declared.claims.map((x: string) => `"${x}"`).join(' · ')}</div>}<div className="small" style={{ marginTop: 6 }}>Gaps raised: {c.declared.gapsRaised.join(', ') || 'none'}</div></div>
      <div className="gt"><div className="muted small">2 · INDEPENDENTLY OBSERVED GROUND TRUTH</div><div className="rge-big" style={{ color: c.truth.status === 'inconsistent' ? 'var(--bad)' : c.truth.status === 'complete' ? 'var(--ok)' : 'var(--warn)' }}>{String(c.truth.status).toUpperCase()}</div><ul className="small" style={{ margin: '4px 0 0 16px', padding: 0 }}>{c.truth.invariants.map((i: any) => <li key={i.id}>{i.ok ? '✓' : '✗'} {i.label} <span className="muted">({i.detail})</span></li>)}</ul><div className="small muted">Intent achieved: {c.truth.intent ? 'yes' : 'no'} · {c.truth.effects.filter((e: any) => e.applied).length} applied effect(s)</div></div>
      <div className="ev"><div className="muted small">3 · EVALUATOR VERDICT</div><div className="rge-big"><Verdict v={ev.verdict} /></div><div className="small">{ev.properties.filter((p: any) => p.pass === true).length} passed · {ev.properties.filter((p: any) => p.pass === false).length} failed · {ev.properties.filter((p: any) => p.pass === null).length} not applicable</div><div className="small muted" style={{ marginTop: 6 }}>Never uses the engine's status as evidence; it reads the sandbox effect log and resource state directly.</div></div>
    </div>

    <div className="grid g2" style={{ marginTop: 14 }}>
      <div>
        <h3>Intended state</h3>
        <div className="small"><b>{d.intended?.intent}</b></div>
        <ul className="small" style={{ margin: '4px 0 0 16px', padding: 0 }}>{d.intended?.steps.map((s: any) => <li key={s.key}>{s.label} — <span className="muted">{s.expect.join(', ')}</span></li>)}</ul>
        <div className="small" style={{ marginTop: 4 }}>Invariants: {d.intended?.invariants.join(' · ')}</div>
        <h3>Fault chain (reconstructed from the causal ledger)</h3>
        <div className="row" style={{ gap: 6 }}>{ev.chain.map((s: any, i: number) => <span key={s.stage}>{i > 0 && <span style={{ color: 'var(--coral)', fontWeight: 700 }}>→ </span>}<span className={`chip ${s.activated ? 'dark' : ''}`} title={s.eventId ?? 'not activated'}>{s.activated ? '●' : '○'} {s.label}</span></span>)}</div>
        <div className="small muted">{ev.chainOrdered ? 'Every stage activated in the declared order.' : 'Not every stage activated in this configuration (it never reached that lifecycle point).'}</div>
        <h3>Safety properties</h3>
        <table className="small"><tbody>{ev.properties.map((p: any) => <tr key={p.id}><td style={{ width: 70 }}>{p.pass === null ? <span className="badge">n/a</span> : p.pass ? <span className="badge b-ok">pass</span> : <span className="badge b-bad">fail</span>}</td><td><b>{p.label}</b><div className="muted">{p.detail}</div></td></tr>)}</tbody></table>
      </div>
      <div>
        <h3>Harness actions (through real engine paths)</h3>
        <table className="small"><tbody>{ev.harness.map((h: any, i: number) => <tr key={i}><td style={{ width: 70 }}>{h.ok ? <span className="badge b-ok">ok</span> : <span className="badge b-warn">refused</span>}</td><td><b>{h.step}</b><div className="muted">{h.detail}{h.effectsBefore !== undefined ? ` · applied effects ${h.effectsBefore}→${h.effectsAfter}` : ''}</div></td></tr>)}</tbody></table>
        <h3>Recovery decision</h3>
        {plan ? <div className="small">Plan <span className="mono">{String(plan.plan_hash).slice(0, 12)}</span> · status <b>{plan.status}</b> · recommended <b>{plan.recommended}</b>{plan.chosen ? <> · chosen <b>{plan.chosen}</b></> : null}<div className="muted">{wf.recoveryPlans.length} plan(s) generated; {wf.recoveryPlans.filter((p: any) => p.status === 'stale').length} refused as stale.</div></div> : <div className="small muted">No recovery plan (none was needed, or this configuration has no planner).</div>}
        <h3>Approvals</h3>
        {wf.approvals.length ? <table className="small"><tbody>{wf.approvals.map((a: any) => <tr key={a.id}><td>{a.subject}</td><td>{a.user_name}<div className="muted">{a.channel} · role {a.role_at_decision} · hash {String(a.subject_hash).slice(0, 8)}</div></td><td>{a.status}</td></tr>)}</tbody></table> : <div className="small muted">none</div>}
        <h3>Ground-truth effect log</h3>
        <table className="small"><tbody>{c.truth.effects.map((e: any) => <tr key={e.seq}><td>#{e.seq}</td><td>{e.op}<div className="muted mono">{e.idem ?? 'no key'}</div></td><td>{e.actor}</td><td>{e.applied ? <span className="badge b-ok">applied</span> : <span className="badge">not applied</span>}<div className="muted">{e.note}</div></td></tr>)}</tbody></table>
      </div>
    </div>

    <h3>Execution timeline ({tl.length} of {d.timeline.length} persisted events)</h3>
    <div className="row" style={{ gap: 6, marginBottom: 8 }}>{KINDS.map((k) => <label key={k} className="inline small"><input type="checkbox" checked={kinds.includes(k)} onChange={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])} /> {KIND_LABEL[k]}</label>)}</div>
    <ol className="tl">{tl.map((e: any) => <li key={`${e.source}-${e.ref}`} className={`k-${e.kind}`}><span className="dot" /><div className="meta">{KIND_LABEL[e.kind]} · {e.source} · {e.actor} · {t(e.at)}</div><div>{e.text}</div></li>)}</ol>
    <details><summary>Raw evaluator record</summary><J v={ev} /></details>
  </div>;
}
