import type { Context, Hono } from 'hono';
import type { Actor, Engine } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { evaluateCompletion } from '../engine/completion.js';
import { STATE_LABEL } from '../engine/states.js';
import { j, nowIso, sha256, stable, uid, type Row } from '../db/db.js';
import { reconcileDerived } from '../capabilities/reconcile/derived.js';
import { PACK_SYSTEM, PROJECTS, SCENARIOS, SYSTEMS, systemOfPack, type ScenarioStep } from '../capabilities/catalog.js';

type Env = { Variables: { actor: Actor } };
export const DASH_TABLES = ['ledger_seals', 'console_state', 'console_messages'];

/** Mission state → lifecycle stage used by every dashboard. */
export const STAGE_OF: Record<string, ScenarioStep['stage']> = {
  draft: 'intake', baseline_ready: 'intake', analyzing: 'analysis', blocked: 'analysis', awaiting_approval: 'approval',
  executing: 'execute', verifying: 'verify', recovery_required: 'verify', completed: 'complete', failed: 'complete', cancelled: 'complete',
};
const STAGES: ScenarioStep['stage'][] = ['intake', 'analysis', 'approval', 'execute', 'verify', 'complete'];
const DAY = 86_400_000;
const since = (ms: number) => new Date(Date.now() - ms).toISOString();
const PROBLEM = ['failed', 'verification_failed', 'execution_unknown', 'stale'];
const ENDED = ['completed', 'cancelled', 'failed'];

function people(e: Engine, ws: string) {
  return new Map<string, Row>(e.db.all('SELECT id,name,title,role,department FROM users WHERE workspace_id=?', ws).map((u) => [u.id, u]));
}
function missions(e: Engine, ws: string): Row[] {
  return e.db.all('SELECT * FROM missions WHERE workspace_id=? ORDER BY updated_at DESC', ws).map((m): Row => {
    const pack = e.packs.get(m.pack_id);
    return { ...m, pack_name: pack?.name ?? m.pack_id, domain: pack?.domain ?? '', system: systemOfPack(m.pack_id), stage: STAGE_OF[m.state] ?? 'intake', state_label: STATE_LABEL[m.state as keyof typeof STATE_LABEL] ?? m.state };
  });
}

