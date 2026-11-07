import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

/**
 * Deploy gate: block only NEW critical CVEs (session 16; inherited from Shipyard's deploy gate, which compares a candidate's
 * SBOM and CVE findings against the last deployed release). Pure and offline: the SBOM and the CVE list are supplied by the team
 * in the change, RIPPLE never scans anything. A missing SBOM or scan is "unverified", never "clear".
 *  - clear:      no critical CVE in the candidate that is absent from the deployed release. A dry-run deploy request is proposed.
 *  - blocked:    at least one new critical CVE. No deploy is proposed unless the owner (and only the owner) overrides the block.
 *  - unverified: the SBOM or the scan result was not supplied. Nothing is proposed.
 * The dry-run deploy request states that nothing was deployed and that the gate is not a security certification.
 */
const cve = z.object({ id: z.string().min(3), package: z.string().min(1), severity: z.enum(['critical', 'high', 'medium', 'low']), fixedIn: z.string().optional() });
export const planSchema = z.object({
  service: z.object({ name: z.string().min(1), environment: z.string().min(1), deployedVersion: z.string().min(1) }),
  deployedCves: z.array(cve).default([]),   // the CVE list recorded for the release running now (supplied by the team)
  approver: z.string().email(),             // the person who approves a clear deploy request (a manager's email)
  owner: z.string().email(),                // the only person who may override a blocked gate
});
export const changeSchema = z.object({
  candidateVersion: z.string().min(1),
  sbomSupplied: z.boolean(),
  sbomPackages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })).default([]),
  scanRecorded: z.boolean(),                // a CVE scan result was supplied for this candidate
  candidateCves: z.array(cve).default([]),
  note: z.string().default(''),
});
type Plan = z.infer<typeof planSchema>;
type Change = z.infer<typeof changeSchema>;
type Cve = z.infer<typeof cve>;

export interface GateResult { verdict: 'clear' | 'blocked' | 'unverified'; newCritical: Cve[]; overridden: boolean; reason: string }
/** Pure gate decision. Used by the analyzer AND recomputed by the verifier and completion check. */
export function gate(plan: Plan, change: Change, answers: AnalysisContext['answers'] = {}): GateResult {
  if (!change.sbomSupplied || !change.scanRecorded) {
    return { verdict: 'unverified', newCritical: [], overridden: false, reason: 'The SBOM and a CVE scan result must be supplied for this candidate. RIPPLE does not scan, so nothing can be cleared without them.' };
  }
  const known = new Set(plan.deployedCves.map((c) => `${c.id}|${c.package}`));
  const newCritical = change.candidateCves.filter((c) => c.severity === 'critical' && !known.has(`${c.id}|${c.package}`));
  if (newCritical.length === 0) return { verdict: 'clear', newCritical, overridden: false, reason: 'No critical CVE in the candidate is absent from the deployed release.' };
  const overridden = answers.owner_override?.value === 'yes';
  return { verdict: 'blocked', newCritical, overridden, reason: `${newCritical.length} new critical CVE(s) compared with the deployed release.${overridden ? ' The owner overrode the block.' : ''}` };
}

