import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

/**
 * Incident Sentinel pack, inherited from Incident-Sentinel (MIT, github.com/ronitgupta138/Incident-Sentinel) and tightened:
 *  - the culprit is CORRELATED from deployment times, the commit named in the alert and the endpoints each release touched
 *    (it is not hard-coded); an ambiguous correlation is a blocking human question, never a guess;
 *  - the rollback target is the release deployed immediately before the culprit (or the plan's last-known-good), never invented;
 *  - only the on-call SRE named in the plan can approve (named-approver gate);
 *  - RIPPLE does NOT call a cluster or a monitoring system. Recovery is only claimed once a human records a measured
 *    post-rollback error rate, and that number must be within the SLO for the mission to complete.
 */
export const planSchema = z.object({
  service: z.object({
    name: z.string().min(1), cluster: z.string().min(1), namespace: z.string().default('prod'),
    currentVersion: z.string().min(1),                       // the release running right now
    lastKnownGoodVersion: z.string().optional(),            // used only if no earlier deployment is listed
    errorRateBaselinePct: z.number().min(0), p99LatencyMs: z.number().positive(), p99SloMs: z.number().positive().default(300),
    tier: z.enum(['tier-0', 'tier-1', 'tier-2']), sloMaxErrorPct: z.number().positive(),
  }),
  dependencies: z.array(z.string()).default([]),           // services this one calls
  dependents: z.array(z.string()).default([]),             // services/clients that call this one
  deployments: z.array(z.object({
    version: z.string(), commitHash: z.string(), author: z.string(), deployedAt: z.string(), summary: z.string(), touches: z.array(z.string()).default([]),
  })).default([]),
  onCallSre: z.string().min(1),                             // email of the only person who may approve a rollback
  incidentLog: z.array(z.object({ incidentId: z.string(), triggeredAt: z.string(), observedErrorRatePct: z.number() })).default([]),
});
export const changeSchema = z.object({
  incidentId: z.string().min(1), triggeredAt: z.string(), observedErrorRatePct: z.number().min(0), observedP99Ms: z.number().positive(),
  affectedEndpoints: z.array(z.string()).min(1), symptoms: z.string().min(1), recentCommit: z.string().optional(), note: z.string().default(''),
});
type Plan = z.infer<typeof planSchema>;
type Incident = z.infer<typeof changeSchema>;
type Dep = Plan['deployments'][number];
type Answers = AnalysisContext['answers'];

const minutes = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);

export interface Correlation { culprit?: Dep; target?: { version: string; commitHash?: string; source: string }; ambiguous: boolean; ranked: { d: Dep; gapMin: number; score: number; why: string[] }[] }
/** Pure, deterministic culprit + rollback-target decision. Used by the analyzer AND re-computed by the verifier. */
export function correlate(plan: Plan, inc: Incident, answers: Answers = {}): Correlation {
  const onset = Date.parse(inc.triggeredAt);
  const ranked = plan.deployments.filter((d) => Date.parse(d.deployedAt) <= onset).map((d) => {
    const gapMin = minutes(d.deployedAt, inc.triggeredAt); const why: string[] = []; let score = 0;
    if (gapMin <= 60) { score += 3; why.push(`deployed ${gapMin} min before onset`); } else if (gapMin <= 360) { score += 2; why.push(`deployed ${gapMin} min before onset`); } else if (gapMin <= 1440) { score += 1; why.push(`deployed ${Math.round(gapMin / 60)} h before onset`); }
    if (inc.recentCommit && d.commitHash === inc.recentCommit) { score += 3; why.push('commit named in the alert'); }
    const overlap = d.touches.filter((t) => inc.affectedEndpoints.some((e) => e.includes(t) || t.includes(e)));
    if (overlap.length) { score += 2; why.push(`touches affected endpoint(s): ${overlap.join(', ')}`); }
    return { d, gapMin, score, why };
  }).sort((a, b) => b.score - a.score || a.gapMin - b.gapMin);
  let culprit: Dep | undefined; let ambiguous = false;
  const confirmed = answers.culprit_confirm?.value as string | undefined;
  if (confirmed) culprit = plan.deployments.find((d) => d.version === confirmed);
  else if (ranked[0] && ranked[0].score >= 3) {
    const tie = ranked[1] && ranked[1].score >= ranked[0].score && !(inc.recentCommit && ranked[0].d.commitHash === inc.recentCommit);
    if (tie) ambiguous = true; else culprit = ranked[0].d;
  }
  let target: Correlation['target'];
  const manual = answers.rollback_target?.value as string | undefined;
  if (manual) target = { version: manual, source: 'named by a human' };
  else if (culprit) {
    const byTime = [...plan.deployments].sort((a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt));
    const prev = byTime[byTime.findIndex((d) => d.version === culprit!.version) - 1];
    if (prev) target = { version: prev.version, commitHash: prev.commitHash, source: 'release deployed immediately before the culprit' };
    else if (plan.service.lastKnownGoodVersion) target = { version: plan.service.lastKnownGoodVersion, source: 'last-known-good version recorded in the plan' };
  }
  return { culprit, target, ambiguous, ranked };
}