// ------------------------------------------------------------------ Mission Control
export function missionControl(e: Engine, ws: string) {
  const db = e.db; const ms = missions(e, ws); const users = people(e, ws);
  const sysOf = (missionId: string) => systemOfPack(ms.find((m) => m.id === missionId)?.pack_id ?? '');
  const live = ms.filter((m) => !ENDED.includes(m.state));
  const acts = db.all("SELECT a.*, m.title AS mission_title FROM actions a JOIN missions m ON m.id=a.mission_id WHERE a.workspace_id=? AND a.status!='superseded'", ws);
  const finished = acts.filter((a) => ['verified', 'executed', ...PROBLEM].includes(a.status));
  const verified = acts.filter((a) => a.status === 'verified').length;
  const evidence = db.all('SELECT passed, created_at FROM evidence WHERE workspace_id=? AND created_at>=?', ws, since(30 * DAY));
  const pendingAp = db.all("SELECT a.*, m.title AS mission_title FROM approvals a JOIN missions m ON m.id=a.mission_id WHERE a.workspace_id=? AND a.status='pending' ORDER BY a.created_at", ws);
  const today = new Date().toISOString().slice(0, 10);

  // 14-day verification health: share of independent checks that passed, per day (days without checks are null, never 0%).
  const trend: { day: string; checks: number; passed: number; rate: number | null }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    const rows = evidence.filter((x) => x.created_at.slice(0, 10) === day);
    const p = rows.filter((x) => x.passed).length;
    trend.push({ day, checks: rows.length, passed: p, rate: rows.length ? Math.round((p / rows.length) * 1000) / 10 : null });
  }
  const evPassed = evidence.filter((x) => x.passed).length;

  // Needs attention: every item is a recorded fact with an owner and the time it started waiting.
  const attention: Row[] = [];
  for (const m of live.filter((x) => x.state === 'recovery_required')) attention.push({ priority: 'critical', title: m.title, detail: m.state_reason || 'Recovery required', owner: users.get(m.created_by)?.name ?? '—', since: m.updated_at, action: 'Investigate', href: `#/mission/${m.id}`, system: m.system });
  for (const a of acts.filter((x) => PROBLEM.includes(x.status))) attention.push({ priority: a.status === 'stale' ? 'warning' : 'critical', title: a.title, detail: `${a.status.replace(/_/g, ' ')}${a.last_error ? ` · ${a.last_error}` : a.stale_reason ? ` · ${a.stale_reason}` : ''}`, owner: users.get(a.owner_user_id)?.name ?? a.owner_role, since: a.executed_at ?? a.created_at, action: 'Review', href: `#/mission/${a.mission_id}`, system: sysOf(a.mission_id) });
  for (const m of live.filter((x) => x.state === 'blocked')) attention.push({ priority: 'warning', title: m.title, detail: m.state_reason || 'Blocked', owner: users.get(m.created_by)?.name ?? '—', since: m.updated_at, action: 'Unblock', href: `#/mission/${m.id}`, system: m.system });
  for (const a of pendingAp) attention.push({ priority: 'info', title: a.title, detail: `${a.mission_title} · needs ${a.approver_label ?? a.required_role}`, owner: users.get(a.approver_user_id)?.name ?? a.required_role, since: a.created_at, action: 'Approve', href: '#/approvals', system: sysOf(a.mission_id) });
  const overdue = db.all("SELECT w.*, m.title AS mission_title FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.workspace_id=? AND w.status!='done' AND w.analysis_rev=m.analysis_rev AND w.due IS NOT NULL AND substr(w.due,1,10)<? AND m.state NOT IN ('completed','cancelled')", ws, today);
  for (const w of overdue) attention.push({ priority: 'warning', title: w.title, detail: `Overdue since ${String(w.due).slice(0, 10)} · ${w.mission_title}`, owner: users.get(w.owner_user_id)?.name ?? w.department, since: w.due, action: 'Follow up', href: `#/mission/${w.mission_id}`, system: sysOf(w.mission_id) });
  const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  attention.sort((a, b) => rank[a.priority] - rank[b.priority] || String(a.since).localeCompare(String(b.since)));

  // Lifecycle coverage per capability system: missions run through its packs and how far they got.
  const coverage = SYSTEMS.map((s) => {
    const sm = ms.filter((m) => m.system === s.id);
    const packs = Object.entries(PACK_SYSTEM).filter(([k, v]) => v === s.id && e.packs.get(k)).map(([k]) => k);
    const done = sm.filter((m) => m.state === 'completed').length;
    return { id: s.id, no: s.no, name: s.name, short: s.short, missions: sm.length, active: sm.filter((m) => !ENDED.includes(m.state)).length, completed: done, coverage: sm.length ? Math.round((done / sm.length) * 100) : 0, packs, sources: PROJECTS.filter((p) => p.system === s.id).length };
  });
  const pipeline = STAGES.map((st) => ({ stage: st, count: st === 'complete' ? ms.filter((m) => m.state === 'completed').length : live.filter((m) => m.stage === st).length }));
  const handoffs = db.all('SELECT x.id, x.mission_id, x.kind, x.sender_name, x.sender_kind, x.to_key, x.body, x.created_at, m.title AS mission_title FROM messages x JOIN missions m ON m.id=x.mission_id WHERE x.workspace_id=? ORDER BY x.created_at DESC, x.rowid DESC LIMIT 12', ws).map((x) => ({ ...x, body: String(x.body).slice(0, 220) }));
  const tasks = db.all('SELECT status, count(*) n FROM workflow_tasks WHERE workspace_id=? GROUP BY status', ws);

  return {
    generatedAt: nowIso(),
    kpis: {
      verifiedRate: finished.length ? Math.round((verified / finished.length) * 1000) / 10 : null, verified, finished: finished.length,
      checksPassedRate: evidence.length ? Math.round((evPassed / evidence.length) * 1000) / 10 : null, checks30d: evidence.length,
      active: live.length, total: ms.length, awaitingApproval: pendingAp.length,
      recovery: live.filter((m) => m.state === 'recovery_required').length + acts.filter((a) => a.status === 'execution_unknown').length,
      blocked: live.filter((m) => m.state === 'blocked').length,
    },
    trend, attention: attention.slice(0, 30), coverage, pipeline, handoffs,
    agentTasks: Object.fromEntries(tasks.map((t) => [t.status, t.n])),
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, packs: s.packs.filter((p) => e.packs.get(p)), missions: ms.filter((m) => s.packs.includes(m.pack_id)).length })),
  };
}

