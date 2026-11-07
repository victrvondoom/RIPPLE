// Mission Orchestrator — pure coordination rules shared by every workflow pack.
// The engine (engine.ts) persists tasks and writes state; this module decides WHAT must run and whether a
// result is acceptable. It contains no pack-specific logic: packs declare inputs (`roleInputs`) and dependencies
// (`roleDeps`); everything else is generic.
import { z } from 'zod';
import { sha256, stable } from '../db/db.js';
import type { AnalysisContext, RoleResult, WorkflowPack } from './types.js';

/** Bounded loop: at most this many passes over the role graph per analysis revision. */
export const MAX_PASSES = 3;
/** A task still `running` after this long is treated as timed out (agent timeout recovery). */
export const TASK_TIMEOUT_MS = 120_000;
export const ORCHESTRATOR = 'ripple-orchestrator';

export type TaskStatus = 'queued' | 'running' | 'done' | 'reused' | 'failed' | 'interrupted' | 'timed_out' | 'cancelled' | 'rejected';

/** Roles a role depends on: explicit `roleDeps`, otherwise every earlier role in `roleOrder`. */
export function depsOf(pack: WorkflowPack, roleKey: string): string[] {
  if (pack.roleDeps?.[roleKey]) return pack.roleDeps[roleKey];
  const i = pack.roleOrder.indexOf(roleKey);
  return i <= 0 ? [] : pack.roleOrder.slice(0, i);
}

/**
 * Fingerprint of everything a role's output depends on: its declared inputs plus a digest of the outputs of the
 * roles it depends on. Equal fingerprint => the previous result is still valid and the role is not re-run.
 */
export function roleFingerprint(pack: WorkflowPack, roleKey: string, ctx: AnalysisContext): string {
  const inputs = pack.roleInputs
    ? pack.roleInputs(roleKey, ctx)
    : { change: ctx.change, items: ctx.items, answers: ctx.answers, revisedPlan: ctx.revisedPlan };
  const deps = depsOf(pack, roleKey).map((d) => [d, ctx.results[d] ? sha256(stable(ctx.results[d])) : null]);
  return sha256(stable({ role: roleKey, inputs, deps }));
}

const RoleRequestSchema = z.object({ roleKey: z.string().min(1).max(60), reason: z.string().min(1).max(500) });
const ResultSchema = z.object({
  roleKey: z.string().min(1),
  summary: z.string().min(1).max(2000),
  findings: z.array(z.object({ severity: z.enum(['info', 'warning', 'risk']), text: z.string(), needsHumanReview: z.boolean().optional() })),
  questions: z.array(z.object({ key: z.string().min(1), text: z.string().min(1), blocking: z.boolean(), assigneeRole: z.string().min(1), assigneeOnly: z.boolean().optional() })),
  workItems: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), roleKey: z.string().min(1) }).passthrough()),
  drafts: z.array(z.object({ kind: z.string().min(1), name: z.string().min(1), content: z.string(), ownerRole: z.string().min(1) }).passthrough()),
  actions: z.array(z.object({ key: z.string().min(1), type: z.string().min(1), draftKind: z.string().min(1), effectKey: z.string().min(1) }).passthrough()),
  analyzer: z.string().min(1),
  requests: z.array(RoleRequestSchema).optional(),
});

/**
 * Validates an agent's structured output before it may touch mission state. Malformed or unrelated output is
 * rejected (returns an error string); nothing is persisted from a rejected result.
 */
export function validateRoleResult(pack: WorkflowPack, expectedRole: string, raw: unknown): { ok: true; result: RoleResult } | { ok: false; error: string } {
  const parsed = ResultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'output schema: ' + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ') };
  const r = raw as RoleResult;
  if (r.roleKey !== expectedRole) return { ok: false, error: `output belongs to role "${r.roleKey}", not "${expectedRole}"` };
  const roles = new Set(pack.roles.map((x) => x.key));
  for (const req of r.requests ?? []) {
    if (!roles.has(req.roleKey)) return { ok: false, error: `request targets unknown role "${req.roleKey}"` };
    if (req.roleKey === expectedRole) return { ok: false, error: 'a role may not request its own re-analysis' };
  }
  for (const w of r.workItems) if (!roles.has(w.roleKey)) return { ok: false, error: `work item "${w.key}" assigned to unknown role "${w.roleKey}"` };
  for (const h of r.handoffs ?? []) if (!roles.has(h.to) || h.to === expectedRole) return { ok: false, error: `handoff targets ${h.to === expectedRole ? 'its own role' : `unknown role "${h.to}"`}` };
  const kinds = new Set<string>();
  for (const d of r.drafts) { if (kinds.has(d.kind)) return { ok: false, error: `duplicate draft kind "${d.kind}"` }; kinds.add(d.kind); }
  // Per-role tool scope (session 16, from OpsRoom's read-only Sentinel vs the investigator that holds the fix): a read-only role
  // may analyse and report, but may not propose actions. Its output is discarded, so no action can enter the ledger from it.
  const scope = pack.roles.find((x) => x.key === expectedRole)?.scope ?? 'act';
  if (scope === 'read' && (r.actions ?? []).length > 0) return { ok: false, error: `role "${expectedRole}" is read-only and proposed ${r.actions.length} action(s); it may analyse and report, not act` };
  return { ok: true, result: r };
}
