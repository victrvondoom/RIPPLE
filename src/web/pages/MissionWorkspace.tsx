import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, useApi } from '../api';
import { Banner, Empty, ErrorView, Loading, StateBadge, Status, useAction } from '../components/ui';
import { Graph } from '../components/Graph';
import { ArrayEditor, isRowArray } from '../components/ArrayEditor';
import { Orchestration } from './Orchestration';
import type { Me } from '../App';

const FLOW = ['draft', 'baseline_ready', 'analyzing', 'awaiting_approval', 'executing', 'verifying', 'completed'];
const TABS = [['overview', 'Overview'], ['orchestration', 'Orchestration'], ['changes', 'Baseline & change'], ['impact', 'Impact graph'], ['work', 'Tasks & questions'], ['agents', 'Agent findings'], ['room', 'Collaboration room'], ['drafts', 'Drafts'], ['actions', 'Approvals & actions'], ['evidence', 'Evidence & outcome'], ['audit', 'Audit & recovery']] as const;

export function MissionWorkspace({ id, me }: { id: string; me: Me }) {
  const { data: d, error, loading, reload, setData } = useApi<any>(`/missions/${id}`, 3000);
  const [tab, setTab] = useState<string>('overview');
  const { busy, run } = useAction();
  const isMgr = me.user.role === 'owner' || me.user.role === 'manager';
  useEffect(() => { const h = () => { const t = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab'); if (t) setTab(t); }; h(); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  if (loading && !d) return <Loading />; if (error && !d) return <ErrorView error={error} retry={reload} />; if (!d) return null;
  const m = d.mission;
  const post = async (key: string, path: string, body: unknown = {}, ok?: string, method = 'POST') => { const r = await run(key, () => api(method, `/missions/${id}${path}`, body), ok); if (r) setData(r); return r; };
  const ctx = { d, me, isMgr, busy, post, setTab };
  return <>
    <div className="row between"><div><div className="small muted"><a href="#/missions">Missions</a> / {m.pack_name} · {m.domain}</div><h1>{m.title}</h1></div><div className="row"><StateBadge state={m.state} /><span className="small muted">baseline v{m.current_baseline_version} · change #{m.change_seq} · analysis rev {m.analysis_rev}</span></div></div>
    <Lifecycle state={m.state} />
    <StateExplainer d={d} />
    <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}{k === 'actions' && d.approvals.some((a: any) => a.status === 'pending') ? ` (${d.approvals.filter((a: any) => a.status === 'pending').length})` : ''}{k === 'work' && d.questions.some((q: any) => q.status === 'open') ? ` (${d.questions.filter((q: any) => q.status === 'open').length} open)` : ''}</button>)}</div>
    {tab === 'overview' && <Overview {...ctx} />}
    {tab === 'orchestration' && <Orchestration {...ctx} />}
    {tab === 'changes' && <Changes {...ctx} />}
    {tab === 'impact' && <Impact {...ctx} />}
    {tab === 'work' && <Work {...ctx} />}
    {tab === 'agents' && <Agents {...ctx} />}
    {tab === 'room' && <Room {...ctx} />}
    {tab === 'drafts' && <Drafts {...ctx} />}
    {tab === 'actions' && <Actions {...ctx} />}
    {tab === 'evidence' && <Evidence {...ctx} />}
    {tab === 'audit' && <Audit {...ctx} />}
  </>;
}
type Ctx = { d: any; me: Me; isMgr: boolean; busy: string | null; post: (k: string, p: string, b?: unknown, ok?: string, method?: string) => Promise<any>; setTab: (t: string) => void };