// ------------------------------------------------------------------ Operations Workbench
function priorityOf(m: Row, problemCount: number) {
  if (m.state === 'recovery_required' || problemCount > 0) return 'high';
  if (['blocked', 'awaiting_approval'].includes(m.state)) return 'medium';
  return 'low';
}
export function workbench(e: Engine, ws: string) {
  const db = e.db; const users = people(e, ws);
  const cases = missions(e, ws).map((m) => {
    const open = db.all("SELECT due, owner_user_id FROM work_items WHERE workspace_id=? AND mission_id=? AND analysis_rev=? AND status!='done'", ws, m.id, m.analysis_rev);
    const problems = db.get(`SELECT count(*) n FROM actions WHERE workspace_id=? AND mission_id=? AND status IN (${PROBLEM.map(() => '?').join(',')})`, ws, m.id, ...PROBLEM)?.n ?? 0;
    const due = open.map((w) => w.due).filter(Boolean).sort()[0] ?? null;
    return {
      id: m.id, ref: `CASE-${String(m.created_at).slice(0, 4)}-${m.id.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase()}`, title: m.title, pack: m.pack_id, pack_name: m.pack_name, domain: m.domain,
      system: m.system, state: m.state, state_label: m.state_label, stage: m.stage, priority: priorityOf(m, problems),
      owner: users.get(m.created_by)?.name ?? '—', assignees: [...new Set(open.map((w) => users.get(w.owner_user_id)?.name).filter(Boolean))],
      due, activity: db.get('SELECT count(*) n FROM audit_events WHERE workspace_id=? AND mission_id=?', ws, m.id)?.n ?? 0, updated_at: m.updated_at,
    };
  });
  const facet = (k: 'system' | 'state' | 'priority') => Object.entries(cases.reduce<Record<string, number>>((acc, c) => { const v = String(c[k] ?? 'none'); acc[v] = (acc[v] ?? 0) + 1; return acc; }, {})).map(([key, n]) => ({ key, n }));
  return { cases, facets: { system: facet('system'), state: facet('state'), priority: facet('priority') }, systems: SYSTEMS.map((s) => ({ id: s.id, short: s.short, workspace: s.workspace })) };
}
export function caseDetail(e: Engine, ws: string, id: string) {
  const db = e.db; const m = e.mission(ws, id); const users = people(e, ws);
  const timeline = db.all('SELECT type, actor, actor_kind, summary, created_at FROM audit_events WHERE workspace_id=? AND mission_id=? ORDER BY created_at, rowid', ws, id);
  const completion = evaluateCompletion(e, m);
  const pendingAp = db.all("SELECT id,title,approver_label,required_role FROM approvals WHERE workspace_id=? AND mission_id=? AND status='pending'", ws, id);
  const blockingQ = db.get("SELECT id,text FROM questions WHERE workspace_id=? AND mission_id=? AND status='open' AND blocking=1", ws, id);
  const approvedAct = db.get("SELECT id,title FROM actions WHERE workspace_id=? AND mission_id=? AND analysis_rev=? AND status='approved'", ws, id, m.analysis_rev);
  const next = blockingQ ? { label: `Answer: ${blockingQ.text}`, kind: 'question' }
    : pendingAp[0] ? { label: `Decide approval: ${pendingAp[0].title}`, kind: 'approval' }
    : approvedAct ? { label: `Execute approved action: ${approvedAct.title}`, kind: 'execute' }
    : completion.allPassed && m.state === 'verifying' ? { label: 'Complete the mission (all criteria met)', kind: 'complete' }
    : { label: completion.checks.find((c) => !c.passed)?.label ?? 'No action required', kind: 'info' };
  const evidence = db.all('SELECT check_name, passed, verifier, created_at FROM evidence WHERE workspace_id=? AND mission_id=? ORDER BY created_at DESC LIMIT 10', ws, id).map((x) => ({ ...x, passed: !!x.passed }));
  return { id, title: m.title, state: m.state, state_label: STATE_LABEL[m.state as keyof typeof STATE_LABEL], system: systemOfPack(m.pack_id), owner: users.get(m.created_by)?.name ?? '—', timeline, next, completion, evidence };
}

