import type { Actor, Engine } from '../engine/engine.js';
import type { WorkflowPack } from '../engine/types.js';

/**
 * Demo activity (session 20). A fresh workspace has no missions, so every dashboard shows zeros. This driver fills a
 * workspace with REAL engine activity built from each pack's labelled sample: no row is inserted directly; every step
 * goes through the same Engine methods a person uses (create, baseline, change, answer, approve, execute, independent
 * verification, acknowledgement, review, completion). For each pack:
 *   - one mission is driven as far as the rules allow (usually to "completed", with verified evidence);
 *   - one mission is left at its first human stop (a blocking question or a pending approval), so the queues have work.
 * Titles carry "[demo]" and the source is "demo-activity". Questions are answered by the person they are assigned to;
 * approvals are decided by their bound approver (or a manager/owner when none is bound). A step the rules refuse is
 * skipped and recorded in the returned log, never forced.
 */
export interface DemoLog { pack: string; missionId: string; mode: 'complete' | 'first-stop'; state: string; steps: string[] }

/** Picks an answer the pack accepts, using its own parser. Options written in the question ("(yes/no)") come first. */
function answerFor(pack: WorkflowPack, key: string, text: string, plan: unknown): string {
  const declared = (pack.sample() as { answers?: Record<string, string> }).answers;
  const fromSample = declared && Object.entries(declared).find(([k]) => key.startsWith(k))?.[1];
  const options = [...text.matchAll(/\(([a-z /|-]+)\)/gi)].flatMap((m) => m[1].split(/[/|]/).map((s) => s.trim())).filter((s) => s && s.length < 20);
  const candidates = [fromSample, ...options, 'yes', 'approve', 'in scope', '18', '5', '83', '0.03', 'ledger', 'Ben', 'Leo', 'Tess', 'promo_discount_cents', 'switch off the checkout-v2 feature flag'].filter((x): x is string => !!x);
  for (const c of candidates) { const r = pack.parseAnswer?.(key, c, plan); if (!pack.parseAnswer || (r && !r.error)) return c; }
  return 'Confirmed for the demo walkthrough: the change is expected and the requester asked for it.';
}

export async function seedDemoActivity(engine: Engine, workspaceId: string, opts: { packs?: string[]; firstStopCopies?: boolean } = {}): Promise<DemoLog[]> {
  const db = engine.db;
  const actorOf = (userId: string): Actor => { const u = db.get('SELECT * FROM users WHERE id=? AND workspace_id=?', userId, workspaceId)!; return { id: u.id, name: u.name, role: u.role, workspaceId }; };
  const managers = db.all("SELECT id FROM users WHERE workspace_id=? AND role IN ('manager','owner') ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, email", workspaceId).map((u) => actorOf(u.id));
  const owner = db.all("SELECT id FROM users WHERE workspace_id=? AND role='owner'", workspaceId).map((u) => actorOf(u.id))[0] ?? managers[0];
  if (!managers.length) return [];
  const lead = managers[0];
  const logs: DemoLog[] = [];
  const packs = engine.packs.all().filter((p) => !opts.packs || opts.packs.includes(p.id));

  for (const pack of packs) {
    for (const mode of (opts.firstStopCopies === false ? ['complete'] : ['complete', 'first-stop']) as DemoLog['mode'][]) {
      const steps: string[] = []; let missionId = '';
      try {
        const s = pack.sample();
        const m = await engine.createMission(lead, { packId: pack.id, title: `${s.title} [demo]`, plan: s.plan, source: 'demo-activity' });
        missionId = m.id;
        engine.approveBaseline(lead, m.id, 'Demo baseline from labelled sample data');
        await engine.submitChange(lead, m.id, s.change, 'demo-activity');
        steps.push('analysed');
        if (mode === 'complete') await drive(engine, pack, m.id, workspaceId, actorOf, managers, owner, steps);
      } catch (e) { steps.push(`stopped: ${String((e as Error).message).slice(0, 120)}`); }
      const state = missionId ? (db.get('SELECT state FROM missions WHERE id=?', missionId)?.state ?? 'unknown') : 'not created';
      logs.push({ pack: pack.id, missionId, mode, state, steps });
    }
  }
  engine.audit(workspaceId, null, 'system', 'demo-activity', 'demo_activity_seeded', `Demo activity: ${logs.length} labelled missions across ${packs.length} packs (${logs.filter((l) => l.state === 'completed').length} completed).`, { logs: logs.map((l) => ({ pack: l.pack, mode: l.mode, state: l.state })) });
  return logs;
}

async function drive(engine: Engine, pack: WorkflowPack, id: string, ws: string, actorOf: (u: string) => Actor, managers: Actor[], owner: Actor, steps: string[]) {
  const db = engine.db;
  const tryAs = async (who: Actor[], fn: (a: Actor) => Promise<unknown> | unknown): Promise<boolean> => {
    for (const a of who) { try { await fn(a); return true; } catch { /* the rules refused this person; try the next */ } }
    return false;
  };
  for (let round = 0; round < 10; round++) {
    let progressed = false;
    const plan = JSON.parse(db.get('SELECT plan FROM baselines WHERE mission_id=? ORDER BY version DESC LIMIT 1', id)?.plan ?? 'null');
    for (const q of db.all("SELECT * FROM questions WHERE mission_id=? AND status='open'", id)) {
      const who = [q.assignee_user_id ? actorOf(q.assignee_user_id) : null, ...managers].filter((x): x is Actor => !!x);
      if (await tryAs(who, (a) => engine.answerQuestion(a, id, q.id, answerFor(pack, q.key, q.text, plan)))) { steps.push(`answered ${q.key}`); progressed = true; }
    }
    for (const ap of db.all("SELECT * FROM approvals WHERE mission_id=? AND status='pending'", id)) {
      const who = [ap.approver_user_id ? actorOf(ap.approver_user_id) : null, ...(ap.required_role === 'owner' ? [owner] : managers)].filter((x): x is Actor => !!x);
      if (await tryAs(who, (a) => engine.decideApproval(a, id, ap.id, 'approved', 'Approved in the demo walkthrough after reading the draft.'))) { steps.push(`approved ${ap.title.slice(0, 40)}`); progressed = true; }
    }
    for (const act of db.all("SELECT * FROM actions WHERE mission_id=? AND status='approved'", id)) {
      if (await tryAs(managers, (a) => engine.executeAction(a, id, act.id))) { steps.push(`executed ${act.key}`); progressed = true; }
    }
    for (const k of db.all("SELECT k.* FROM acknowledgements k JOIN actions a ON a.id=k.action_id WHERE k.mission_id=? AND k.status='pending' AND a.status='verified'", id)) {
      if (await tryAs([actorOf(k.user_id)], (a) => engine.acknowledge(a, id, k.action_id, 'Acknowledged in the demo walkthrough.'))) progressed = true;
    }
    for (const w of db.all("SELECT * FROM work_items WHERE mission_id=? AND status!='done' AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?)", id, id)) {
      const who = [w.owner_user_id ? actorOf(w.owner_user_id) : null, ...managers].filter((x): x is Actor => !!x);
      if (await tryAs(who, (a) => engine.updateWorkItem(a, id, w.id, 'done'))) progressed = true;
    }
    const m = db.get('SELECT state FROM missions WHERE id=?', id) ?? { state: 'unknown' };
    if (m.state === 'verifying' && await tryAs([...managers, owner], (a) => engine.completeMission(a, id))) { steps.push('completed'); return; }
    if (m.state === 'completed' || m.state === 'failed' || m.state === 'cancelled') return;
    if (!progressed) return;
  }
  void ws;
}