export const depgatePack: WorkflowPack = {
  id: 'deploy-gate',
  name: 'Deploy Gate',
  domain: 'Release Engineering',
  version: '1.0.0',
  description: 'Release gate that blocks a candidate only for NEW critical CVEs compared with the deployed release, using an SBOM and CVE list the team supplies. Never scans, never deploys: a clear gate produces a dry-run deploy request for a manager to approve.',
  labels: { baseline: 'Deployed Release & CVE Baseline', change: 'Candidate Build', changeVerb: 'Submit Candidate', plan: 'Release Spec', mission: 'Release Gate', blurb: 'Compares a candidate build with the deployed release. Blocks only new critical CVEs, labels missing evidence as unverified, and proposes a dry-run deploy only when the gate is clear or the owner overrides it.' },
  roles: [
    { key: 'depgate_scanner', name: 'Gate Analyst', kind: 'agent', responsibility: 'Compares the candidate CVE list with the deployed release and reports only what is new and critical', department: 'Engineering', scope: 'read' },
    { key: 'depgate_release_manager', name: 'Release Manager', kind: 'agent', responsibility: 'Drafts the dry-run deploy request when the gate is clear or overridden', department: 'Release' },
    { key: 'depgate_owner', name: 'Release Owner', kind: 'human', responsibility: 'The only person who may override a blocked gate', department: 'Operations' },
  ],
  roleOrder: ['depgate_scanner', 'depgate_release_manager', 'depgate_owner'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'cve_delta', label: 'New critical CVEs vs deployed release', department: 'Engineering', ownerRole: 'depgate_scanner', description: 'Only critical CVEs absent from the deployed release; unverified when evidence is missing' },
    { key: 'deploy_request', label: 'Deploy Request (dry-run)', department: 'Release', ownerRole: 'depgate_release_manager', description: 'Records the gate verdict; nothing is deployed' },
  ],
  rules: [],
  artifactEdges: [{ from: 'cve_delta', to: 'deploy_request', relation: 'gates', why: 'The gate verdict decides whether a deploy request is drafted' }],
  decisions: [{ key: 'deploy_auth', label: 'Manager approves a clear deploy request; the release owner alone decides a blocked gate', ownerRole: 'depgate_owner', gates: ['deploy_request'] }],

  sample() {
    return {
      title: 'Candidate v3.2.0 for payments-api (new critical CVE found)',
      plan: {
        service: { name: 'payments-api', environment: 'staging', deployedVersion: 'v3.1.4' },
        deployedCves: [{ id: 'CVE-2026-1001', package: 'libxml-core', severity: 'high' as const, fixedIn: '2.9.3' }],
        approver: 'maya@harborvine.example', owner: 'sam@harborvine.example',
      },
      change: {
        candidateVersion: 'v3.2.0', sbomSupplied: true, scanRecorded: true,
        sbomPackages: [{ name: 'libxml-core', version: '2.9.2' }, { name: 'http-client', version: '5.1.0' }],
        candidateCves: [
          { id: 'CVE-2026-1001', package: 'libxml-core', severity: 'high' as const, fixedIn: '2.9.3' },
          { id: 'CVE-2026-2044', package: 'http-client', severity: 'critical' as const, fixedIn: '5.1.2' },
        ],
        note: 'Sample evidence supplied by the team for illustration. RIPPLE did not scan these packages.',
      },
    };
  },

  detectChanges(plan: Plan, change: Change): ChangeItem[] {
    const g = gate(plan, change);
    return [
      { field: 'candidate.version', label: `Candidate ${change.candidateVersion}`, before: plan.service.deployedVersion, after: change.candidateVersion, kind: 'modified', severity: 'low' },
      { field: 'candidate.newCritical', label: `New critical CVEs: ${g.newCritical.length}`, before: '0', after: String(g.newCritical.length), kind: 'modified', severity: g.verdict === 'blocked' ? 'high' : 'low' },
    ];
  },
  // The deployed baseline is never overwritten by a candidate; a candidate is evaluated, not recorded as deployed.
  applyChange(plan: Plan): Plan { return structuredClone(plan); },

  parseAnswer(key, text) {
    const t = text.trim().toLowerCase();
    if (key === 'owner_override') return t === 'yes' || t === 'no' ? { value: t } : { error: 'Answer yes or no. Yes overrides the block for this candidate only.' };
    return { value: text.trim() };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const A = 'depgate-analyzer';
    const plan = ctx.plan as Plan; const change = ctx.change as Change;
    const g = gate(plan, change, ctx.answers);

    if (role === 'depgate_scanner') {
      const o = new Out(role, `${A}-gate@1`);
      if (g.verdict === 'unverified') o.warn(g.reason, true);
      else if (g.verdict === 'clear') o.info(g.reason);
      else o.risk(`${g.reason} Each is absent from ${plan.service.deployedVersion}.`);
      o.data = { verdict: g.verdict, newCritical: g.newCritical.length };
      const rows = g.newCritical.map((c) => [c.id, c.package, c.severity, c.fixedIn ?? 'not stated']);
      o.draft({ kind: 'cve_delta', name: `New critical CVEs: ${change.candidateVersion}`, artifactKey: 'cve_delta', content: `# New critical CVEs: ${change.candidateVersion} vs ${plan.service.deployedVersion}\n\nVerdict: **${g.verdict}**\n\n${rows.length ? table(['CVE', 'Package', 'Severity', 'Fixed in'], rows) : 'None.'}\n\n_Evidence is what the team supplied; RIPPLE did not scan the packages._` });
      if (g.verdict === 'blocked' && !g.overridden) {
        o.ask({ key: 'owner_override', text: `Gate blocked: ${g.newCritical.length} new critical CVE(s). Only the release owner may decide. Override the block for ${change.candidateVersion} only? (yes/no)`, blocking: true, assigneeRole: 'depgate_owner', assigneeOnly: true });
      }
      return o.done(`Gate ${g.verdict}: ${g.reason}`);
    }

    if (role === 'depgate_release_manager') {
      const o = new Out(role, `${A}-release@1`);
      if (g.verdict === 'unverified') return o.done('No deploy request: the evidence is incomplete (see the gate analyst).');
      if (g.verdict === 'blocked' && !g.overridden) return o.done('No deploy request: the gate is blocked and the owner has not overridden it.');
      const verdictLine = g.verdict === 'clear' ? 'clear' : 'blocked, overridden by the release owner';
      o.draft({ kind: 'deploy_request', name: `Dry-run deploy request: ${change.candidateVersion}`, artifactKey: 'deploy_request', content: `# Dry-run Deploy Request: ${plan.service.name} ${change.candidateVersion} (${plan.service.environment})\n\nGate verdict: **${verdictLine}**\n\n${g.reason}\n\n**DRY-RUN: nothing was deployed.** RIPPLE does not call any deployment system. This gate is not a security certification of the candidate.\n\nApproval: a manager (${plan.approver}) must approve this request before anyone deploys by their own process.` });
      o.act({ key: 'act-deploy-candidate', type: 'deploy_release', title: `Dry-run deploy request for ${plan.service.name} ${change.candidateVersion}`, connector: 'internal_notify', ownerRole: 'depgate_release_manager', consequential: true, draftKind: 'deploy_request', approvalRole: 'manager', ackRoles: ['depgate_owner'], rationale: `Gate ${verdictLine}. Dry-run only: approving records the request; it does not deploy.`, target: `${plan.service.environment}/${plan.service.name}`, effectKey: `deploy-${plan.service.name}-${change.candidateVersion}`, approver: { email: plan.approver } });
      return o.done(`Dry-run deploy request drafted (${verdictLine}).`);
    }

    // The release owner is a human decision role; no analysis is performed on their behalf.
    return new Out(role, `${A}-owner@1`).done('Human decision role: the release owner decides any blocked gate.');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'deploy_release') return checks;
    const text = observed.content;
    checks.push({ name: 'labelled dry-run, nothing deployed', passed: text.includes('DRY-RUN: nothing was deployed'), detail: 'scope statement present in the stored request' });
    checks.push({ name: 'states it is not a security certification', passed: text.includes('not a security certification'), detail: 'honest scope statement present' });
    checks.push({ name: 'gate verdict recorded', passed: /Gate verdict: \*\*(clear|blocked)/.test(text), detail: 'verdict line present' });
    if (ctx) {
      const g = gate(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers);
      const permitted = g.verdict === 'clear' || (g.verdict === 'blocked' && g.overridden);
      checks.push({ name: 'gate re-computed from the stored plan and candidate permits this request', passed: permitted, detail: `re-computed verdict: ${g.verdict}${g.overridden ? ' (owner override)' : ''}` });
    }
    return checks;
  },

  completionChecks(ctx) {
    const g = gate(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers);
    const settled = g.verdict === 'clear' || (g.verdict === 'blocked' && g.overridden);
    return [{ key: 'gate_settled', label: 'Gate decided: clear, or blocked and overridden by the release owner', passed: settled, detail: `verdict: ${g.verdict}${g.overridden ? ' (owner override)' : ''}; ${g.reason}` }];
  },
};