// ------------------------------------------------------------------ Trust & Evidence
/** Hash chain over the workspace audit log in insertion order: h0 = sha256(''), hn = sha256(h(n-1) + stable(row)). */
export function auditChain(e: Engine, ws: string, upto?: number) {
  const rows = e.db.all('SELECT id, mission_id, actor_kind, actor, type, summary, data, created_at FROM audit_events WHERE workspace_id=? ORDER BY rowid', ws);
  let h = sha256(''); const n = upto === undefined ? rows.length : Math.min(upto, rows.length);
  for (let i = 0; i < n; i++) h = sha256(h + stable(rows[i]));
  return { head: h, count: n, total: rows.length };
}
/** Re-computes the chain for every seal. A seal is intact only if the first `upto` events still hash to the sealed head. */
export function verifySeals(e: Engine, ws: string) {
  const seals = e.db.all('SELECT * FROM ledger_seals WHERE workspace_id=? ORDER BY created_at, rowid', ws);
  const results = seals.map((s) => {
    const c = auditChain(e, ws, s.upto);
    // Derived-value reconciliation (session 16): the seal caches how many events it covers; recompute how many of those rows
    // still exist (rows up to the seal's highest covered rowid). Events appended after the seal are normal; a positive gap
    // means covered events are missing. Seals made before this column existed have no cached rowid to compare against.
    const reconciliation = s.last_rowid == null
      ? reconcileDerived('audit events covered by this seal', null, c.count)
      : reconcileDerived('audit events covered by this seal', s.upto, (e.db.get('SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id=? AND rowid<=?', ws, s.last_rowid)?.n ?? 0));
    return { id: s.id, upto: s.upto, sealed_at: s.created_at, sealed_by: s.sealed_by, expected: s.head, recomputed: c.head, intact: c.count === s.upto && c.head === s.head, reconciliation };
  });
  return { verifiedAt: nowIso(), seals: results, intact: results.every((r) => r.intact), current: auditChain(e, ws) };
}
/** Records the current chain head (manager/owner). The seal itself is audited AFTER the head is computed, so it is covered by the next seal. */
export function sealLedger(e: Engine, a: Actor) {
  e.require(a, 'owner', 'manager');
  const ch = auditChain(e, a.workspaceId);
  // The highest covered row: rows at or below it are the events this seal covers (events appended later have higher rowids).
  const lastRowid = e.db.get('SELECT MAX(rowid) AS r FROM audit_events WHERE workspace_id=?', a.workspaceId)?.r ?? 0;
  e.db.insert('ledger_seals', { id: uid('seal'), workspace_id: a.workspaceId, upto: ch.count, head: ch.head, sealed_by: a.name, created_at: nowIso(), last_rowid: lastRowid });
  e.audit(a.workspaceId, null, 'user', a.name, 'ledger_sealed', `Audit ledger sealed at ${ch.count} event(s)`, { head: ch.head });
  return verifySeals(e, a.workspaceId);
}
function receiptOf(x: Row, users: Map<string, Row>) {
  const approval = x.approval_status ? { status: x.approval_status, decided_by: users.get(x.decided_by)?.name ?? null, decided_at: x.decided_at, note: x.decision_note } : null;
  const body = { evidence_id: x.id, mission_id: x.mission_id, action_id: x.action_id, action: x.action_title, check: x.check_name, passed: !!x.passed, verifier: x.verifier, observed_at: x.created_at, baseline_version: x.baseline_version, change_seq: x.change_seq, payload_hash: x.payload_hash, idempotency_key: x.idempotency_key, approval };
  return { ...body, mission_title: x.mission_title, detail: x.detail, receipt_hash: sha256(stable(body)) };
}
const RECEIPT_SQL = `SELECT e.*, m.title AS mission_title, a.title AS action_title, a.payload_hash, a.idempotency_key, a.baseline_version, a.change_seq,
  ap.status AS approval_status, ap.decided_by, ap.decided_at, ap.decision_note
  FROM evidence e JOIN missions m ON m.id=e.mission_id AND m.workspace_id=e.workspace_id
  LEFT JOIN actions a ON a.id=e.action_id AND a.workspace_id=e.workspace_id
  LEFT JOIN approvals ap ON ap.subject_id=e.action_id AND ap.workspace_id=e.workspace_id AND ap.status!='pending'
  WHERE e.workspace_id=?`;