export const sentinelPack: WorkflowPack = {
  id: 'incident-sentinel',
  name: 'Incident Sentinel',
  domain: 'SRE & Cloud Infrastructure',
  version: '1.1.0',
  description: 'SRE incident war room: SLO-breach triage, deploy/commit correlation, blast radius, an on-call-only rollback approval, and a recovery claim that requires a measured number. Does not call a cluster or monitoring system.',
  labels: { baseline: 'Service SLO & Topology', change: 'Telemetry Anomaly / Incident', changeVerb: 'Trigger Incident', plan: 'Service Spec', mission: 'Incident Room', blurb: 'Correlates a telemetry spike to a release, asks the on-call SRE (and only them) to approve a rollback request, and claims recovery only from a recorded measurement.' },
  roles: [
    { key: 'telemetry_triager', name: 'Telemetry Triager', kind: 'agent', responsibility: 'Evaluates error spikes and latency against SLO thresholds', department: 'SRE' },
    { key: 'commit_investigator', name: 'Commit Investigator', kind: 'agent', responsibility: 'Correlates incident onset to deployments, commits and touched endpoints', department: 'Engineering' },
    { key: 'sre_lead', name: 'SRE Incident Commander', kind: 'human', responsibility: 'Confirms blast radius and rollback safety; the only approver of the rollback request', department: 'SRE' },
    { key: 'rollback_operator', name: 'Rollback Operator', kind: 'agent', responsibility: 'Drafts the rollback request and the postmortem', department: 'Infrastructure' },
  ],
  roleOrder: ['telemetry_triager', 'commit_investigator', 'rollback_operator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'telemetry_report', label: 'Telemetry Triaging Report', department: 'SRE', ownerRole: 'telemetry_triager', description: 'Metrics delta and SLO breach calculation' },
    { key: 'commit_correlation', label: 'Commit Correlation & Blast Radius', department: 'Engineering', ownerRole: 'commit_investigator', description: 'Ranked suspect releases with the reasons, and the blast radius' },
    { key: 'rollback_manifest', label: 'Rollback Request', department: 'Infrastructure', ownerRole: 'rollback_operator', description: 'Target release, evidence and an illustrative command' },
    { key: 'postmortem', label: 'Incident Postmortem (draft)', department: 'SRE', ownerRole: 'rollback_operator', description: 'Timeline from recorded timestamps; recovery only if measured' },
  ],
  rules: [
    { id: 'sentinel.error_rate', trigger: (i) => i.field.includes('errorRate') || i.field.includes('latency'), to: 'telemetry_report', relation: 'triggers_triage', why: 'Metric anomaly measured against the SLO' },
    { id: 'sentinel.endpoints', trigger: (i) => i.field.includes('endpoints'), to: 'commit_correlation', relation: 'correlates_release', why: 'Affected endpoints are matched to what each release touched' },
  ],
  artifactEdges: [
    { from: 'telemetry_report', to: 'commit_correlation', relation: 'informs', why: 'Severity guides how hard to look at recent releases' },
    { from: 'commit_correlation', to: 'rollback_manifest', relation: 'defines_target', why: 'The culprit decides the rollback target' },
    { from: 'rollback_manifest', to: 'postmortem', relation: 'documents', why: 'The remediation is recorded in the postmortem' },
  ],
  decisions: [{ key: 'rollback_auth', label: 'On-call SRE authorises the rollback request', ownerRole: 'sre_lead', gates: ['rollback_manifest'] }],

  sample() {
    return {
      title: 'INC-8924: Checkout API HTTP 500 spike after v2.14.0',
      plan: {
        service: { name: 'checkout-api', cluster: 'k8s-prod-us-east-1', namespace: 'prod', currentVersion: 'v2.14.0', errorRateBaselinePct: 0.02, p99LatencyMs: 85, p99SloMs: 300, tier: 'tier-0', sloMaxErrorPct: 0.5 },
        dependencies: ['auth-service', 'stripe-connector', 'inventory-db'], dependents: ['web-storefront', 'mobile-app'],
        deployments: [
          { version: 'v2.13.9', commitHash: '4e1c07a', author: 'sre-core', deployedAt: '2026-10-31T10:05:00Z', summary: 'fix(db): connection pool scaling', touches: ['/v1/auth'] },
          { version: 'v2.14.0', commitHash: '7f8a91b', author: 'alex.dev@harborvine.example', deployedAt: '2026-11-03T18:15:00Z', summary: 'feat: cart caching layer with redis serialization', touches: ['/v1/checkout', '/v1/cart'] },
        ],
        onCallSre: 'maya@harborvine.example', incidentLog: [],
      },
      change: { incidentId: 'INC-8924', triggeredAt: '2026-11-03T18:22:00Z', observedErrorRatePct: 14.8, observedP99Ms: 1420, affectedEndpoints: ['POST /v1/checkout/charge', 'GET /v1/cart'], symptoms: 'HTTP 500 rate surged above the SLO right after the v2.14.0 release.', recentCommit: '7f8a91b', note: 'Checkout drop-off observed.' },
    };
  },

  detectChanges(plan: Plan, inc: Incident): ChangeItem[] {
    const ratio = inc.observedErrorRatePct / plan.service.sloMaxErrorPct;
    return [
      { field: 'service.errorRate', label: `HTTP 5xx rate ${inc.observedErrorRatePct}%`, before: `${plan.service.errorRateBaselinePct}% (SLO ${plan.service.sloMaxErrorPct}%)`, after: `${inc.observedErrorRatePct}%`, kind: 'modified', severity: inc.observedErrorRatePct > plan.service.sloMaxErrorPct ? 'high' : 'low', note: `${ratio.toFixed(1)}x the SLO limit` },
      { field: 'service.latency', label: `p99 latency ${inc.observedP99Ms}ms`, before: `${plan.service.p99LatencyMs}ms (SLO ${plan.service.p99SloMs}ms)`, after: `${inc.observedP99Ms}ms`, kind: 'modified', severity: inc.observedP99Ms > plan.service.p99SloMs ? 'high' : 'low', note: `${(inc.observedP99Ms / plan.service.p99LatencyMs).toFixed(1)}x baseline` },
      { field: 'incident.endpoints', label: `Affected endpoints: ${inc.affectedEndpoints.join(', ')}`, before: 'healthy', after: 'degraded', kind: 'modified', severity: 'high' },
    ];
  },
  // The incident is LOGGED; the healthy baseline is never overwritten with incident numbers.
  applyChange(plan: Plan, inc: Incident): Plan {
    const next = structuredClone(plan);
    if (!next.incidentLog.some((i) => i.incidentId === inc.incidentId)) next.incidentLog.push({ incidentId: inc.incidentId, triggeredAt: inc.triggeredAt, observedErrorRatePct: inc.observedErrorRatePct });
    return next;
  },
  parseAnswer(key, text, plan: Plan) {
    const t = text.trim();
    if (key === 'culprit_confirm') { const d = plan.deployments.find((x) => x.version === t || x.commitHash === t); return d ? { value: d.version } : { error: `Reply with one of the listed releases: ${plan.deployments.map((x) => x.version).join(', ')}.` }; }
    if (key === 'rollback_target') return /^[\w.+-]{1,40}$/.test(t) ? { value: t } : { error: 'Give a release/version identifier such as v2.13.9.' };
    if (key === 'post_rollback_error_rate') { const n = Number(t.replace('%', '')); return Number.isFinite(n) && n >= 0 && n <= 100 ? { value: n } : { error: 'Give the measured 5xx rate as a percentage, e.g. 0.03.' }; }
    return { value: t };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const plan = ctx.plan as Plan; const inc = ctx.change as Incident; const A = 'sentinel-analyzer';
    const svc = plan.service; const errRatio = inc.observedErrorRatePct / svc.sloMaxErrorPct;
    const breach = inc.observedErrorRatePct > svc.sloMaxErrorPct || inc.observedP99Ms > svc.p99SloMs;
    const sev = !breach ? 'no SLO breach' : svc.tier === 'tier-0' && errRatio >= 10 ? 'SEV-1' : errRatio >= 2 || svc.tier !== 'tier-2' ? 'SEV-2' : 'SEV-3';

    if (role === 'telemetry_triager') {
      const o = new Out(role, `${A}-triage@2`);
      if (!breach) o.warn('The reported numbers do NOT breach the SLO. This may be a false alarm; no rollback will be proposed.', true);
      else o.risk(`${sev}: error rate ${inc.observedErrorRatePct}% is ${errRatio.toFixed(1)}x the ${svc.sloMaxErrorPct}% SLO on a ${svc.tier} service.`);
      if (inc.observedP99Ms > svc.p99SloMs) o.warn(`p99 ${inc.observedP99Ms}ms vs SLO ${svc.p99SloMs}ms (baseline ${svc.p99LatencyMs}ms).`);
      o.info(`Affected endpoints: ${inc.affectedEndpoints.join(', ')}. Figures are as REPORTED in the alert; RIPPLE does not query your monitoring stack.`);
      o.data = { breach, sev };
      const rows = [['Metric', 'Baseline', 'Reported', 'SLO', 'Status'], ['5xx error rate', `${svc.errorRateBaselinePct}%`, `${inc.observedErrorRatePct}%`, `${svc.sloMaxErrorPct}%`, inc.observedErrorRatePct > svc.sloMaxErrorPct ? 'BREACH' : 'ok'], ['p99 latency', `${svc.p99LatencyMs}ms`, `${inc.observedP99Ms}ms`, `${svc.p99SloMs}ms`, inc.observedP99Ms > svc.p99SloMs ? 'BREACH' : 'ok']];
      o.draft({ kind: 'telemetry_report', name: `Telemetry Triage: ${inc.incidentId}`, artifactKey: 'telemetry_report', content: `# Incident Telemetry Triage: ${inc.incidentId}\n\nService: **${svc.name}** (${svc.cluster}/${svc.namespace}), ${svc.tier}\nSeverity: **${sev}**\nSymptoms: ${inc.symptoms}\n\n${table(rows[0], rows.slice(1))}\n\n_Numbers are as reported in the alert, not independently measured by RIPPLE._` });
      return o.done(`Triage: ${sev}.`);
    }

    if (role === 'commit_investigator') {
      const o = new Out(role, `${A}-commit@2`);
      const c = correlate(plan, inc, ctx.answers);
      o.data = { culprit: c.culprit?.version ?? null, target: c.target ?? null };
      const blast = `${svc.name} (${svc.tier}) → dependents [${plan.dependents.join(', ') || 'none listed'}], dependencies [${plan.dependencies.join(', ') || 'none listed'}]`;
      if (c.ambiguous) {
        o.risk(`AMBIGUOUS: ${c.ranked.slice(0, 2).map((r) => `${r.d.version} (score ${r.score})`).join(' and ')} correlate equally. No rollback is proposed until a human picks the culprit.`);
        o.ask({ key: 'culprit_confirm', text: `Two releases correlate equally with the incident (${c.ranked.slice(0, 2).map((r) => r.d.version).join(', ')}). Which release is the culprit?`, blocking: true, assigneeRole: 'sre_lead' });
      } else if (!c.culprit) {
        o.warn('No deployment within 24h before onset (or none matching the alert) correlates with this incident. A rollback may not help; investigate dependencies/traffic.', true);
        o.work({ key: 'sre-investigate-non-deploy', title: 'Investigate non-deployment causes (dependency, traffic, infrastructure)', detail: 'No release correlates with the onset time.', department: 'SRE', roleKey: 'sre_lead', kind: 'review', artifactKey: 'commit_correlation' });
      } else {
        o.risk(`Suspect release ${c.culprit.version} (${c.culprit.commitHash}) by ${c.culprit.author}: ${c.ranked.find((r) => r.d.version === c.culprit!.version)?.why.join('; ') || 'confirmed by a human'}.`);
        if (!c.target) o.ask({ key: 'rollback_target', text: `No earlier release is listed before ${c.culprit.version} and no last-known-good version is recorded. Which release should we roll back to?`, blocking: true, assigneeRole: 'sre_lead' });
        else o.info(`Rollback target: ${c.target.version} (${c.target.source}).`);
      }
      o.warn(`Blast radius: ${blast}.`);
      o.draft({ kind: 'commit_correlation', name: 'Commit Correlation & Blast Radius', artifactKey: 'commit_correlation', content: `# Commit Correlation & Blast Radius: ${inc.incidentId}\n\n${c.ranked.length ? table(['Release', 'Commit', 'Deployed', 'Min before onset', 'Score', 'Why'], c.ranked.map((r) => [r.d.version, r.d.commitHash, r.d.deployedAt, r.gapMin, r.score, r.why.join('; ') || 'weak'])) : '_No deployment precedes the incident._'}\n\n- **Culprit**: ${c.culprit ? `${c.culprit.version} (${c.culprit.commitHash}) "${c.culprit.summary}"` : c.ambiguous ? 'AMBIGUOUS: waiting for a human' : 'none identified'}\n- **Rollback target**: ${c.target ? `${c.target.version} (${c.target.source})` : 'none'}\n- **Blast radius**: ${blast}\n\n_Correlation is a heuristic (time proximity, commit named in the alert, endpoints touched). It is evidence, not proof._` });
      return o.done(c.culprit ? `Culprit ${c.culprit.version}; target ${c.target?.version ?? 'unknown'}.` : c.ambiguous ? 'Culprit ambiguous; human decision requested.' : 'No correlating release found.');
    }

    const o = new Out(role, `${A}-operator@2`);
    const c = correlate(plan, inc, ctx.answers);
    const triage = ctx.results.telemetry_triager?.data as { breach: boolean } | undefined;
    const rate = ctx.answers.post_rollback_error_rate?.value as number | undefined;
    const timeline = [`- ${plan.deployments.find((d) => d === c.culprit)?.deployedAt ?? '(unknown)'}: ${c.culprit?.version ?? 'suspect release'} deployed`, `- ${inc.triggeredAt}: incident ${inc.incidentId} triggered (${inc.observedErrorRatePct}% 5xx, p99 ${inc.observedP99Ms}ms, as reported)`, '- (pending): rollback request approved by the on-call SRE', rate == null ? '- (pending): post-rollback error rate measured by a human' : `- recorded: post-rollback 5xx rate ${rate}% (human-reported)`].join('\n');
    o.draft({ kind: 'postmortem', name: `Postmortem (draft): ${inc.incidentId}`, artifactKey: 'postmortem', content: `# Incident Postmortem (DRAFT): ${inc.incidentId}\n\n- **Service**: ${svc.name} (${svc.tier})\n- **Impact (reported)**: 5xx ${inc.observedErrorRatePct}% vs SLO ${svc.sloMaxErrorPct}%\n- **Suspected cause**: ${c.culprit ? `${c.culprit.version} (${c.culprit.commitHash}) "${c.culprit.summary}"` : 'not established'}\n- **Resolution**: ${rate == null ? 'NOT yet claimed: no post-rollback measurement has been recorded' : rate <= svc.sloMaxErrorPct ? `error rate measured at ${rate}% (within SLO, human-reported)` : `error rate still ${rate}% (above the SLO)`}\n\n## Timeline\n${timeline}\n\n## Follow-ups (to be assigned by humans)\n- Add a test for the failing path on the endpoints above.\n- Consider a canary stage before full rollout.` });
    if (!triage?.breach || !c.culprit || !c.target) return o.done('No rollback proposed (no breach, no unambiguous culprit, or no target).');
    o.work({ key: 'sre-lead-verify', title: 'Review the telemetry and confirm the rollback is safe (e.g. no incompatible schema change)', detail: `Rolling back ${c.culprit.version} → ${c.target.version}.`, department: 'SRE', roleKey: 'sre_lead', kind: 'review', artifactKey: 'rollback_manifest' });
    o.ask({ key: 'post_rollback_error_rate', text: `After the rollback, what 5xx error rate (%) does your monitoring show for ${svc.name}? RIPPLE does not read your monitoring; recovery is only claimed from the number you record.`, blocking: false, assigneeRole: 'sre_lead' });
    o.draft({ kind: 'rollback_manifest', name: 'Production Rollback Request', artifactKey: 'rollback_manifest', content: `# Production Rollback Request: ${inc.incidentId}\n\n- **Cluster / namespace**: ${svc.cluster} / ${svc.namespace}\n- **Service**: ${svc.name}\n- **Running (culprit) release**: ${c.culprit.version} (${c.culprit.commitHash})\n- **Roll back TO**: ${c.target.version}${c.target.commitHash ? ` (${c.target.commitHash})` : ''}: ${c.target.source}\n- **Evidence**: ${c.ranked.find((r) => r.d.version === c.culprit!.version)?.why.join('; ') || 'confirmed by a human'}\n- **Blast radius**: dependents [${plan.dependents.join(', ') || 'none listed'}]\n- **Illustrative command** (NOT executed by RIPPLE; confirm against your deployment tooling): \`kubectl rollout undo deployment/${svc.name} --namespace=${svc.namespace}\`\n\n> RIPPLE records this approved request in a local outbox. It does not call your cluster. Recovery is claimed only after a measured post-rollback error rate is recorded.` });
    o.act({ key: 'act-rollback-k8s', type: 'k8s_rollback', title: `Request rollback of ${svc.name}: ${c.culprit.version} → ${c.target.version}`, connector: 'internal_notify', ownerRole: 'rollback_operator', consequential: true, draftKind: 'rollback_manifest', approvalRole: 'manager', ackRoles: ['sre_lead'], rationale: `${sev}: ${c.culprit.version} correlates with the incident; roll back to ${c.target.version}. Only the on-call SRE (${plan.onCallSre}) may approve. Nothing is executed on a cluster by RIPPLE.`, target: `${svc.cluster}/${svc.name}`, effectKey: `rollback-${svc.name}-${c.culprit.version}-to-${c.target.version}`, approver: { email: plan.onCallSre } });
    return o.done(`Rollback request ${c.culprit.version} → ${c.target.version} drafted; on-call approval required.`);
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'k8s_rollback') return checks;
    const text = observed.content;
    checks.push({ name: 'rollback command present', passed: text.includes('rollout undo'), detail: text.includes('rollout undo') ? 'illustrative rollout-undo command present' : 'command missing' });
    if (ctx) {
      const plan = ctx.baselinePlan as Plan; const c = correlate(plan, ctx.change as Incident, ctx.answers);
      checks.push({ name: 'target service specified', passed: text.includes(`deployment/${plan.service.name}`) && text.includes(plan.service.cluster), detail: `${plan.service.cluster}/${plan.service.name}` });
      checks.push({ name: 'rollback target equals the independently re-computed target', passed: !!c.target && text.includes(`Roll back TO**: ${c.target.version}`), detail: c.target ? `expected ${c.target.version}` : 'no target could be re-computed' });
      checks.push({ name: 'rollback target is not the culprit release', passed: !!c.culprit && !!c.target && c.target.version !== c.culprit.version, detail: `${c.target?.version ?? '?'} vs ${c.culprit?.version ?? '?'}` });
    }
    checks.push({ name: 'states that no cluster was called', passed: text.includes('does not call your cluster'), detail: 'honest scope statement present' });
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const rate = ctx.answers.post_rollback_error_rate?.value as number | undefined;
    return [{ key: 'recovery_measured', label: 'Recovery supported by a recorded post-rollback measurement within the SLO', passed: rate != null && rate <= plan.service.sloMaxErrorPct, detail: rate == null ? 'No measurement recorded: RIPPLE does not read your monitoring, so recovery is not claimed.' : `Human-reported ${rate}% vs SLO ${plan.service.sloMaxErrorPct}%.` }];
  },
};
