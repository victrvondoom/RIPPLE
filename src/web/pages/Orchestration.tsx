import { useMemo, useState } from 'react';
import { fmtTime, useApi } from '../api';
import { Banner, Empty, Status } from '../components/ui';

type Ctx = { d: any; me: any; isMgr: boolean; busy: string | null; post: (k: string, p: string, b?: unknown, ok?: string, method?: string) => Promise<any>; setTab: (t: string) => void };

/** Visual states. Every one is derived from a persisted task, run, question or approval; nothing is animated without a real event. */
const NODE: Record<string, { label: string; color: string }> = {
  idle: { label: 'Idle (not in this plan yet)', color: '#8a8f98' },
  queued: { label: 'Queued', color: '#6b8cff' },
  working: { label: 'Working', color: '#2f9e6b' },
  waiting_on_human: { label: 'Awaiting human input', color: '#d18b00' },
  done: { label: 'Completed', color: '#2f9e6b' },
  reused: { label: 'Reused — inputs unchanged', color: '#4aa3a3' },
  failed: { label: 'Failed / interrupted / timed out', color: '#c0392b' },
};
function nodeState(agent: any): string {
  if (agent.status === 'waiting_on_human') return 'waiting_on_human';
  const s = agent.task?.status as string | undefined;
  if (!s) return 'idle';
  if (s === 'queued') return 'queued';
  if (s === 'running') return 'working';
  if (s === 'done') return 'done';
  if (s === 'reused') return 'reused';
  return 'failed';
}
const short = (name: string) => name.replace(/ Agent$/, '').replace(/ \(human\)$/, '');
const FAILED = ['failed', 'rejected', 'timed_out', 'interrupted'];