export function trust(e: Engine, ws: string) {
  const db = e.db; const users = people(e, ws);
  const receipts = db.all(`${RECEIPT_SQL} ORDER BY e.created_at DESC, e.rowid DESC LIMIT 60`, ws).map((x) => receiptOf(x, users));
  const day = since(DAY);
  const decided = db.all('SELECT status, count(*) n FROM approvals WHERE workspace_id=? AND decided_at>=? GROUP BY status', ws, day);
  const ev24 = db.all('SELECT passed, count(*) n FROM evidence WHERE workspace_id=? AND created_at>=? GROUP BY passed', ws, day);
  // Separation of duties, re-checked from the ledger: a consequential action that ran must carry an approval decided by a real user,
  // and no evidence row may be signed by the proposing role (the verifier is the engine's independent re-read).
  const ran = db.all("SELECT id, title, owner_role, consequential, status FROM actions WHERE workspace_id=? AND status IN ('executed','verified','verification_failed','execution_unknown')", ws);
  const sod = ran.map((a) => {
    const ap = db.get("SELECT decided_by FROM approvals WHERE workspace_id=? AND subject_id=? AND status='approved' ORDER BY decided_at DESC", ws, a.id);
    const approver = ap?.decided_by ? users.get(ap.decided_by) : undefined;
    const verifiers = db.all('SELECT DISTINCT verifier FROM evidence WHERE workspace_id=? AND action_id=?', ws, a.id).map((v) => String(v.verifier));
    const selfVerified = verifiers.includes(a.owner_role);
    return { id: a.id, title: a.title, status: a.status, consequential: !!a.consequential, proposer: `agent:${a.owner_role}`, approver: approver?.name ?? null, verifiers, ok: (!a.consequential || !!approver) && !selfVerified };
  });
  const failures = db.all(`SELECT a.id, a.title, a.status, a.last_error, a.stale_reason, a.attempts, a.mission_id, m.title AS mission_title FROM actions a JOIN missions m ON m.id=a.mission_id WHERE a.workspace_id=? AND a.status IN (${PROBLEM.map(() => '?').join(',')}) ORDER BY a.created_at DESC LIMIT 20`, ws, ...PROBLEM);
  const passports = db.get('SELECT count(*) n FROM rw_passports WHERE workspace_id=?', ws)?.n ?? 0;
  const audit = db.all('SELECT type, actor_kind, actor, summary, created_at FROM audit_events WHERE workspace_id=? ORDER BY rowid DESC LIMIT 25', ws);
  return {
    receipts,
    outcomes24h: { granted: decided.find((d) => d.status === 'approved')?.n ?? 0, rejected: decided.find((d) => d.status === 'rejected')?.n ?? 0, checksPassed: ev24.find((d) => d.passed)?.n ?? 0, checksFailed: ev24.find((d) => !d.passed)?.n ?? 0 },
    separation: { checked: sod.length, violations: sod.filter((s) => !s.ok).length, rows: sod.slice(0, 20) },
    failures, passports, audit, chain: verifySeals(e, ws),
    connectors: db.all('SELECT key,name,mode FROM connectors WHERE workspace_id=?', ws),
  };
}
export function receipt(e: Engine, ws: string, id: string) {
  const x = e.db.get(`${RECEIPT_SQL} AND e.id=?`, ws, id);
  if (!x) throw new EngineError(404, 'not_found', 'Receipt not found.');
  return { format: 'ripple-verification-receipt/1', ...receiptOf(x, people(e, ws)), exportedAt: nowIso() };
}

