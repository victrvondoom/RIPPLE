import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import { untrustedFindings } from '../untrusted.js';

/**
 * CrewPilot pack, inherited from CrewPilot (MIT, github.com/vincenzo-afk/CrewPilot: structured triage {category, severity, difficulty, summary,
 * fix plan}, "issue text is untrusted data", duplicate-request rejection, "if the issue is vague make the first step a clarification",
 * "only the original requester can approve") and tightened:
 *  - triage is a transparent, DETERMINISTIC rule set (labelled as heuristics, unit-tested); the reporter's suggested severity is shown but not trusted;
 *  - approval is bound to the person who REPORTED the issue (named-approver gate by email), not to a role;
 *  - the verifier independently re-triages and checks the stored approval record;
 *  - NOTHING touches a repository: the action records the approved plan. No code is changed, nothing is merged, no GitHub write.
 */
export const planSchema = z.object({
  repository: z.object({ name: z.string().min(1), defaultBranch: z.string().default('main'), ciTestPassing: z.boolean().default(true), openIssuesCount: z.number().int().min(0).default(0) }),
  architectureModules: z.array(z.object({ name: z.string().min(1), pathPrefix: z.string().min(1), owner: z.string().min(1), keywords: z.array(z.string()).default([]) })).min(1),
  knownIssues: z.array(z.object({ issueId: z.string(), title: z.string(), status: z.string().default('open') })).default([]),
  leadEngineer: z.string().min(1),
});
export const changeSchema = z.object({
  issueId: z.string().min(1), title: z.string().min(1), body: z.string().min(1), reportedBy: z.string().min(3), reportedAt: z.string(),
  suggestedSeverity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(), note: z.string().default(''),
});
type Plan = z.infer<typeof planSchema>;
type Issue = z.infer<typeof changeSchema>;
type Answers = AnalysisContext['answers'];

const STOP = new Set('a an the and or of to in on for with by at from as is are was were be it this that when if then not no can could should would will do does during after before into over under'.split(' '));
const toks = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => { const i = [...a].filter((x) => b.has(x)).length; return i / Math.max(1, a.size + b.size - i); };
const clarifyKey = (id: string) => `clarify_${id.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40)}`;

