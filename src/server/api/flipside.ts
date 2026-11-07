import type { Hono, Context } from 'hono';
import type { Engine, Actor } from '../engine/engine.js';
import { EngineError } from '../engine/types.js';
import { j } from '../db/db.js';
import { createHash } from 'node:crypto';
import { parseDisclosure, proofResult } from '../packs/flipside/pack.js';

type Env = { Variables: { actor: Actor } };
const PACK = 'flipside-review';

/**
 * Read model for the Flipside review page. Every value is recomputed from stored rows (baseline seal, stored disclosure, approvals,
 * evidence). Only the one disclosed step's text is returned; the other steps exist here only as public leaf hashes (commitments).
 */
export function flipsideView(e: Engine, ws: string, id: string, viewerId?: string) {
  const m = e.mission(ws, id);
  if (m.pack_id !== PACK) throw new EngineError(404, 'not_found', 'Not a Flipside review mission.');
  const db = e.db;
  const bl = db.get('SELECT * FROM baselines WHERE mission_id=? AND workspace_id=? ORDER BY version DESC', id, ws);
  if (!bl) return { missionId: id, title: m.title, state: m.state, sealed: false, stages: [], tree: null };
  const plan = j(bl.plan); const ch = db.get('SELECT * FROM change_events WHERE mission_id=? AND workspace_id=? ORDER BY seq DESC', id, ws);
  const change = ch ? j(ch.input) : null;
  const users = new Map(db.all('SELECT id,name FROM users WHERE workspace_id=?', ws).map((u) => [u.id, u.name as string]));
  const nameOf = (email: string) => db.get('SELECT name FROM users WHERE workspace_id=? AND email=?', ws, email)?.name ?? email;
  const q = db.get("SELECT * FROM questions WHERE mission_id=? AND workspace_id=? AND key='why_change' ORDER BY created_at DESC", id, ws);
  const action = db.get("SELECT * FROM actions WHERE mission_id=? AND workspace_id=? AND key='act-disclose-step' AND status NOT IN ('stale','superseded') ORDER BY created_at DESC", id, ws);
  const approval = action ? db.get('SELECT * FROM approvals WHERE subject_id=? AND workspace_id=? ORDER BY created_at DESC', action.id, ws) : undefined;
  const art = (kind: string) => db.get("SELECT * FROM artifacts WHERE mission_id=? AND workspace_id=? AND kind=? AND status IN ('draft','provisional','final') ORDER BY created_at DESC", id, ws, kind);
  const disclosureArt = art('disclosure'); const brief = art('review_brief');
  const d = disclosureArt ? parseDisclosure(disclosureArt.content) : undefined;
  const proof = d ? proofResult(plan, d) : undefined;
  const forged = change?.forgedCopy ? proofResult(plan, change.forgedCopy) : undefined;
  const verified = action?.status === 'verified';
  const leaves: string[] = plan.seal.leafHashes;
  // Public tree levels (hashes only). The disclosed path is marked only for a step that has passed the proof check.
  const levels: string[][] = [leaves];
  { let lv = leaves; while (lv.length > 1) { const nx: string[] = []; for (let i = 0; i < lv.length; i += 2) nx.push(createHash('sha256').update(Buffer.from([1])).update(lv[i] + (lv[i + 1] ?? lv[i])).digest('hex')); levels.push(nx); lv = nx; } }
  const pathIdx: number[] = []; if (d && proof?.verdict === 'OK') { let i = d.index; for (let l = 0; l < levels.length; l++) { pathIdx.push(i); i = Math.floor(i / 2); } }
  const step = (key: string, label: string, done: boolean, detail: string) => ({ key, label, done, detail });
  const stages = [
    step('seal', 'Seal', true, `${plan.seal.leafCount} steps · root ${plan.seal.root.slice(0, 8)}`),
    step('question', 'Question', !!q, q ? 'Q1 asked of the author' : 'no gap found'),
    step('answer', 'Answer', q?.status === 'answered', q?.status === 'answered' ? `answered by ${users.get(q.answered_by) ?? 'the author'}` : 'waiting for the author'),
    step('refuse', 'Refuse', !!change?.wholeSessionRequested, change?.wholeSessionRequested ? 'whole session refused' : 'not requested'),
    step('approve', 'Approve', approval?.status === 'approved', approval ? `${approval.status}${approval.approver_label ? ` · ${approval.approver_label}` : ''}` : 'not proposed'),
    step('proof', 'Proof', verified && proof?.verdict === 'OK', verified ? `${proof?.verdict}: ${proof?.reason}` : 'not delivered'),
    step('forgery', 'Forgery', !!forged && forged.verdict === 'PROOF_FAIL', forged ? `edited copy: ${forged.verdict}` : 'no copy posted'),
    step('brief', 'Brief', verified && !!brief, verified && brief ? 'issued' : 'waiting'),
  ];
  const firstOpen = stages.findIndex((s) => !s.done);
  return {
    missionId: id, title: m.title, state: m.state, sealed: true,
    pr: { repo: plan.pr.repo, number: plan.pr.number, title: plan.pr.title, files: plan.pr.files },
    author: nameOf(plan.authorEmail), reviewer: nameOf(plan.reviewerEmail),
    seal: { root: plan.seal.root, leafCount: plan.seal.leafCount, commit: plan.seal.commit, sealedAt: plan.seal.sealedAt },
    stages: stages.map((s, i) => ({ ...s, status: s.done ? 'done' : i === firstOpen ? 'current' : 'pending' })),
    tree: { levels, disclosedIndex: d?.index ?? null, shared: verified, pathIndexes: pathIdx, forgedIndex: forged ? change.forgedCopy.index : null },
    disclosed: d && verified ? { index: d.index, text: d.content, verdict: proof!.verdict } : null,
    proposed: d && !verified ? { index: d.index, verdict: proof!.verdict } : null,
    forged: forged ? { index: change.forgedCopy.index, text: change.forgedCopy.content, verdict: forged.verdict, reason: forged.reason } : null,
    notShown: d ? plan.seal.leafCount - 1 : null,
    wholeSessionRefused: !!change?.wholeSessionRequested,
    answer: q?.status === 'answered' ? q.answer : null,
    next: verified ? { kind: 'done' } : action?.status === 'approved' ? { kind: 'deliver', actionId: action.id } : approval?.status === 'pending' ? { kind: 'approve', approvalId: approval.id } : q?.status === 'open' ? { kind: 'answer', questionId: q.id } : { kind: 'none' },
    viewer: { isAuthor: !!viewerId && (q?.assignee_user_id === viewerId || approval?.approver_user_id === viewerId) },
    limits: 'The seal proves a step is in the session sealed before review. It does not prove the step is correct or that the change is safe. The sample session is a synthetic fixture and delivery is a local dry-run outbox.',
  };
}

export function registerFlipsideRoutes(app: Hono<Env>, e: Engine) {
  const A = (c: Context<Env>) => c.get('actor');
  app.get('/api/flipside', (c) => c.json({ missions: e.db.all('SELECT id,title,state,created_at FROM missions WHERE workspace_id=? AND pack_id=? ORDER BY created_at DESC', A(c).workspaceId, PACK) }));
  app.get('/api/flipside/:id', (c) => c.json(flipsideView(e, A(c).workspaceId, c.req.param('id') as string, A(c).id)));
}