// ------------------------------------------------------------------ Knowledge & Decisions
export function knowledge(e: Engine, ws: string) {
  const db = e.db; const users = people(e, ws);
  const mById = new Map(missions(e, ws).map((m) => [m.id, m]));
  const decisions = db.all("SELECT a.*, x.status AS subject_status FROM approvals a LEFT JOIN actions x ON x.id=a.subject_id AND x.workspace_id=a.workspace_id WHERE a.workspace_id=? AND a.status!='pending' ORDER BY a.decided_at DESC LIMIT 60", ws).map((a) => {
    const m = mById.get(a.mission_id);
    // A decision stays valid while the mission is still on the change it was made for and its subject was not invalidated.
    const validity = !m ? 'unknown' : ['stale', 'superseded'].includes(a.subject_status) || m.change_seq !== a.change_seq ? 'superseded' : m.state === 'completed' ? 'applied' : 'valid';
    const ev = db.get('SELECT count(*) n, sum(passed) p FROM evidence WHERE workspace_id=? AND action_id=?', ws, a.subject_id);
    return { id: a.id, kind: 'approval', title: a.title, decision: a.status, rationale: a.decision_note || a.rationale, by: users.get(a.decided_by)?.name ?? '—', by_id: a.decided_by, at: a.decided_at, mission_id: a.mission_id, mission: m?.title, system: m?.system ?? null, validity, evidence: ev?.n ?? 0, evidencePassed: ev?.p ?? 0 };
  });
  const answers = db.all("SELECT * FROM questions WHERE workspace_id=? AND status='answered' ORDER BY answered_at DESC LIMIT 40", ws).map((q) => {
    const m = mById.get(q.mission_id);
    return { id: q.id, kind: 'answer', title: q.text, decision: 'answered', rationale: q.answer, by: users.get(q.answered_by)?.name ?? '—', by_id: q.answered_by, at: q.answered_at, mission_id: q.mission_id, mission: m?.title, system: m?.system ?? null, validity: m && q.analysis_rev === m.analysis_rev ? 'valid' : 'superseded', evidence: 0, evidencePassed: 0 };
  });
  const history = [...decisions, ...answers].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // Contradictions: recorded cross-domain findings + any approved decision whose independently observed outcome disagrees.
  const cross = db.all('SELECT id, title, pattern, severity, status, explanation, recommendation, domains, detected_at FROM cd_findings WHERE workspace_id=? ORDER BY detected_at DESC LIMIT 20', ws).map((f): Row => ({ ...f, domains: j(f.domains, []), source: 'cross-domain' }));
  const broken = db.all("SELECT a.id, a.title, x.status, a.mission_id, a.decided_at FROM approvals a JOIN actions x ON x.id=a.subject_id AND x.workspace_id=a.workspace_id WHERE a.workspace_id=? AND a.status='approved' AND x.status IN ('verification_failed','execution_unknown')", ws)
    .map((b) => ({ id: b.id, title: `Approved "${b.title}" but the observed outcome is ${String(b.status).replace(/_/g, ' ')}`, pattern: 'declared_vs_observed', severity: 'high', status: 'open', explanation: 'An authorised decision and the independently observed effect disagree.', recommendation: 'Read back the effect and decide recovery in the mission.', domains: [mById.get(b.mission_id)?.domain], detected_at: b.decided_at, source: 'ledger', mission_id: b.mission_id }));
  const outdated = [
    ...db.all("SELECT id, title, stale_reason AS reason, mission_id, created_at FROM actions WHERE workspace_id=? AND status='stale' ORDER BY created_at DESC LIMIT 20", ws).map((x): Row => ({ ...x, kind: 'action' })),
    ...db.all('SELECT r.id, r.name AS title, r.status AS reason, r.mission_id, r.created_at FROM artifacts r JOIN missions m ON m.id=r.mission_id AND m.workspace_id=r.workspace_id WHERE r.workspace_id=? AND r.analysis_rev IS NOT NULL AND r.analysis_rev < m.analysis_rev ORDER BY r.created_at DESC LIMIT 20', ws).map((x): Row => ({ ...x, kind: 'artifact', reason: `Generated in an earlier analysis revision (${x.reason})` })),
  ].map((x): Row => ({ ...x, mission: mById.get(x.mission_id)?.title }));
  const commitments = db.all("SELECT id, title, type, connector, status, owner_user_id, mission_id, executed_at, created_at FROM actions WHERE workspace_id=? AND (connector LIKE '%email%' OR connector LIKE '%outbox%' OR type LIKE '%client%' OR type LIKE '%message%') AND status!='superseded' ORDER BY created_at DESC LIMIT 30", ws)
    .map((a) => ({ ...a, owner: users.get(a.owner_user_id)?.name ?? '—', mission: mById.get(a.mission_id)?.title, proven: a.status === 'verified' }));
  const today = new Date().toISOString().slice(0, 10);
  const responsibility = [...users.values()].filter((u) => u.role !== 'viewer').map((u) => {
    const open = db.all("SELECT w.due FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.workspace_id=? AND w.owner_user_id=? AND w.status!='done' AND w.analysis_rev=m.analysis_rev AND m.state NOT IN ('completed','cancelled')", ws, u.id);
    return { id: u.id, name: u.name, title: u.title, open: open.length, overdue: open.filter((w) => w.due && String(w.due).slice(0, 10) < today).length, approvalsWaiting: db.get("SELECT count(*) n FROM approvals WHERE workspace_id=? AND approver_user_id=? AND status='pending'", ws, u.id)?.n ?? 0, decisions: history.filter((h) => h.by_id === u.id).length };
  });
  // Knowledge graph: people → decisions → missions (bounded so it stays readable).
  const nodes = new Map<string, { id: string; type: string; label: string; tone?: string }>();
  const edges: { from: string; to: string; rel: string }[] = [];
  for (const h of history.slice(0, 24)) {
    if (h.by_id) nodes.set(`u:${h.by_id}`, { id: `u:${h.by_id}`, type: 'person', label: h.by });
    nodes.set(`d:${h.id}`, { id: `d:${h.id}`, type: 'decision', label: String(h.title).slice(0, 42), tone: h.validity });
    nodes.set(`m:${h.mission_id}`, { id: `m:${h.mission_id}`, type: 'mission', label: String(h.mission ?? '').slice(0, 36) });
    if (h.by_id) edges.push({ from: `u:${h.by_id}`, to: `d:${h.id}`, rel: 'decided' });
    edges.push({ from: `d:${h.id}`, to: `m:${h.mission_id}`, rel: 'governs' });
  }
  const contradictions = [...broken, ...cross];
  const health = { decisions: history.length, valid: history.filter((h) => h.validity === 'valid' || h.validity === 'applied').length, superseded: history.filter((h) => h.validity === 'superseded').length, outdated: outdated.length, contradictionsOpen: contradictions.filter((c) => c.status !== 'resolved').length };
  return { history, contradictions, outdated, commitments, responsibility, graph: { nodes: [...nodes.values()], edges }, health, briefing: briefing(e, ws) };
}