export function Orchestration({ d, me, isMgr, busy, post, setTab }: Ctx) {
  const o = d.orchestration;
  const agents: any[] = d.agents;
  const humanRoles: any[] = d.roles.filter((r: any) => r.kind === 'human');
  const hub = { x: 340, y: 232 };
  const W = 680, H = 480, rx = 236, ry = 152;
  const pos = new Map<string, { x: number; y: number }>();
  agents.forEach((a, i) => { const ang = -Math.PI / 2 + (i * 2 * Math.PI) / agents.length; pos.set(a.key, { x: hub.x + rx * Math.cos(ang), y: hub.y + ry * Math.sin(ang) }); });
  const human = { x: hub.x, y: H - 34 };
  const [sel, setSel] = useState<string | null>(null);
  const [selArt, setSelArt] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState('');
  const { data: people } = useApi<any>('/people');
  const selAgent = agents.find((a) => a.key === sel) ?? null;

  // Real message-derived edges
  const handoffs = useMemo(() => {
    const pairs = new Map<string, { from: string; to: string; n: number; last: number }>();
    for (const m of d.messages) {
      if (m.kind !== 'handoff' || m.sender_kind !== 'agent' || !m.to_key || !pos.has(m.sender_key) || !pos.has(m.to_key)) continue;
      if (m.data?.type === 'request') continue;
      const k = `${m.sender_key}>${m.to_key}`; const p = pairs.get(k) ?? { from: m.sender_key, to: m.to_key, n: 0, last: 0 };
      p.n++; p.last = Math.max(p.last, Date.parse(m.created_at)); pairs.set(k, p);
    }
    return [...pairs.values()];
  }, [d.messages, agents]);
  const recent = (t: number) => Date.now() - t < 20_000;
  const deps: { from: string; to: string }[] = [];
  for (const t of o.tasks) for (const dep of t.depends_on ?? []) if (pos.has(dep) && pos.has(t.role_key) && dep !== t.role_key) deps.push({ from: dep, to: t.role_key });
  const requests = o.requests.filter((r: any) => pos.has(r.from) && pos.has(r.to));
  const openBlockers = d.questions.filter((q: any) => q.status === 'open' && q.blocking);
  const pendingApprovals = d.approvals.filter((a: any) => a.status === 'pending');
  const artifacts = d.artifacts.filter((a: any) => a.kind !== 'original_plan' && a.status !== 'superseded');
  const curArt = artifacts.find((a: any) => a.id === selArt) ?? null;
  const progressPct = o.progress.total ? Math.round((o.progress.done / o.progress.total) * 100) : 0;

  return <div className="grid orch-grid" style={{ alignItems: 'start' }}>
    <div>
      <div className="card" style={{ padding: 10 }}>
        <div className="row between small muted" style={{ padding: '4px 6px' }}><span>Analysis rev {o.rev} · passes up to {o.maxPasses} · task time limit {Math.round(o.taskTimeoutMs / 1000)} s</span><span>{o.progress.done}/{o.progress.total} tasks done{o.progress.running ? ` · ${o.progress.running} running` : ''}{o.progress.queued ? ` · ${o.progress.queued} queued` : ''}</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Mission orchestration graph" style={{ display: 'block', maxHeight: 520 }}>
          <defs>
            <marker id="arrow-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2f9e6b" /></marker>
            <marker id="arrow-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#d18b00" /></marker>
          </defs>
          {/* assignments: orchestrator → agent (only for agents that have a task this revision) */}
          {agents.filter((a) => a.task).map((a) => { const p = pos.get(a.key)!; return <line key={`as-${a.key}`} x1={hub.x} y1={hub.y} x2={p.x} y2={p.y} stroke="#c9ced6" strokeWidth={1.5} strokeDasharray="4 4" />; })}
          {/* task dependencies (from the task graph) */}
          {deps.map((e, i) => { const a = pos.get(e.from)!, b = pos.get(e.to)!; return <line key={`dp-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#6b8cff" strokeWidth={1.2} strokeDasharray="1 4" opacity={0.7} />; })}
          {/* real handoffs between agents; animated only while a real message is fresh */}
          {handoffs.map((h) => { const a = pos.get(h.from)!, b = pos.get(h.to)!; const live = recent(h.last); return <line key={`h-${h.from}-${h.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2f9e6b" strokeWidth={2.2} markerEnd="url(#arrow-ok)" className={live ? 'orch-flow' : undefined} opacity={0.9} />; })}
          {/* agent requests (agent-to-agent), amber */}
          {requests.map((r: any, i: number) => { const a = pos.get(r.from)!, b = pos.get(r.to)!; return <line key={`rq-${r.id ?? i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#d18b00" strokeWidth={1.8} strokeDasharray="6 3" markerEnd="url(#arrow-amber)" opacity={0.85} />; })}
          {/* open human questions */}
          {agents.filter((a) => d.questions.some((q: any) => q.status === 'open' && q.asked_by_role === a.key)).map((a) => { const p = pos.get(a.key)!; return <line key={`hq-${a.key}`} x1={p.x} y1={p.y} x2={human.x} y2={human.y} stroke="#d18b00" strokeWidth={1.6} />; })}
          {/* hub */}
          <g aria-label="Mission Orchestrator">
            <circle cx={hub.x} cy={hub.y} r={54} fill="#1f2937" />
            <text x={hub.x} y={hub.y - 8} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={700}>Mission</text>
            <text x={hub.x} y={hub.y + 8} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={700}>Orchestrator</text>
            <text x={hub.x} y={hub.y + 25} textAnchor="middle" fill={d.mission.paused ? '#ffd27a' : '#cfe8d9'} fontSize={10}>{d.mission.paused ? 'PAUSED' : d.mission.state_label}</text>
          </g>
          {/* agents */}
          {agents.map((a) => { const p = pos.get(a.key)!; const st = nodeState(a); const c = NODE[st]; const isSel = sel === a.key; const cur = !!a.task; return (
            <g key={a.key} role="button" tabIndex={0} aria-label={`${a.name}: ${c.label}`} data-testid={`agent-${a.key}`} data-state={st} style={{ cursor: 'pointer' }} onClick={() => setSel(a.key)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(a.key); }}>
              <circle cx={p.x} cy={p.y} r={isSel ? 40 : 36} fill="#fff" stroke={c.color} strokeWidth={isSel ? 4 : 2.5} opacity={cur || st === 'idle' ? 1 : 0.6} className={st === 'working' ? 'orch-pulse' : undefined} />
              <text x={p.x} y={p.y - 3} textAnchor="middle" fontSize={11} fontWeight={700} fill="#1f2937">{short(a.name)}</text>
              <text x={p.x} y={p.y + 10} textAnchor="middle" fontSize={9} fill={c.color}>{c.label.split(' ')[0]}</text>
              {a.task && a.task.pass > 1 && <text x={p.x} y={p.y + 52} textAnchor="middle" fontSize={9} fill="#6b7280">pass {a.task.pass}</text>}
            </g>); })}
          {/* human operator */}
          <g aria-label="Human operator">
            <rect x={human.x - 90} y={human.y - 20} width={180} height={40} rx={10} fill="#fff7e6" stroke="#d18b00" strokeWidth={2} />
            <text x={human.x} y={human.y - 2} textAnchor="middle" fontSize={11} fontWeight={700} fill="#7a4d00">{humanRoles.find((r) => r.key === 'human_manager')?.name ?? 'Human operator'}</text>
            <text x={human.x} y={human.y + 11} textAnchor="middle" fontSize={9} fill="#7a4d00">{openBlockers.length ? `${openBlockers.length} blocking question(s)` : pendingApprovals.length ? `${pendingApprovals.length} approval(s) waiting` : 'no open decisions'}</text>
          </g>
        </svg>
        <div className="row small muted" style={{ flexWrap: 'wrap', gap: 14, padding: '6px 6px 2px' }} aria-label="Legend">
          <span><span style={{ color: '#2f9e6b' }}>━━</span> handoff (real message)</span>
          <span><span style={{ color: '#d18b00' }}>╍╍</span> agent request</span>
          <span><span style={{ color: '#6b8cff' }}>┄┄</span> task dependency</span>
          <span><span style={{ color: '#c9ced6' }}>- -</span> assignment</span>
          <span><span style={{ color: '#d18b00' }}>━</span> open question to human</span>
        </div>
      </div>

      {selAgent ? <AgentPanel a={selAgent} d={d} isMgr={isMgr} busy={busy} post={post} people={people?.users ?? []} note={note} setNote={setNote} ask={ask} setAsk={setAsk} setTab={setTab} /> : <div className="card" style={{ marginTop: 12 }}><Empty>Select an agent on the graph to see its task, inputs, findings, messages and errors. Nothing here is decorative: it reads the mission's task and run records.</Empty></div>}

      {curArt && <div className="card" style={{ marginTop: 12 }}><div className="row between"><h2 style={{ margin: 0 }}>{curArt.name}</h2><Status s={curArt.status} /></div><p className="small muted">Version: rev {curArt.analysis_rev}, baseline v{curArt.baseline_version}, change #{curArt.change_seq} · produced by <strong>{d.roles.find((r: any) => r.key === curArt.owner_role)?.name ?? curArt.owner_role ?? '—'}</strong> via <span className="mono">{curArt.generated_by}</span> · sha256 {curArt.content_hash.slice(0, 16)}… · {fmtTime(curArt.created_at)}</p><div className="md">{curArt.content}</div></div>}
    </div>

    <div>
      <div className="card"><h2>Mission</h2>
        <div className="row between"><strong>{d.mission.state_label}</strong>{d.mission.paused ? <span className="badge b-warn">paused by a human</span> : <span className="badge b-ok">running</span>}</div>
        <div className="small muted" style={{ margin: '6px 0' }}>Iteration: analysis rev {o.rev}{o.rounds.length > 1 ? ` (${o.rounds.length} revisions)` : ''} · current revision passes {Math.max(0, ...o.tasks.map((t: any) => t.pass))}</div>
        <div aria-label="Progress" style={{ background: '#e5e7eb', borderRadius: 6, height: 10, overflow: 'hidden' }}><div style={{ width: `${progressPct}%`, height: 10, background: '#2f9e6b', transition: 'width .4s' }} /></div>
        <div className="small muted">{o.progress.done} of {o.progress.total} agent tasks done this revision</div>
        <div className="row" style={{ marginTop: 8 }}>
          {isMgr && !d.mission.paused && !['completed', 'cancelled'].includes(d.mission.state) && <button className="sm" disabled={!!busy} onClick={() => post('pause', '/pause', { reason: 'Paused from the orchestration canvas' }, 'Mission paused: agents stop before their next task')}>Pause all agents</button>}
          {isMgr && d.mission.paused && <button className="sm primary" disabled={!!busy} onClick={() => post('resume', '/resume', {}, 'Mission resumed')}>Resume mission</button>}
        </div>
      </div>

      <div className="card"><h2>Blockers & failures</h2>
        {!openBlockers.length && !o.escalations.length && !o.tasks.some((t: any) => FAILED.includes(t.status)) && <p className="small muted">None.</p>}
        {openBlockers.map((q: any) => <Banner key={q.id} tone="warn" title={`Waiting on a human: ${q.key}`}>{q.text}</Banner>)}
        {o.tasks.filter((t: any) => FAILED.includes(t.status)).map((t: any) => <Banner key={t.id} tone="bad" title={`${t.role_name}: ${t.status.replace('_', ' ')}`}>{t.error ?? 'No detail recorded.'}</Banner>)}
        {o.iterationLimitReached && <Banner tone="bad" title="Automatic loop stopped">The agents did not converge within {o.maxPasses} passes. A human must decide how to proceed.</Banner>}
      </div>

      <div className="card"><h2>Approvals waiting ({pendingApprovals.length})</h2>
        {!pendingApprovals.length && <p className="small muted">Nothing waiting. Approvals are created only from agent proposals and are never granted by a card being shown.</p>}
        {pendingApprovals.map((ap: any) => { const act = d.actions.find((a: any) => a.id === ap.subject_id); const canDecide = ap.required_role === 'owner' ? me.user.role === 'owner' : isMgr; const n = note[ap.id] ?? ''; return <div key={ap.id} className="card" style={{ background: '#fffbf0', marginBottom: 10 }}>
          <strong>{act?.title ?? ap.title}</strong>
          <p className="small"><strong>Recommendation:</strong> {ap.rationale}</p>
          <p className="small muted"><strong>Proposed by:</strong> {d.roles.find((r: any) => r.key === act?.owner_role)?.name ?? act?.owner_role} · <strong>Target:</strong> {act?.payload?.target ?? '—'} · <strong>Connector:</strong> {act?.connector} ({act?.connector_mode}) · <strong>Needs:</strong> {ap.required_role}</p>
          <p className="small"><strong>If approved:</strong> the action becomes executable. Nothing runs until a manager executes it; the effect is then re-read from the connector and must match the approved text. <strong>If rejected:</strong> the action is marked rejected and no effect is produced.</p>
          <details><summary className="small">Exact content</summary><div className="md">{act?.payload?.body}</div></details>
          {canDecide && <><label htmlFor={`an-${ap.id}`} className="small">Note (required to reject)</label><input id={`an-${ap.id}`} value={n} onChange={(e) => setNote({ ...note, [ap.id]: e.target.value })} />
            <div className="row" style={{ marginTop: 6 }}><button className="primary sm" disabled={!!busy} onClick={() => post(`ap${ap.id}`, `/approvals/${ap.id}/decide`, { decision: 'approved', note: n }, 'Approved — recorded in the audit log')}>Approve</button><button className="sm danger" disabled={!!busy || !n.trim()} onClick={() => post(`ap${ap.id}`, `/approvals/${ap.id}/decide`, { decision: 'rejected', note: n }, 'Rejected — recorded in the audit log')}>Reject</button></div></>}
          {!canDecide && <p className="small muted">Only {ap.required_role === 'owner' ? 'the workspace owner' : 'a manager'} can decide this.</p>}
        </div>; })}
      </div>

      <div className="card"><h2>Switch & collaboration</h2>{d.room ? <Banner tone={d.room.mode === 'switch' ? 'ok' : 'info'} title={d.room.mode === 'switch' ? `Switch room: ${d.room.name}` : 'Local mode — not Switch'}>{d.room.status === 'degraded' ? `Degraded: ${d.room.note}` : d.room.collab.detail}</Banner> : <p className="small muted">No room yet.</p>}</div>

      <div className="card"><h2>Latest artifacts</h2>
        {artifacts.slice(-6).reverse().map((a: any) => <button key={a.id} className="sm" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, borderColor: curArt?.id === a.id ? 'var(--accent)' : undefined }} onClick={() => setSelArt(a.id)}>{a.name} <Status s={a.status} /><div className="small muted">{d.roles.find((r: any) => r.key === a.owner_role)?.name ?? a.owner_role ?? 'mission'} · rev {a.analysis_rev}</div></button>)}
        {!artifacts.length && <p className="small muted">No artifacts yet.</p>}
        <button className="sm" onClick={() => setTab('drafts')}>All drafts</button>
      </div>

      <div className="card"><h2>Live activity</h2>
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          {[...d.messages.map((m: any) => ({ id: m.id, at: m.created_at, text: `${m.sender_name}${m.to_key ? ` → ${m.to_key}` : ''}: ${m.kind.replace('_', ' ')} — ${String(m.body).split('\n')[0].slice(0, 110)}` })), ...d.audit.filter((e: any) => /^orch_|approval_|action_executed|verified|work_item_reassigned|question_answered/.test(e.type)).map((e: any) => ({ id: e.id, at: e.created_at, text: e.summary.slice(0, 130) }))]
            .sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 25).map((e) => <div key={e.id} className="small" style={{ borderBottom: '1px solid #eee', padding: '5px 0' }}><span className="muted">{fmtTime(e.at)}</span> · {e.text}</div>)}
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>Refreshes every few seconds from the server. Your browser holds no mission state.</p>
      </div>
    </div>
  </div>;
}

function AgentPanel({ a, d, isMgr, busy, post, people, note, setNote, ask, setAsk, setTab }: { a: any; d: any; isMgr: boolean; busy: string | null; post: Ctx['post']; people: any[]; note: Record<string, string>; setNote: (n: Record<string, string>) => void; ask: string; setAsk: (s: string) => void; setTab: (t: string) => void }) {
  const t = a.task; const st = nodeState(a);
  const sent = d.messages.filter((m: any) => m.sender_key === a.key).slice(-6);
  const recv = d.messages.filter((m: any) => m.to_key === a.key).slice(-6);
  const produced = d.artifacts.filter((x: any) => x.owner_role === a.key && x.status !== 'superseded');
  const openWork = d.workItems.filter((w: any) => w.current && w.role_key === a.key && w.status !== 'done');
  const dependsOn = (t?.depends_on ?? []) as string[];
  const nameOf = (k: string) => d.roles.find((r: any) => r.key === k)?.name ?? k;
  return <div className="grid g2" style={{ marginTop: 12 }}>
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>{a.name}</h2><span className="badge" style={{ borderColor: NODE[st].color, color: NODE[st].color }}>{NODE[st].label}</span></div>
      <p className="small muted">{a.responsibility}</p>
      <p className="small"><strong>Runtime:</strong> <span className="mono">{a.mode ?? 'not run yet'}</span> · {a.analyzer ? <>analyzer <span className="mono">{a.analyzer}</span> (deterministic, labelled)</> : 'no analyzer output yet'}</p>
      <h3>Current task</h3>
      {t ? <div className="small">
        <div><strong>Task:</strong> {a.responsibility}</div>
        <div><strong>Pass:</strong> {t.pass} ({t.kind}) · <strong>Status:</strong> {t.status}{t.attempts ? ` · attempts ${t.attempts}` : ''}</div>
        <div><strong>Why it ran:</strong> {t.reason}{t.requested_by ? ` (requested by ${nameOf(t.requested_by)})` : ''}</div>
        <div><strong>Depends on:</strong> {dependsOn.length ? dependsOn.map(nameOf).join(', ') : 'nothing — starts immediately'}</div>
        <div><strong>Input:</strong> baseline v{d.mission.current_baseline_version}, change #{d.mission.change_seq}, {d.changes.length ? d.changes[d.changes.length - 1].items.length : 0} change item(s){dependsOn.length ? '; outputs of the dependencies above' : ''}</div>
        {t.reused_from && <div><strong>Reused:</strong> result from an earlier revision because its inputs did not change (no re-run)</div>}
        {t.error && <div style={{ color: '#c0392b' }}><strong>Error:</strong> {t.error}</div>}
        <div className="muted">fingerprint {String(t.fingerprint ?? '').slice(0, 12) || '—'}…</div>
      </div> : <p className="small muted">This agent has no task in the current revision (it is not part of this plan's dependency graph for this change).</p>}
      <h3>Findings</h3>
      {a.findings?.length ? <ul className="list small">{a.findings.slice(0, 8).map((f: any, i: number) => <li key={i}><span className={`badge ${f.severity === 'risk' ? 'b-bad' : f.severity === 'warning' ? 'b-warn' : ''}`}>{f.severity}</span> {f.text}</li>)}</ul> : <p className="small muted">No findings yet.</p>}
      <h3>Artifacts produced</h3>
      {produced.length ? produced.map((x: any) => <div key={x.id} className="small">{x.name} <Status s={x.status} /> <span className="muted">rev {x.analysis_rev}</span></div>) : <p className="small muted">None in the current revision.</p>}
      <button className="sm" onClick={() => setTab('drafts')} style={{ marginTop: 6 }}>Open drafts</button>
    </div>
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Messages</h3>
      <div className="small"><strong>Sent</strong>{sent.length ? sent.map((m: any) => <div key={m.id} className="muted">→ {m.to_key ?? 'room'}: {m.kind} — {String(m.body).split('\n')[0].slice(0, 90)}</div>) : <div className="muted">none</div>}</div>
      <div className="small" style={{ marginTop: 6 }}><strong>Received</strong>{recv.length ? recv.map((m: any) => <div key={m.id} className="muted">← {m.sender_name}: {m.kind} — {String(m.body).split('\n')[0].slice(0, 90)}</div>) : <div className="muted">none</div>}</div>
      <h3>Actions on this agent</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {d.mission.paused
          ? (isMgr && <button className="sm primary" disabled={!!busy} onClick={() => post('resume', '/resume', {}, 'Mission resumed')}>Resume mission</button>)
          : (isMgr && !['completed', 'cancelled'].includes(d.mission.state) && <button className="sm" disabled={!!busy} onClick={() => post('pause', '/pause', { reason: `Paused from the ${a.name} panel` }, 'Mission paused: all agents stop before their next task')}>Pause (whole mission)</button>)}
        {isMgr && t && ['failed', 'timed_out', 'interrupted', 'rejected'].includes(t.status) && !d.mission.paused && ['blocked', 'failed', 'analyzing'].includes(d.mission.state) && <button className="sm primary" disabled={!!busy} onClick={() => post('retry', '/retry-analysis', {}, 'Re-analysis started; completed agents are reused')}>Retry analysis</button>}
      </div>
      <p className="small muted">Pause and retry act on the whole analysis, because agents run inside one mission revision. Per-agent pause is not implemented.</p>
      <h3>Ask this agent</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (!ask.trim()) return; post('ask', '/messages', { body: ask, toKey: a.key }, 'Message recorded in the mission log').then((r) => { if (r) setAsk(''); }); }}>
        <textarea aria-label="Message to agent" rows={2} maxLength={2000} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Add context for this agent…" />
        <div className="row" style={{ marginTop: 6 }}><button disabled={!ask.trim() || !!busy}>Send to agent</button></div>
        <p className="small muted">The message is logged and forwarded to the room. It does not change this agent's result by itself; answers to questions and re-analysis do.</p>
      </form>
      <h3>Reassign work</h3>
      {openWork.length ? openWork.map((w: any) => <div key={w.id} className="small" style={{ marginBottom: 6 }}>{w.title} <span className="muted">— owner {w.owner ?? 'unassigned'}</span>
        {isMgr && <div className="row" style={{ marginTop: 4 }}><select aria-label={`Reassign ${w.title}`} value={note[`rw${w.id}`] ?? ''} onChange={(e) => setNote({ ...note, [`rw${w.id}`]: e.target.value })}><option value="">choose person…</option>{people.filter((p: any) => p.role !== 'viewer').map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="sm" disabled={!note[`rw${w.id}`] || !!busy} onClick={() => post(`rw${w.id}`, `/work-items/${w.id}/reassign`, { userId: note[`rw${w.id}`] }, 'Work item reassigned (audited)')}>Reassign</button></div>}
      </div>) : <p className="small muted">No open work items for this agent.</p>}
    </div>
  </div>;
}
