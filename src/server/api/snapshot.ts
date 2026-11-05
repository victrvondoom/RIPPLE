import type { Engine } from '../engine/engine.js';
import { evaluateCompletion } from '../engine/completion.js';
import { STATE_LABEL, TRANSITIONS } from '../engine/states.js';
import { j, type Row } from '../db/db.js';
import { MAX_PASSES, TASK_TIMEOUT_MS } from '../engine/orchestrator.js';

const parse = (r: Row, ...keys: string[]): any => { const o: any = { ...r }; for (const k of keys) if (typeof o[k] === 'string') o[k] = j(o[k]); return o; };

export function missionDetail(e: Engine, ws: string, id: string) {
  const m = e.mission(ws, id); const db = e.db; const pack = e.pack(m);
  const rev = m.analysis_rev;
  const q = (sql: string, ...p: any[]) => db.all(sql, ...p);
  const users = new Map(q('SELECT id,name,title FROM users WHERE workspace_id=?', ws).map((u) => [u.id, u]));
  const userName = (uid?: string | null) => (uid ? users.get(uid)?.name ?? null : null);
  const roles: any[] = q('SELECT * FROM agent_roles WHERE workspace_id=? AND pack_id=?', ws, m.pack_id).map((r) => ({ ...r, user: r.user_id ? users.get(r.user_id) ?? null : null }));
  const runs = q('SELECT * FROM agent_runs WHERE mission_id=? AND workspace_id=? ORDER BY started_at', id, ws).map((r) => parse(r, 'output'));
  const latestRun = new Map<string, Row>(); for (const r of runs) latestRun.set(r.role_key, r);
  const questions = q('SELECT * FROM questions WHERE mission_id=? AND workspace_id=? ORDER BY created_at', id, ws).map((x) => ({ ...parse(x, 'answer_value'), blocking: !!x.blocking, assignee: userName(x.assignee_user_id), answered_by_name: userName(x.answered_by) }));
  const openQ = questions.filter((x) => x.status === 'open');
  const agentStatus = roles.filter((r) => r.kind === 'agent').map((r) => {
    const run = latestRun.get(r.key);
    const waiting = openQ.some((x) => x.asked_by_role === r.key);
    return { key: r.key, name: r.name, responsibility: r.responsibility, status: !run ? 'idle' : run.status === 'failed' ? 'failed' : waiting ? 'waiting_on_human' : run.status === 'working' ? 'working' : 'done', summary: run?.summary ?? '', analyzer: run?.output?.analyzer ?? null, mode: run?.mode ?? null, findings: run?.output?.findings ?? [], rev: run?.analysis_rev ?? null };
  });
  const actions = q('SELECT * FROM actions WHERE mission_id=? AND workspace_id=? ORDER BY created_at', id, ws).map((a) => {
    const acks = q('SELECT k.*, u.name FROM acknowledgements k JOIN users u ON u.id=k.user_id WHERE k.action_id=?', a.id).map((k) => ({ id: k.id, user_id: k.user_id, name: k.name, status: k.status, note: k.note, acked_at: k.acked_at }));
    const approval = db.get('SELECT * FROM approvals WHERE subject_id=? AND workspace_id=? ORDER BY created_at DESC', a.id, ws);
    return { ...parse(a, 'payload', 'result'), consequential: !!a.consequential, owner: userName(a.owner_user_id), acks, approval: approval ? { ...approval, decided_by_name: userName(approval.decided_by) } : null, current: a.analysis_rev === rev && a.change_seq === m.change_seq, connector_mode: e.connectors[a.connector]?.mode };
  });
  const nodes = q('SELECT * FROM graph_nodes WHERE mission_id=? AND workspace_id=? AND analysis_rev=?', id, ws, rev).map((n) => parse(n, 'data'));
  const nodeActionStatus = new Map(actions.filter((a) => a.current).map((a) => [`action:${a.key}`, a.status]));
  for (const n of nodes) if (n.kind === 'action') n.status = nodeActionStatus.get(n.key) ?? n.status;
  const evidenceNodes = actions.filter((a) => a.current && a.status === 'verified').map((a) => ({ id: `ev_${a.id}`, kind: 'evidence', key: `evidence:${a.key}`, label: `Verified: ${a.title}`, status: 'verified', data: {}, parent: nodes.find((n) => n.key === `action:${a.key}`)?.id }));
  const edges = q('SELECT * FROM dependencies WHERE mission_id=? AND workspace_id=? AND analysis_rev=?', id, ws, rev);
  for (const ev of evidenceNodes) if (ev.parent) edges.push({ id: `e_${ev.id}`, from_node: ev.parent, to_node: ev.id, relation: 'proved_by' });
  const room = db.get('SELECT * FROM rooms WHERE mission_id=? AND workspace_id=? ORDER BY created_at DESC', id, ws);
  const completion = evaluateCompletion(e, m);
  // Orchestrator read model: the task graph of every analysis revision, the current revision's tasks, agent requests and escalations.
  const roleNames = new Map(roles.map((r) => [r.key, r.name]));
  const taskRows = q('SELECT * FROM workflow_tasks WHERE mission_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws);
  const roundMap = new Map<number, { rev: number; passes: number; ran: number; reused: number; failed: number }>();
  for (const t of taskRows) {
    const r = roundMap.get(t.analysis_rev) ?? { rev: t.analysis_rev, passes: 0, ran: 0, reused: 0, failed: 0 };
    r.passes = Math.max(r.passes, t.pass);
    if (t.status === 'done') r.ran++;
    if (t.status === 'reused') r.reused++;
    if (['failed', 'rejected', 'timed_out', 'interrupted'].includes(t.status)) r.failed++;
    roundMap.set(t.analysis_rev, r);
  }
  const currentTasks = taskRows.filter((t) => t.analysis_rev === rev).map((t) => ({ ...parse(t, 'depends_on'), role_name: roleNames.get(t.role_key) ?? t.role_key }));
  const taskDone = currentTasks.filter((t) => ['done', 'reused'].includes(t.status)).length;
  const escalations = q("SELECT * FROM audit_events WHERE mission_id=? AND workspace_id=? AND type IN ('orch_iteration_limit','orch_timed_out','orch_output_rejected','orch_interrupted','orch_paused','orch_resumed','orch_paused_mid_run') ORDER BY created_at, rowid", id, ws).map((x) => parse(x, 'data'));
  const requestEvents = q('SELECT * FROM messages WHERE mission_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws).filter((x) => j(x.data, {})?.type === 'request').map((x) => ({ id: x.id, from: x.sender_key, to: x.to_key, body: x.body, created_at: x.created_at }));
  const orchestration = {
    paused: !!m.paused,
    rev,
    maxPasses: MAX_PASSES,
    taskTimeoutMs: TASK_TIMEOUT_MS,
    progress: { total: currentTasks.length, done: taskDone, running: currentTasks.filter((t) => t.status === 'running').length, queued: currentTasks.filter((t) => t.status === 'queued').length },
    tasks: currentTasks,
    rounds: [...roundMap.values()].sort((x, y) => x.rev - y.rev),
    requests: requestEvents,
    escalations,
    iterationLimitReached: escalations.some((x) => x.type === 'orch_iteration_limit' && x.data?.rev === rev),
  };
  const agentTask = new Map(currentTasks.map((t) => [t.role_key, t]));
  for (const ag of agentStatus) (ag as any).task = agentTask.get(ag.key) ?? null;
  return {
    mission: { ...m, state_label: STATE_LABEL[m.state as keyof typeof STATE_LABEL], next_states: TRANSITIONS[m.state as keyof typeof TRANSITIONS], pack_name: pack.name, domain: pack.domain, created_by_name: userName(m.created_by) },
    baselines: q('SELECT id,version,plan,plan_hash,note,approved_by,created_at FROM baselines WHERE mission_id=? AND workspace_id=? ORDER BY version', id, ws).map((b) => ({ ...parse(b, 'plan'), approved_by_name: userName(b.approved_by) })),
    changes: q('SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? ORDER BY seq', id, ws).map((c) => ({ ...parse(c, 'input', 'items'), created_by_name: userName(c.created_by) })),
    artifacts: q('SELECT * FROM artifacts WHERE mission_id=? AND workspace_id=? ORDER BY created_at', id, ws),
    graph: { rev, nodes: [...nodes, ...evidenceNodes.map((e) => { const n: any = { ...e }; delete n.parent; return n; })], edges, catalog: pack.artifacts.map((a) => ({ key: a.key, label: a.label, department: a.department })) },
    workItems: q('SELECT * FROM work_items WHERE mission_id=? AND workspace_id=? ORDER BY created_at', id, ws).map((w) => ({ ...parse(w, 'data'), owner: userName(w.owner_user_id), current: w.analysis_rev === rev })),
    roles, agents: agentStatus,
    room: room ? { ...room, collab: e.collab.describe() } : null,
    messages: q('SELECT * FROM messages WHERE mission_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws).map((x) => parse(x, 'data')),
    questions, actions,
    approvals: q('SELECT * FROM approvals WHERE mission_id=? AND workspace_id=? ORDER BY created_at', id, ws).map((a) => ({ ...a, decided_by_name: userName(a.decided_by) })),
    evidence: q('SELECT * FROM evidence WHERE mission_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws).map((x) => ({ ...parse(x, 'data'), passed: !!x.passed })),
    outcomes: q('SELECT * FROM outcomes WHERE mission_id=? AND workspace_id=? ORDER BY created_at', id, ws).map((o) => parse(o, 'criteria', 'unresolved', 'completed')),
    audit: q('SELECT * FROM audit_events WHERE mission_id=? AND workspace_id=? ORDER BY created_at, rowid', id, ws).map((x) => parse(x, 'data')),
    completion,
    orchestration,
  };
}

export function overview(e: Engine, ws: string) {
  const db = e.db;
  const missions: any[] = db.all('SELECT * FROM missions WHERE workspace_id=? ORDER BY updated_at DESC', ws).map((m) => ({ ...m, state_label: STATE_LABEL[m.state as keyof typeof STATE_LABEL], pack_name: e.packs.get(m.pack_id)?.name ?? m.pack_id }));
  const today = new Date().toISOString().slice(0, 10);
  const mName = new Map(missions.map((m) => [m.id, m.title]));
  for (const m of missions) {
    const open = db.all("SELECT w.due, u.name AS owner FROM work_items w LEFT JOIN users u ON u.id=w.owner_user_id WHERE w.workspace_id=? AND w.mission_id=? AND w.analysis_rev=? AND w.status!='done'", ws, m.id, m.analysis_rev);
    m.domain = e.packs.get(m.pack_id)?.domain ?? '';
    m.pending_approvals = db.get("SELECT count(*) n FROM approvals WHERE mission_id=? AND workspace_id=? AND status='pending'", m.id, ws)?.n ?? 0;
    m.open_work = open.length; m.overdue = open.filter((w) => w.due && w.due.slice(0, 10) < today).length;
    m.owners = [...new Set(open.map((w) => w.owner).filter(Boolean))];
    m.last_change_at = db.get('SELECT max(created_at) t FROM change_events WHERE mission_id=? AND workspace_id=?', m.id, ws)?.t ?? null;
  }
  const withName = (rows: Row[]) => rows.map((r) => ({ ...r, mission_title: mName.get(r.mission_id) }));
  return {
    missions,
    awaitingApproval: missions.filter((m) => m.state === 'awaiting_approval'),
    blocked: missions.filter((m) => m.state === 'blocked').map((m) => ({ ...m })),
    recovery: missions.filter((m) => m.state === 'recovery_required'),
    recentChanges: withName(db.all('SELECT id,mission_id,seq,description,items,status,created_at FROM change_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 8', ws)).map((c) => parse(c, 'items')),
    outstandingWork: withName(db.all("SELECT w.*, u.name AS owner FROM work_items w LEFT JOIN users u ON u.id=w.owner_user_id JOIN missions m ON m.id=w.mission_id WHERE w.workspace_id=? AND w.status!='done' AND w.analysis_rev=m.analysis_rev AND m.state NOT IN ('completed','cancelled') ORDER BY w.created_at LIMIT 30", ws)),
    problemActions: withName(db.all("SELECT * FROM actions WHERE workspace_id=? AND status IN ('failed','verification_failed','execution_unknown','stale') ORDER BY created_at DESC LIMIT 20", ws)),
    pendingApprovals: withName(db.all("SELECT * FROM approvals WHERE workspace_id=? AND status='pending' ORDER BY created_at DESC", ws)),
    recentOutcomes: withName(db.all("SELECT * FROM outcomes WHERE workspace_id=? ORDER BY created_at DESC LIMIT 8", ws)).map((o) => parse(o, 'criteria', 'unresolved')),
    openQuestions: withName(db.all("SELECT * FROM questions WHERE workspace_id=? AND status='open' ORDER BY created_at DESC", ws)),
  };
}