/** Deterministic operational briefing assembled only from recorded state. */
export function briefing(e: Engine, ws: string) {
  const mc = missionControl(e, ws);
  const lines: string[] = [];
  lines.push(`${mc.kpis.active} active mission(s) across ${mc.coverage.filter((c) => c.active).length} capability system(s); ${mc.kpis.total} in total.`);
  lines.push(mc.kpis.verifiedRate !== null ? `${mc.kpis.verified} of ${mc.kpis.finished} executed action(s) independently verified (${mc.kpis.verifiedRate}%).` : 'No action has been executed yet, so there is no verification rate.');
  const crit = mc.attention.filter((a) => a.priority === 'critical');
  if (crit.length) lines.push(`Critical: ${crit.slice(0, 3).map((a) => `${a.title} (${a.detail})`).join('; ')}.`);
  if (mc.kpis.awaitingApproval) lines.push(`${mc.kpis.awaitingApproval} approval(s) waiting for a human decision.`);
  if (mc.kpis.blocked) lines.push(`${mc.kpis.blocked} mission(s) blocked on missing information.`);
  if (!crit.length && !mc.kpis.awaitingApproval && !mc.kpis.blocked) lines.push('Nothing needs a human right now.');
  return { generatedAt: mc.generatedAt, generator: 'deterministic', lines };
}

export function capabilities(e: Engine, ws: string) {
  const ms = missions(e, ws);
  return {
    totals: { projects: PROJECTS.length, systems: SYSTEMS.length, dashboards: 4, packs: e.packs.all().length, pending: PROJECTS.filter((p) => p.integration === 'pending').length, packBacked: PROJECTS.filter((p) => p.integration === 'pack-backed').length, withSource: PROJECTS.filter((p) => p.folder).length },
    systems: SYSTEMS.map((s) => ({ ...s, projects: PROJECTS.filter((p) => p.system === s.id), packs: e.packs.all().filter((p) => PACK_SYSTEM[p.id] === s.id).map((p) => ({ id: p.id, name: p.name, domain: p.domain, missions: ms.filter((m) => m.pack_id === p.id).length })) })),
    scenarios: SCENARIOS.map((s) => ({ ...s, packs: s.packs.filter((p) => e.packs.get(p)), live: ms.filter((m) => s.packs.includes(m.pack_id)).map((m) => ({ id: m.id, title: m.title, stage: m.stage, state: m.state })) })),
  };
}

