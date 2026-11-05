import type { Engine } from './engine.js';
import type { CompletionCheck } from './types.js';
import type { Row } from '../db/db.js';

/** Generic completion criteria shared by every workflow pack. A mission completes ONLY when all pass. */
export function evaluateCompletion(e: Engine, m: Row): { allPassed: boolean; checks: CompletionCheck[]; unresolved: string[] } {
  const ws = m.workspace_id; const db = e.db;
  const checks: CompletionCheck[] = [];
  const unresolved: string[] = [];
  checks.push({ key: 'state', label: 'Mission is in verifying state', passed: m.state === 'verifying' || m.state === 'completed', detail: `State is ${m.state}.` });
  const blocking = db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND blocking=1 AND status='open'", m.id, ws);
  checks.push({ key: 'blocking_questions', label: 'No blocking questions open', passed: !blocking.length, detail: blocking.length ? blocking.map((q) => q.text).join(' | ') : 'All blocking questions answered.' });
  const pend = db.all("SELECT * FROM approvals WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status='pending'", m.id, ws, m.analysis_rev);
  checks.push({ key: 'approvals', label: 'All required approvals decided', passed: !pend.length, detail: pend.length ? `${pend.length} pending` : 'All current approvals decided.' });
  const acts = db.all("SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status NOT IN ('superseded')", m.id, ws, m.analysis_rev);
  const notVerified = acts.filter((x) => !['verified', 'rejected'].includes(x.status));
  checks.push({ key: 'actions_verified', label: 'Every approved action is executed and independently verified', passed: !notVerified.length && acts.some((x) => x.status === 'verified'), detail: notVerified.length ? notVerified.map((x) => `${x.title} (${x.status})`).join(', ') : acts.some((x) => x.status === 'verified') ? `${acts.filter((x) => x.status === 'verified').length} verified` : 'Nothing has been verified yet.' });
  const bad = acts.filter((x) => ['failed', 'verification_failed', 'execution_unknown', 'stale'].includes(x.status));
  checks.push({ key: 'no_failed_or_stale', label: 'No failed or stale actions', passed: !bad.length, detail: bad.length ? bad.map((x) => `${x.title} (${x.status})`).join(', ') : 'None.' });
  const verifiedActs = acts.filter((x) => x.status === 'verified');
  const pendingAcks = verifiedActs.flatMap((x) => db.all("SELECT u.name, ? AS title FROM acknowledgements k JOIN users u ON u.id=k.user_id WHERE k.action_id=? AND k.status='pending'", x.title, x.id));
  checks.push({ key: 'acks', label: 'Required acknowledgements received', passed: !pendingAcks.length, detail: pendingAcks.length ? pendingAcks.map((p) => `${p.name} for "${p.title}"`).join(', ') : 'All recipients acknowledged.' });
  const reviews = db.all("SELECT * FROM work_items WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND kind='review' AND status!='done'", m.id, ws, m.analysis_rev);
  checks.push({ key: 'reviews', label: 'Qualified human reviews completed', passed: !reviews.length, detail: reviews.length ? reviews.map((r) => r.title).join(' | ') : 'All review items done.' });
  const pack = e.packs.get(m.pack_id);
  const change = db.get("SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? AND status IN ('open','applied') ORDER BY seq DESC", m.id, ws);
  if (pack?.completionChecks && change && m.current_baseline_version > 0) {
    const answers: Record<string, { text: string; value?: any }> = {};
    for (const q of db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND status='answered'", m.id, ws)) answers[q.key] = { text: q.answer, value: q.answer_value ? JSON.parse(q.answer_value) : undefined };
    const bl = db.get('SELECT plan FROM baselines WHERE mission_id=? AND workspace_id=? AND version=?', m.id, ws, change.baseline_version);
    const baselinePlan = JSON.parse(bl!.plan); const input = JSON.parse(change.input);
    checks.push(...pack.completionChecks({ baselinePlan, revisedPlan: pack.applyChange(baselinePlan, input, answers), change: input, answers, today: input.receivedOn ?? change.created_at.slice(0, 10) }));
  }
  for (const q of db.all("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND blocking=0 AND status='open'", m.id, ws)) unresolved.push(`Open question: ${q.text}`);
  for (const w of db.all("SELECT * FROM work_items WHERE mission_id=? AND workspace_id=? AND analysis_rev=? AND status!='done'", m.id, ws, m.analysis_rev)) unresolved.push(`Outstanding ${w.kind}: ${w.title} (${w.department})`);
  for (const x of acts.filter((y) => y.status === 'rejected')) unresolved.push(`Waived (rejected) action: ${x.title}`);
  return { allPassed: checks.every((c) => c.passed), checks, unresolved };
}