export interface Triage {
  category: 'bug' | 'feature' | 'chore' | 'question'; severity: 'critical' | 'high' | 'medium' | 'low'; difficulty: 'easy' | 'medium' | 'hard';
  module?: Plan['architectureModules'][number]; moduleCount: number; duplicate?: { issueId: string; title: string; similarity: number };
  vague: boolean; clarification?: string; injection: string[]; steps: string[]; summary: string;
}
const BUG = /\b(bug|error|errors|fail|fails|failing|crash|crashes|broken|exception|500|race condition|deadlock|regression|timeout|stuck|cannot|can't|wrong|incorrect|leak)\b/i;
const FEATURE = /\b(feature|add support|support for|would be nice|enhancement|implement|new option|allow users)\b/i;
const CHORE = /\b(bump|upgrade|refactor|clean ?up|chore|dependenc(?:y|ies)|lint|rename|migrate)\b/i;
const CRITICAL = /(data loss|lose data|lost data|security|vulnerab|exploit|leak(?:s|ed)? (?:data|secrets?|tokens?)|outage|corrupt|privilege|unauthori[sz]ed|production (?:is )?down|race condition[\s\S]*(token|session|auth|payment)|(token|session|auth|payment)[\s\S]*race condition)/i;
const COSMETIC = /\b(typo|cosmetic|colou?r|alignment|spelling|wording|tooltip|padding|pixel)\b/i;
const HARD = /\b(concurren\w*|race condition|deadlock|migration|rewrite|architecture|distributed|data model|schema)\b/i;

/** Deterministic triage. The same function is used by the analyzer and re-run by the verifier. */
export function triage(plan: Plan, issue: Issue, answers: Answers = {}): Triage {
  const clar = answers[clarifyKey(issue.issueId)]?.text;
  const text = `${issue.title}\n${issue.body}${clar ? `\n${clar}` : ''}`;
  const injection = untrustedFindings(text);
  const category: Triage['category'] = BUG.test(text) ? 'bug' : FEATURE.test(text) ? 'feature' : CHORE.test(text) ? 'chore' : 'question';
  const low = text.toLowerCase();
  const scored = plan.architectureModules.map((m) => {
    let s = 0;
    if (low.includes(m.pathPrefix.toLowerCase())) s += 3;
    for (const k of m.keywords) if (new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(low)) s += 2;
    for (const t of toks(m.name)) if (low.includes(t)) s += 1;
    return { m, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const severity: Triage['severity'] = category === 'chore' || category === 'question' ? 'low' : category === 'feature' ? 'medium' : CRITICAL.test(text) ? 'critical' : COSMETIC.test(text) ? 'low' : BUG.test(text) ? 'high' : 'medium';
  const difficulty: Triage['difficulty'] = HARD.test(text) || scored.length >= 3 ? 'hard' : COSMETIC.test(text) ? 'easy' : 'medium';
  let duplicate: Triage['duplicate'];
  const myToks = toks(issue.title);
  for (const k of plan.knownIssues) {
    if (k.issueId === issue.issueId && k.status !== 'triaged') continue;
    const sim = k.issueId === issue.issueId ? 1 : jaccard(myToks, toks(k.title));
    if (sim >= 0.6 && (!duplicate || sim > duplicate.similarity)) duplicate = { issueId: k.issueId, title: k.title, similarity: Math.round(sim * 100) / 100 };
  }
  const vague = !clar && (issue.body.trim().length < 40 || scored.length === 0);
  const module = scored[0]?.m;
  const where = module ? `${module.name} (${module.pathPrefix})` : 'the affected component';
  const steps = category === 'bug'
    ? ['Reproduce the failure and capture it as a failing test', `Locate the cause in ${where}`, 'Implement the smallest fix that makes the test pass', 'Add a regression test for the exact scenario in the report', ...(severity === 'critical' || severity === 'high' ? ['Review security and data impact before release'] : []), 'Run the full suite; CI must be green before merging']
    : category === 'feature' ? ['Write a short spec with acceptance criteria', `Identify the change points in ${where}`, 'Implement behind a flag if user-visible', 'Add tests and update the docs', 'Run the full suite; CI must be green before merging']
    : category === 'chore' ? [`Scope the change in ${where}`, 'Make the change in a small, reviewable commit', 'Run the full suite; CI must be green before merging']
    : ['Answer the question in the thread', 'If it exposes a documentation gap, open a docs fix'];
  const summary = `${category} · ${severity} severity · ${difficulty} difficulty · ${module ? `module "${module.name}"` : 'module unknown'}`;
  return { category, severity, difficulty, module, moduleCount: scored.length, duplicate, vague, clarification: clar, injection, steps, summary };
}

export const crewpilotPack: WorkflowPack = {
  tier: 'extended', system: 'engineering',
  id: 'crewpilot',
  name: 'PR-Pilot & Issue Triage',
  domain: 'Software Engineering & Issue Triage',
  version: '1.1.0',
  description: 'Issue triage room: transparent deterministic triage (category, severity, difficulty, owning module), duplicate rejection, a clarification question for vague reports, a fix plan, and an approval only the reporter can give. Never changes code or merges anything.',
  labels: { baseline: 'Repository & Architecture Spec', change: 'Incoming Issue', changeVerb: 'Triage Issue', plan: 'Repository Spec', mission: 'Issue Triage Room', blurb: 'Triages an issue with transparent rules, builds a fix plan, and records an approval that only the reporter can give. No code is changed.' },
  roles: [
    { key: 'issue_triager', name: 'Issue Triager', kind: 'agent', responsibility: 'Classifies category, severity and difficulty and routes to the owning module; treats the issue text as data', department: 'Engineering' },
    { key: 'architect_reviewer', name: 'Architectural Reviewer', kind: 'agent', responsibility: 'Drafts the fix plan (no invented file paths) and regression test requirements', department: 'Architecture' },
    { key: 'lead_engineer', name: 'Lead Engineer', kind: 'human', responsibility: 'Validates feasibility of the plan and receives the assignment', department: 'Engineering' },
    { key: 'pr_guardian', name: 'Plan Recorder', kind: 'agent', responsibility: 'Records the approved fix plan and assignment; proposes nothing for duplicates or unclear issues', department: 'Engineering' },
  ],
  roleOrder: ['issue_triager', 'architect_reviewer', 'pr_guardian'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'triage_card', label: 'Structured Issue Triage Card', department: 'Engineering', ownerRole: 'issue_triager', description: 'Category, severity, difficulty, module, duplicates, flags' },
    { key: 'fix_plan', label: 'Fix Plan', department: 'Architecture', ownerRole: 'architect_reviewer', description: 'Numbered steps and regression tests' },
    { key: 'pr_dispatch', label: 'Approved plan record', department: 'Engineering', ownerRole: 'pr_guardian', description: 'What the reporter approved; nothing is merged' },
  ],
  rules: [
    { id: 'pilot.issue', trigger: (i) => i.field.startsWith('issue'), to: 'triage_card', relation: 'triggers_triage', why: 'A new issue must be triaged' },
  ],
  artifactEdges: [
    { from: 'triage_card', to: 'fix_plan', relation: 'informs', why: 'Severity and module decide the plan' },
    { from: 'fix_plan', to: 'pr_dispatch', relation: 'authorizes_record', why: 'The approved plan becomes the assignment record' },
  ],
  decisions: [{ key: 'fix_plan_auth', label: 'The reporter approves the fix plan', ownerRole: 'lead_engineer', gates: ['pr_dispatch'] }],

  sample() {
    return {
      title: 'ISSUE-118: Race condition in session token invalidation during concurrent logout',
      plan: {
        repository: { name: 'harborvine/core-api', defaultBranch: 'main', ciTestPassing: true, openIssuesCount: 14 },
        architectureModules: [
          { name: 'Auth & Session Gateway', pathPrefix: 'src/server/auth/', owner: 'dan@harborvine.example', keywords: ['session', 'token', 'logout', 'login', 'auth'] },
          { name: 'Database Persistence', pathPrefix: 'src/server/db/', owner: 'maya@harborvine.example', keywords: ['database', 'sql', 'migration', 'lock'] },
          { name: 'HTTP Routing', pathPrefix: 'src/server/api/', owner: 'dan@harborvine.example', keywords: ['route', 'endpoint', 'http'] },
        ],
        knownIssues: [{ issueId: 'ISSUE-101', title: 'Dark mode toggle misaligned on the settings page', status: 'open' }],
        leadEngineer: 'dan@harborvine.example',
      },
      change: {
        issueId: 'ISSUE-118', title: 'Race condition in session token invalidation during concurrent logout requests',
        body: 'When two concurrent logout requests arrive within 5ms, session token deletion hits an unhandled database lock error and the session token stays active in the cache.',
        reportedBy: 'maya@harborvine.example', reportedAt: '2026-11-03T19:20:00Z', suggestedSeverity: 'P1', note: 'Reported by a security auditor.',
      },
    };
  },

  detectChanges(plan: Plan, issue: Issue): ChangeItem[] {
    const t = triage(plan, issue);
    return [{ field: 'issue.intake', label: `Issue ${issue.issueId}: ${issue.title}`, before: `${plan.repository.openIssuesCount} open issues`, after: t.summary, kind: 'added', severity: t.severity === 'critical' || t.severity === 'high' ? 'high' : 'medium', note: issue.suggestedSeverity ? `Reporter suggested ${issue.suggestedSeverity} (not trusted)` : undefined }];
  },
  applyChange(plan: Plan, issue: Issue): Plan {
    const next = structuredClone(plan);
    if (!next.knownIssues.some((k) => k.issueId === issue.issueId)) { next.knownIssues.push({ issueId: issue.issueId, title: issue.title, status: 'triaged' }); next.repository.openIssuesCount += 1; }
    return next;
  },
  parseAnswer(key, text) {
    if (key.startsWith('clarify_')) return text.trim().length >= 15 ? { value: text.trim() } : { error: 'Please give at least a sentence: which component, what steps, what you expected.' };
    return { value: text.trim() };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const plan = ctx.plan as Plan; const issue = ctx.change as Issue; const A = 'crewpilot-analyzer';
    const t = triage(plan, issue, ctx.answers);
    const stop = !!t.duplicate || (t.vague && !t.clarification);

    if (role === 'issue_triager') {
      const o = new Out(role, `${A}-triager@2`);
      if (t.injection.length) o.risk(`The issue text contains instruction-like content (${t.injection.join('; ')}). It was treated as DATA and ignored.`);
      if (t.duplicate) o.warn(`Possible duplicate of ${t.duplicate.issueId} "${t.duplicate.title}" (similarity ${t.duplicate.similarity}). No plan or approval is proposed: resolve the duplicate first.`, true);
      o.info(`Heuristic triage: ${t.summary}. Reporter suggested ${issue.suggestedSeverity ?? 'nothing'}; that suggestion was NOT used.`);
      if (t.vague && !t.clarification) o.ask({ key: clarifyKey(issue.issueId), text: `The report is too vague to route (${issue.body.trim().length < 40 ? 'very short' : 'no known component matches'}). Which component is affected, what are the exact steps, and what did you expect?`, blocking: true, assigneeRole: 'lead_engineer' });
      if (t.module) o.info(`Routed to ${t.module.name} (owner ${t.module.owner}).`);
      o.draft({ kind: 'triage_card', name: `Triage Card: ${issue.issueId}`, artifactKey: 'triage_card', content: `# Issue Triage Card: ${issue.issueId}\n\n${table(['Dimension', 'Result'], [['Title', issue.title], ['Category', t.category], ['Severity (heuristic)', t.severity], ['Difficulty (heuristic)', t.difficulty], ['Owning module', t.module ? `${t.module.name} (${t.module.pathPrefix})` : 'unknown'], ['Owner', t.module?.owner ?? plan.leadEngineer], ['Duplicate?', t.duplicate ? `maybe ${t.duplicate.issueId}` : 'no'], ['Reporter', issue.reportedBy], ['Reporter-suggested severity', `${issue.suggestedSeverity ?? 'none'} (not trusted)`]])}\n\n### Report (untrusted data)\n> ${issue.body.replace(/\n/g, '\n> ')}\n\n_Triage is a transparent rule set, not a model judgement. Treat it as a starting point._` });
      return o.done(`Triaged: ${t.summary}.`);
    }

    if (role === 'architect_reviewer') {
      const o = new Out(role, `${A}-architect@2`);
      if (stop) return o.done(t.duplicate ? 'No plan: probable duplicate.' : 'No plan yet: waiting for clarification.');
      o.info(`Fix plan: ${t.steps.length} steps.${t.moduleCount === 0 ? ' No module matched; the lead engineer must assign an owner.' : ''}`);
      o.draft({ kind: 'fix_plan', name: `Fix Plan: ${issue.issueId}`, artifactKey: 'fix_plan', content: `# Fix plan: ${issue.issueId}\n\n${t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n_File paths are not invented: only the module path prefixes from the repository spec are named._` });
      return o.done('Fix plan drafted.');
    }

    const o = new Out(role, `${A}-recorder@2`);
    if (stop) return o.done('Nothing to record.');
    if (!plan.repository.ciTestPassing) o.warn('CI is currently RED. The plan must restore CI before any merge.', true);
    o.work({ key: 'lead-engineer-verify', title: `Validate the fix plan for ${issue.issueId} and accept the assignment`, detail: `Owner: ${t.module?.owner ?? plan.leadEngineer}`, department: 'Engineering', roleKey: 'lead_engineer', kind: 'review', artifactKey: 'pr_dispatch' });
    const owner = t.module?.owner ?? plan.leadEngineer;
    o.draft({ kind: 'pr_dispatch', name: `Approved plan record: ${issue.issueId}`, artifactKey: 'pr_dispatch', content: `# Approved fix plan record: ${issue.issueId}\n\n- **Repository**: ${plan.repository.name}\n- **Target branch**: ${plan.repository.defaultBranch}\n- **Severity (heuristic)**: ${t.severity}\n- **Owning module**: ${t.module?.name ?? 'unassigned'}\n- **Assignee**: ${owner}\n- **Approved by**: ${issue.reportedBy} (the reporter)\n- **CI at triage time**: ${plan.repository.ciTestPassing ? 'passing' : 'FAILING'}\n\n${t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n> No code was changed, nothing was merged and nothing was written to GitHub. This is a record of the approved plan and assignment.` });
    o.act({ key: 'act-approve-fix-plan', type: 'fix_plan_approval', title: `Record approved fix plan for ${issue.issueId} → ${owner}`, connector: 'internal_notify', ownerRole: 'pr_guardian', consequential: true, draftKind: 'pr_dispatch', approvalRole: 'manager', ackRoles: ['lead_engineer'], rationale: `${t.summary}. Only the reporter (${issue.reportedBy}) may approve this plan. No code is changed.`, target: `${plan.repository.name}/${issue.issueId}`, effectKey: `fix-plan-${plan.repository.name}-${issue.issueId}`, approver: { email: issue.reportedBy } });
    return o.done('Plan record drafted; only the reporter can approve it.');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'fix_plan_approval' || !ctx) return checks;
    const plan = ctx.baselinePlan as Plan; const issue = ctx.change as Issue; const t = triage(plan, issue, ctx.answers); const c = observed.content;
    checks.push({ name: 'target issue cited', passed: c.includes(issue.issueId), detail: issue.issueId });
    checks.push({ name: 'target branch main confirmed', passed: c.includes(`**Target branch**: ${plan.repository.defaultBranch}`), detail: `branch ${plan.repository.defaultBranch}` });
    checks.push({ name: 'severity matches an independent re-triage', passed: c.includes(`**Severity (heuristic)**: ${t.severity}`), detail: `expected ${t.severity}` });
    checks.push({ name: 'approver recorded is the reporter', passed: c.includes(`**Approved by**: ${issue.reportedBy}`), detail: issue.reportedBy });
    checks.push({ name: 'states that no code was changed or merged', passed: c.includes('No code was changed'), detail: 'honest scope statement present' });
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const t = triage(plan, ctx.change as Issue, ctx.answers);
    return [
      { key: 'ci_green', label: 'Continuous integration is passing', passed: plan.repository.ciTestPassing, detail: plan.repository.ciTestPassing ? 'CI reported passing in the repository spec.' : 'CI is reported failing.' },
      { key: 'not_duplicate', label: 'Issue is not an unresolved duplicate', passed: !t.duplicate, detail: t.duplicate ? `Possible duplicate of ${t.duplicate.issueId}` : 'No duplicate found.' },
    ];
  },
};