function Lifecycle({ state }: { state: string }) {
  const idx = FLOW.indexOf(state === 'blocked' ? 'analyzing' : state === 'recovery_required' ? 'executing' : state);
  return <div className="stepper" aria-label="Mission lifecycle">{FLOW.map((s, i) => <span key={s} className={`step ${i < idx || state === 'completed' ? 'done' : i === idx ? 'cur' : ''}`}>{s.replace(/_/g, ' ')}</span>)}{['blocked', 'recovery_required', 'failed', 'cancelled'].includes(state) && <span className="step side">{state.replace(/_/g, ' ')}</span>}</div>;
}
function StateExplainer({ d }: { d: any }) {
  const s = d.mission.state; const tone = s === 'blocked' || s === 'awaiting_approval' ? 'warn' : s === 'recovery_required' || s === 'failed' ? 'bad' : s === 'completed' ? 'ok' : 'info';
  return <Banner tone={tone as any} title={`${d.mission.state_label} — why`}>{d.mission.state_reason}</Banner>;
}

function Overview({ d, isMgr, busy, post, setTab }: Ctx) {
  const m = d.mission; const openQ = d.questions.filter((q: any) => q.status === 'open'); const approved = d.actions.filter((a: any) => a.status === 'approved' && a.current); const failed = d.actions.filter((a: any) => ['failed', 'verification_failed', 'execution_unknown'].includes(a.status) && a.current);
  return <div className="grid g2">
    <div>
      <div className="card"><h2>Next step</h2>
        {m.state === 'draft' && (isMgr ? <><p>The original plan is entered but not yet an approved baseline. Every later change is compared against the baseline.</p><button className="primary" disabled={busy === 'bl'} onClick={() => post('bl', '/baseline', { note: 'Approved as initial baseline' }, 'Baseline v1 saved')}>Approve & save baseline v1</button></> : <p className="muted">A manager must approve the baseline.</p>)}
        {m.state === 'baseline_ready' && <><p>Baseline v{m.current_baseline_version} is saved. Enter the incoming change, request or update to start impact analysis.</p><button className="primary" onClick={() => setTab('changes')}>Enter change / request</button></>}
        {m.state === 'blocked' && <><p>Agents cannot continue without a human answer:</p>{openQ.filter((q: any) => q.blocking).map((q: any) => <QuestionForm key={q.id} q={q} busy={busy} post={post} />)}</>}
        {m.state === 'awaiting_approval' && <><p>{d.approvals.filter((a: any) => a.status === 'pending').length} approval(s) are waiting. Nothing is executed without them.</p><button className="primary" onClick={() => setTab('actions')}>Review approvals</button></>}
        {m.state === 'executing' && <><p>Approved actions are ready: {approved.map((a: any) => a.title).join('; ')}</p><button className="primary" onClick={() => setTab('actions')}>Execute approved actions</button></>}
        {m.state === 'recovery_required' && <><p>{failed.length} action(s) failed. Review the error and retry — each retry is audited.</p><button className="primary" onClick={() => setTab('actions')}>Open recovery</button></>}
        {m.state === 'verifying' && <><p>Actions are verified. Collect acknowledgements and finish review items, then complete.</p><button className="primary" onClick={() => setTab('evidence')}>Completion checklist</button></>}
        {m.state === 'completed' && <p>Completed. Baseline v{m.current_baseline_version} is the new approved plan. Submit another change to start a new cycle.</p>}
        {['analyzing', 'failed', 'cancelled'].includes(m.state) && <p className="muted">No action available in this state.</p>}
        {isMgr && !['completed', 'cancelled', 'draft'].includes(m.state) && <p><button className="sm danger" onClick={() => { const r = prompt('Reason for cancelling this mission?'); if (r) post('cancel', '/cancel', { reason: r }, 'Mission cancelled'); }}>Cancel mission…</button></p>}
      </div>
      <div className="card"><h2>{d.labelsChange ?? 'Change / request'} summary</h2>{d.changes.length ? (() => { const c = d.changes[d.changes.length - 1]; return <><p className="small muted">Change #{c.seq} against baseline v{c.baseline_version} · {fmtTime(c.created_at)} · <Status s={c.status} /></p>{c.description && <p>“{c.description}”</p>}<ul className="list">{c.items.map((i: any) => <li key={i.field}><strong>{i.label}</strong>: {String(i.before)} → <strong>{String(i.after)}</strong> <span className={`badge ${i.severity === 'high' ? 'b-bad' : 'b-warn'}`}>{i.severity}</span>{i.note && <div className="small muted">{i.note}</div>}</li>)}</ul></>; })() : <Empty>No change submitted yet.</Empty>}</div>
    </div>
    <div>
      <div className="card"><h2>Completion criteria</h2><Checklist c={d.completion} /></div>
      <div className="card"><h2>Agents & people</h2>{d.agents.map((a: any) => <div key={a.key} className="row between" style={{ marginBottom: 6 }}><span>{a.name}</span><Status s={a.status} /></div>)}<h3>Humans</h3>{d.roles.filter((r: any) => r.kind === 'human').map((r: any) => <div key={r.key} className="row between small"><span>{r.name}</span><span className="muted">{r.user?.name ?? 'unassigned'}</span></div>)}</div>
    </div>
  </div>;
}
const Checklist = ({ c }: { c: any }) => <ul className="list">{c.checks.map((x: any) => <li key={x.key}><span className={`badge ${x.passed ? 'b-ok' : 'b-warn'}`}>{x.passed ? 'met' : 'not met'}</span> <strong>{x.label}</strong><div className="small muted">{x.detail}</div></li>)}</ul>;

function QuestionForm({ q, busy, post }: { q: any; busy: string | null; post: Ctx['post'] }) {
  const [v, setV] = useState('');
  return <form onSubmit={(e) => { e.preventDefault(); post(`q${q.id}`, `/questions/${q.id}/answer`, { answer: v }, 'Answer recorded; re-analysing'); }} className="card" style={{ background: 'var(--warn-bg)' }}>
    <div><span className={`badge ${q.blocking ? 'b-bad' : 'b-warn'}`}>{q.blocking ? 'blocking' : 'non-blocking'}</span> <span className="small muted">asked by {q.asked_by_role} → {q.assignee ?? 'manager'}</span></div>
    <p style={{ margin: '6px 0' }}>{q.text}</p><div className="row"><input aria-label="Answer" style={{ maxWidth: 320 }} value={v} onChange={(e) => setV(e.target.value)} required /><button className="primary" disabled={busy === `q${q.id}`}>Submit answer</button></div></form>;
}

function Changes({ d, isMgr, busy, post }: Ctx) {
  const { data: pack } = useApi<any>(`/packs/${d.mission.pack_id}`);
  const [vals, setVals] = useState<Record<string, any>>({}); const [json, setJson] = useState<Record<string, string>>({}); const [rows, setRows] = useState<Record<string, any[]>>({}); const [open, setOpen] = useState<number | null>(null);
  const sample = pack?.sample.change ?? {}; const L = pack?.labels;
  const keys = Object.keys(sample);
  const canSubmit = isMgr && !['draft', 'cancelled'].includes(d.mission.state);
  const load = (src: any = sample) => { const v: Record<string, any> = {}; const j: Record<string, string> = {}; const r: Record<string, any[]> = {}; for (const k of keys) { const x = src[k]; if (isRowArray(sample[k]) && (x === undefined || Array.isArray(x))) r[k] = structuredClone(x ?? []); else if (Array.isArray(sample[k]) || (typeof sample[k] === 'object' && sample[k] !== null)) j[k] = JSON.stringify(x ?? sample[k], null, 2); else v[k] = x; } setVals(v); setJson(j); setRows(r); };
  const last = d.changes.length ? d.changes[d.changes.length - 1] : null;
  const submit = async (e: React.FormEvent) => { e.preventDefault(); const body: any = {}; for (const k of keys) { if (k in rows) body[k] = rows[k]; else if (k in json) { try { body[k] = JSON.parse(json[k]); } catch { alert(`${k} is not valid JSON`); return; } } else if (vals[k] !== undefined && vals[k] !== '') body[k] = vals[k]; else if (sample[k] === null) body[k] = null; } await post('chg', '/changes', body, 'Analysis complete'); };
  return <div className="grid g2">
    <div>
      <div className="card"><h2>{L?.baseline ?? 'Baseline'} — version history</h2>{d.baselines.map((b: any) => <div key={b.id} style={{ marginBottom: 8 }}><div className="row between"><strong>v{b.version}</strong><span className="small muted">{fmtTime(b.created_at)} · {b.approved_by_name}</span></div><div className="small">{b.note}</div><div className="mono muted">sha256 {b.plan_hash.slice(0, 16)}…</div><button className="sm" onClick={() => setOpen(open === b.version ? null : b.version)}>{open === b.version ? 'Hide' : 'View'} plan</button>{open === b.version && <pre className="md">{JSON.stringify(b.plan, null, 2)}</pre>}</div>)}{!d.baselines.length && <Empty>No baseline yet — approve it from the Overview.</Empty>}</div>
      <div className="card"><h2>{L?.change ?? 'Change'} history</h2>{d.changes.map((c: any) => <div key={c.id} style={{ marginBottom: 8 }}><strong>#{c.seq}</strong> vs baseline v{c.baseline_version} <Status s={c.status} /><div className="small muted">{c.created_by_name} · {fmtTime(c.created_at)}</div><div>{c.items.map((i: any) => `${i.label}: ${i.before} → ${i.after}`).join(' · ')}</div></div>)}{!d.changes.length && <Empty>No changes.</Empty>}</div>
    </div>
    <div className="card"><h2>{L?.changeVerb ?? 'Submit change'}</h2>
      {!canSubmit ? <p className="muted">{isMgr ? 'Approve a baseline first.' : 'Only managers can submit changes.'}</p> : <form onSubmit={submit}>
        <p className="small muted">Submitting while actions are queued marks them <strong>stale</strong> and requires fresh approval. Data you enter is analysed against the baseline — the sample is only a starting point.</p>
        <div className="row"><button type="button" onClick={() => load()} disabled={!pack}>Load sample</button>{last && <button type="button" onClick={() => load(last.input)} disabled={!pack}>Start from previous submission (#{last.seq})</button>}</div>
        {keys.map((k) => k in rows ? <div key={k}><div className="row between"><label>{k}</label><button type="button" className="sm" onClick={() => { setJson({ ...json, [k]: JSON.stringify(rows[k], null, 2) }); const { [k]: _drop, ...rest } = rows; void _drop; setRows(rest); }}>Edit as JSON</button></div><ArrayEditor name={k} value={rows[k]} template={sample[k]} onChange={(v) => setRows({ ...rows, [k]: v })} /></div>
          : k in json ? <div key={k}><label htmlFor={k}>{k} (JSON)</label><textarea id={k} className="code" style={{ minHeight: 120 }} value={json[k]} onChange={(e) => setJson({ ...json, [k]: e.target.value })} /></div>
          : typeof sample[k] === 'boolean' ? <label key={k} className="inline"><input type="checkbox" checked={!!vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.checked })} />{k}</label>
          : <div key={k}><label htmlFor={k}>{k}{sample[k] === null ? ' (optional — leave empty if unknown)' : ''}</label>{k.match(/text|description|note/i) ? <textarea id={k} rows={3} value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /> : <input id={k} type={typeof sample[k] === 'number' || sample[k] === null ? 'number' : 'text'} value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value === '' ? undefined : (typeof sample[k] === 'number' || sample[k] === null) ? Number(e.target.value) : e.target.value })} />}</div>)}
        <div className="row" style={{ marginTop: 12 }}><button className="primary" disabled={busy === 'chg'}>{busy === 'chg' ? 'Analysing…' : `${L?.changeVerb ?? 'Submit change'} & analyse`}</button></div></form>}
    </div>
  </div>;
}

function Impact({ d }: Ctx) {
  const g = d.graph; const imp = new Set(g.nodes.filter((n: any) => n.kind === 'artifact').map((n: any) => n.key.replace('artifact:', '')));
  if (!g.nodes.length) return <Empty>No impact analysis yet. Submit a change.</Empty>;
  return <><p className="muted">Analysis rev {g.rev}. Layers read left to right: change → affected artifacts → departments/owners/tasks/decisions → actions → evidence.</p><Graph nodes={g.nodes} edges={g.edges} />
    <div className="card" style={{ marginTop: 12 }}><h2>Checked and not affected</h2><div className="row">{g.catalog.filter((c: any) => !imp.has(c.key)).map((c: any) => <span key={c.key} className="badge">{c.label}</span>)}{g.catalog.every((c: any) => imp.has(c.key)) && <span className="muted">Everything was reached.</span>}</div></div></>;
}

function Work({ d, me, isMgr, busy, post }: Ctx) {
  const items = d.workItems.filter((w: any) => w.current);
  return <div className="grid g2">
    <div className="card flush"><div style={{ padding: '14px 16px 0' }}><h2>Tasks & owners</h2></div><div className="table-wrap"><table><thead><tr><th>Task</th><th>Dept / owner</th><th>Kind</th><th>Status</th></tr></thead><tbody>{items.map((w: any) => <tr key={w.id}><td>{w.title}<div className="small muted">{w.detail}</div>{w.due && <div className="small">due {String(w.due).slice(0, 16).replace('T', ' ')}</div>}{w.data?.dependsOn?.length > 0 && <div className="small muted">needs first: {w.data.dependsOn.map((k: string) => items.find((x: any) => x.data?.key === k)?.title ?? k).join('; ')}</div>}{w.data?.satisfiedBy && <div className="small muted">satisfied by evidence from: {items.find((x: any) => x.data?.key === w.data.satisfiedBy)?.title ?? w.data.satisfiedBy}</div>}</td><td>{w.department}<div className="small muted">{w.owner ?? 'unassigned'}</div></td><td><span className={`badge ${w.kind === 'review' ? 'b-warn' : ''}`}>{w.kind}</span></td><td><Status s={w.status} />{(isMgr || w.owner_user_id === me.user.id) && <div><button className="sm" disabled={busy === w.id} onClick={() => post(w.id, `/work-items/${w.id}`, { status: w.status === 'done' ? 'open' : 'done' }, undefined, 'PATCH')}>{w.status === 'done' ? 'Reopen' : 'Mark done'}</button></div>}</td></tr>)}</tbody></table></div>{!items.length && <Empty>No tasks yet.</Empty>}</div>
    <div className="card"><h2>Questions for humans</h2>{d.questions.map((q: any) => q.status === 'open' ? <QuestionForm key={q.id} q={q} busy={busy} post={post} /> : <div key={q.id} className="msg"><Status s="answered" /> {q.text}<div className="small"><strong>Answer:</strong> {q.answer} <span className="muted">— {q.answered_by_name}, {fmtTime(q.answered_at)}</span></div></div>)}{!d.questions.length && <Empty>No open questions.</Empty>}</div>
  </div>;
}

function Agents({ d }: Ctx) {
  return <div className="grid g2">{d.agents.map((a: any) => <div className="card" key={a.key}><div className="row between"><h2 style={{ margin: 0 }}>{a.name}</h2><Status s={a.status} /></div><p className="small muted">{a.responsibility}</p>{a.analyzer ? <p className="small"><span className="badge b-info">rule-based</span> {a.analyzer} · mode {a.mode}</p> : null}<p>{a.summary || 'Has not run yet.'}</p><ul className="list">{a.findings.map((f: any, i: number) => <li key={i}><span className={`badge ${f.severity === 'risk' ? 'b-bad' : f.severity === 'warning' ? 'b-warn' : ''}`}>{f.severity}</span>{f.needsHumanReview && <span className="badge b-warn" title="A qualified human must review this">human review</span>} <span className="small">{f.text}</span></li>)}</ul></div>)}</div>;
}

function Room({ d, post, busy }: Ctx) {
  const [body, setBody] = useState(''); const [to, setTo] = useState(''); const room = d.room;
  return <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
    <div>
      {room ? <Banner tone={room.mode === 'switch' ? 'ok' : 'info'} title={room.mode === 'switch' ? `Switch room: ${room.name}` : 'LOCAL collaboration mode — this is NOT Switch'}>{room.mode === 'local' ? `${room.note || ''} ${room.collab.detail}` : room.collab.detail}</Banner> : <Banner tone="info" title="No room yet">A collaboration room is opened when the first change is analysed.</Banner>}
      {d.messages.map((m: any) => <div key={m.id} className={`msg ${m.sender_kind}`}><div className="head"><strong>{m.sender_name}</strong>{m.to_key && <span>→ {m.to_key}</span>}<span className="badge">{m.kind.replace('_', ' ')}</span><span>{fmtTime(m.created_at)}</span></div><pre>{m.body}</pre></div>)}
      {!d.messages.length && <Empty>No messages yet.</Empty>}
    </div>
    <div className="card" style={{ alignSelf: 'start' }}><h2>Post to the room</h2><p className="small muted">Human messages are recorded in the mission log{room?.mode === 'switch' ? ' and forwarded to the Switch room' : ' (local mode: not forwarded anywhere)'}. Free-form chat does not change mission state; answers and approvals do.</p>
      <label htmlFor="to">To (optional)</label><select id="to" value={to} onChange={(e) => setTo(e.target.value)}><option value="">everyone</option>{d.roles.map((r: any) => <option key={r.key} value={r.key}>{r.name}</option>)}</select>
      <label htmlFor="mb">Message</label><textarea id="mb" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} />
      <div className="row" style={{ marginTop: 8 }}><button disabled={!body.trim() || busy === 'msg'} onClick={async () => { const r = await post('msg', '/messages', { body, toKey: to || undefined }); if (r) setBody(''); }}>Send</button></div></div>
  </div>;
}

function Drafts({ d }: Ctx) {
  const [sel, setSel] = useState<string | null>(null); const [all, setAll] = useState(false);
  const arts = d.artifacts.filter((a: any) => a.kind !== 'original_plan' && (all || a.status !== 'superseded'));
  const cur = arts.find((a: any) => a.id === sel) ?? arts[0];
  if (!arts.length) return <Empty>No drafts yet. Drafts are generated by agents when a change is analysed.</Empty>;
  return <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2.4fr)' }}>
    <div className="card" style={{ alignSelf: 'start' }}>{arts.map((a: any) => <div key={a.id}><button style={{ width: '100%', textAlign: 'left', marginBottom: 6, borderColor: cur?.id === a.id ? 'var(--accent)' : undefined }} onClick={() => setSel(a.id)}>{a.name} <Status s={a.status} /><div className="small muted">rev {a.analysis_rev} · {a.owner_role}</div></button></div>)}<label className="inline"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />show superseded</label></div>
    {cur && <div className="card"><div className="row between"><h2 style={{ margin: 0 }}>{cur.name}</h2><Status s={cur.status} /></div><p className="small muted">Generated by <strong>{cur.generated_by}</strong> · from baseline v{cur.baseline_version}, change #{cur.change_seq}, rev {cur.analysis_rev} · sha256 {cur.content_hash.slice(0, 12)}…</p><div className="md">{cur.content}</div></div>}
  </div>;
}

function Actions({ d, isMgr, busy, post, me }: Ctx) {
  const acts = d.actions;
  if (!acts.length) return <Empty>{d.mission.state === 'blocked' ? 'No actions are proposed while the mission is blocked.' : 'No actions proposed yet.'}</Empty>;
  return <>{acts.map((a: any) => <ActionCard key={a.id} a={a} d={d} isMgr={isMgr} busy={busy} post={post} me={me} />)}</>;
}
function ActionCard({ a, d, isMgr, busy, post, me }: { a: any; d: any; isMgr: boolean; busy: string | null; post: Ctx['post']; me: Me }) {
  const [note, setNote] = useState(''); const [show, setShow] = useState(false);
  const ap = a.approval; const myAck = a.acks.find((k: any) => k.user_id === me.user.id);
  const dim = ['stale', 'superseded'].includes(a.status);
  return <div className="card" style={{ opacity: dim ? 0.75 : 1 }}>
    <div className="row between"><h2 style={{ margin: 0 }}>{a.title}</h2><Status s={a.status} /></div>
    <p className="small muted">Owner {a.owner ?? a.owner_role} · connector <strong>{a.connector}</strong> (<span className="mono">{a.connector_mode}</span>) → {a.payload.target} · from baseline v{a.baseline_version}, change #{a.change_seq}, rev {a.analysis_rev}{a.current ? '' : ' (not current)'} · attempts {a.attempts}</p>
    {a.stale_reason && <Banner tone="bad" title="Stale / superseded">{a.stale_reason}</Banner>}
    {a.last_error && <Banner tone="bad" title="Failure">{a.last_error}</Banner>}
    {ap && <p className="small"><strong>Approval:</strong> <Status s={ap.status} /> {ap.rationale} {ap.decided_by_name && <span className="muted">— {ap.decided_by_name}{ap.decision_note ? `: ${ap.decision_note}` : ''}</span>}</p>}
    <button className="sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} exact content that will be sent</button>{show && <div className="md" style={{ marginTop: 6 }}>{a.payload.body}</div>}
    {ap?.status === 'pending' && a.current && ((ap.required_role === 'owner' ? me.user.role === 'owner' : isMgr) ? <div style={{ marginTop: 10 }}><label htmlFor={`n${a.id}`}>Decision note (required to reject)</label><input id={`n${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} /><div className="row" style={{ marginTop: 8 }}><button className="primary" disabled={!!busy} onClick={() => post(`ap${a.id}`, `/approvals/${ap.id}/decide`, { decision: 'approved', note }, 'Approval recorded')}>Approve</button><button className="danger" disabled={!!busy || !note.trim()} onClick={() => post(`rj${a.id}`, `/approvals/${ap.id}/decide`, { decision: 'rejected', note }, 'Rejection recorded')}>Reject</button></div></div> : <p className="muted small">Waiting for {ap.required_role === 'owner' ? 'the workspace OWNER' : 'a manager'}’s decision (this action needs {ap.required_role}-level approval).</p>)}
    {['approved', 'failed', 'verification_failed', 'execution_unknown'].includes(a.status) && a.current && isMgr && <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={!!busy} onClick={() => post(`ex${a.id}`, `/actions/${a.id}/execute`, {}, a.status === 'approved' ? 'Execution requested — see verification result' : a.status === 'execution_unknown' ? 'Read-back requested — nothing is repeated unless the effect is confirmed absent' : 'Retry requested')}>{a.status === 'approved' ? 'Execute now' : a.status === 'execution_unknown' ? 'Read back, then retry if absent' : 'Retry (recovery)'}</button>{a.status === 'approved' && <span className="small muted">Result is only “verified” if the independent read-back passes.</span>}{a.status === 'execution_unknown' && <span className="small muted">The connector errored and could not be read back. The outcome is unknown; RIPPLE will not repeat the action while the effect may exist.</span>}</div>}
    {a.status === 'verified' && <><p className="small"><span className="badge b-ok">verified</span> executed {fmtTime(a.executed_at)} · {a.result?.deliveryNote}</p>{a.acks.map((k: any) => <div key={k.id} className="row small"><Status s={k.status} /> {k.name}{k.acked_at && ` · ${fmtTime(k.acked_at)}`}{k.note && ` — ${k.note}`}{k.user_id === me.user.id && k.status === 'pending' && <button className="sm primary" disabled={!!busy} onClick={() => post(`ack${k.id}`, `/actions/${a.id}/acknowledge`, { note: '' }, 'Acknowledged')}>Acknowledge receipt</button>}</div>)}</>}
    {myAck && a.status !== 'verified' && <p className="small muted">You will be asked to acknowledge once this is executed and verified.</p>}
    <details><summary className="small muted">Evidence ({d.evidence.filter((e: any) => e.action_id === a.id).length})</summary>{d.evidence.filter((e: any) => e.action_id === a.id).map((e: any) => <div key={e.id} className="small"><span className={`badge ${e.passed ? 'b-ok' : 'b-bad'}`}>{e.passed ? 'pass' : 'FAIL'}</span> {e.check_name} — {e.detail}</div>)}</details>
  </div>;
}

function Evidence({ d, isMgr, busy, post }: Ctx) {
  const byAction = useMemo(() => d.actions.filter((a: any) => d.evidence.some((e: any) => e.action_id === a.id)), [d]);
  return <div className="grid g2">
    <div className="card"><h2>Completion criteria</h2><Checklist c={d.completion} />{isMgr && d.mission.state !== 'completed' && <button className="primary" disabled={busy === 'done'} onClick={() => post('done', '/complete', {}, 'Mission completed — criteria verified')}>Complete mission</button>}<p className="small muted">The server refuses completion unless every criterion is met.</p>
      {d.completion.unresolved.length > 0 && <><h3>Will be recorded as unresolved</h3><ul className="list">{d.completion.unresolved.map((u: string, i: number) => <li key={i} className="small">{u}</li>)}</ul></>}</div>
    <div>
      {d.outcomes.map((o: any) => <div className="card" key={o.id}><h2>Outcome record</h2><Banner tone="ok" title={`Completed ${fmtTime(o.created_at)} → baseline v${o.new_baseline_version}`}>{o.summary}</Banner><h3>Completed ({o.completed?.length ?? 0})</h3><ul className="list">{(o.completed ?? []).map((u: string, i: number) => <li key={i} className="small">✔ {u}</li>)}</ul><h3>Unresolved at completion ({o.unresolved.length})</h3><ul className="list">{o.unresolved.map((u: string, i: number) => <li key={i} className="small">{u}</li>)}{!o.unresolved.length && <li className="small muted">none</li>}</ul></div>)}
      <div className="card"><h2>Evidence ledger</h2>{byAction.map((a: any) => <div key={a.id} style={{ marginBottom: 10 }}><strong>{a.title}</strong> <Status s={a.status} />{d.evidence.filter((e: any) => e.action_id === a.id).map((e: any) => <div key={e.id} className="small"><span className={`badge ${e.passed ? 'b-ok' : 'b-bad'}`}>{e.passed ? 'pass' : 'FAIL'}</span> {e.check_name} — {e.detail} <span className="muted mono">[{e.verifier}]</span></div>)}</div>)}{!byAction.length && <Empty>No evidence yet. Evidence is created only by independent verification of executed actions.</Empty>}</div>
    </div>
  </div>;
}

function Audit({ d }: Ctx) {
  return <div className="card flush"><div className="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Detail</th></tr></thead><tbody>{[...d.audit].reverse().map((e: any) => <tr key={e.id}><td className="small">{fmtTime(e.created_at)}</td><td className="small">{e.actor}<div className="muted">{e.actor_kind}</div></td><td><span className={`badge ${/fail|stale|refused|error/.test(e.type) ? 'b-bad' : /retry|recovery/.test(e.type) ? 'b-warn' : ''}`}>{e.type}</span></td><td className="small">{e.summary}</td></tr>)}</tbody></table></div></div>;
}