/** Live counts for the "How it works" page: every stage of the shared pipeline, measured from recorded rows. */
export function howItWorks(e: Engine, ws: string) {
  const db = e.db; const n = (sql: string, ...p: unknown[]) => Number(db.get(sql, ws, ...p)?.n ?? 0);
  const lastInvariant = db.get("SELECT e.check_name, e.detail, e.passed, e.created_at, m.title AS mission_title, e.mission_id FROM evidence e JOIN missions m ON m.id=e.mission_id AND m.workspace_id=e.workspace_id WHERE e.workspace_id=? AND e.check_name LIKE 'business invariant%' ORDER BY e.created_at DESC, e.rowid DESC", ws);
  return {
    connectors: db.all('SELECT key,name,mode FROM connectors WHERE workspace_id=? ORDER BY key', ws).map((c) => ({ ...c, description: e.connectors[c.key]?.description ?? '' })),
    collab: e.collab.describe(), provider: { name: e.provider.name, kind: e.provider.kind },
    stages: {
      changes: n('SELECT count(*) n FROM change_events WHERE workspace_id=?'),
      chatMessages: n("SELECT count(*) n FROM messages WHERE workspace_id=? AND sender_kind='human'") + n("SELECT count(*) n FROM console_messages WHERE workspace_id=? AND author!='ripple'"),
      graphNodes: n('SELECT count(*) n FROM graph_nodes WHERE workspace_id=?'),
      analyzerRuns: n('SELECT count(*) n FROM agent_runs WHERE workspace_id=?'),
      analyzers: db.all('SELECT DISTINCT json_extract(output, \'$.analyzer\') a FROM agent_runs WHERE workspace_id=? LIMIT 40', ws).map((r) => r.a).filter(Boolean).length,
      questionsOpen: n("SELECT count(*) n FROM questions WHERE workspace_id=? AND status='open'"),
      approvalsPending: n("SELECT count(*) n FROM approvals WHERE workspace_id=? AND status='pending'"),
      approvalsDecided: n("SELECT count(*) n FROM approvals WHERE workspace_id=? AND status IN ('approved','rejected')"),
      executed: n("SELECT count(*) n FROM actions WHERE workspace_id=? AND status IN ('executed','verified','verification_failed')"),
      unknown: n("SELECT count(*) n FROM actions WHERE workspace_id=? AND status='execution_unknown'"),
      recoveredByReadBack: n("SELECT count(*) n FROM actions WHERE workspace_id=? AND json_extract(result, '$.recoveredBy')='read-back'"),
      verified: n("SELECT count(*) n FROM actions WHERE workspace_id=? AND status='verified'"),
      checksPassed: n('SELECT count(*) n FROM evidence WHERE workspace_id=? AND passed=1'),
      checksFailed: n('SELECT count(*) n FROM evidence WHERE workspace_id=? AND passed=0'),
      auditEvents: n('SELECT count(*) n FROM audit_events WHERE workspace_id=?'),
    },
    lastInvariant: lastInvariant ? { ...lastInvariant, passed: !!lastInvariant.passed } : null,
  };
}

export function registerDashboardRoutes(app: Hono<Env>, engine: Engine) {
  const A = (c: Context<Env>) => c.get('actor');
  app.get('/api/dash/how', (c) => c.json(howItWorks(engine, A(c).workspaceId)));
  app.get('/api/dash/mission-control', (c) => c.json(missionControl(engine, A(c).workspaceId)));
  app.get('/api/dash/workbench', (c) => c.json(workbench(engine, A(c).workspaceId)));
  app.get('/api/dash/workbench/:id', (c) => c.json(caseDetail(engine, A(c).workspaceId, c.req.param('id') as string)));
  app.get('/api/dash/trust', (c) => c.json(trust(engine, A(c).workspaceId)));
  app.get('/api/dash/trust/receipts/:id', (c) => { const r = receipt(engine, A(c).workspaceId, c.req.param('id') as string); c.header('Content-Disposition', `attachment; filename="receipt-${r.evidence_id}.json"`); return c.json(r); });
  app.post('/api/dash/trust/verify', (c) => c.json(verifySeals(engine, A(c).workspaceId)));
  app.post('/api/dash/trust/seal', (c) => c.json(sealLedger(engine, A(c))));
  app.get('/api/dash/knowledge', (c) => c.json(knowledge(engine, A(c).workspaceId)));
  app.get('/api/dash/briefing', (c) => c.json(briefing(engine, A(c).workspaceId)));
  app.get('/api/capabilities', (c) => c.json(capabilities(engine, A(c).workspaceId)));
}
