import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import {
  autoTailor, critique, entryLabel, fingerprint, interviewPlan, normalizeJob, normalizeProfile,
  scoreFit, tailoringChanges, verifyTruth, type Fit, type Job, type Profile, type Tailored,
} from './career.js';

/**
 * OfferRoom pack: truth-guarded resume tailoring, honest fit scoring, critique and mock-interview planning for ONE candidate.
 * Inherited from OfferRoom (MIT, github.com/roshan62varma-bot/offerroom) and tightened to RIPPLE's rules:
 *  - the truth guard runs at drafting time AND is re-run by the verifier on the connector read-back;
 *  - only the candidate (named-approver gate) can approve a resume; a required human review is a blocking, assignee-only question
 *    bound to the exact resume version; the Mentor agent's sign-off is labelled ADVICE and is never a decision;
 *  - nothing is ever submitted to an employer (stated in every output).
 */
const entry = { bullets: z.array(z.string()).default([]) };
export const planSchema = z.object({
  profile: z.object({
    name: z.string().min(1), email: z.string().optional(), location: z.string().optional(),
    headline: z.string().default(''), summary: z.string().default(''),
    education: z.array(z.object({ id: z.string().optional(), school: z.string().min(1), degree: z.string().optional(), field: z.string().optional(), start: z.string().optional(), end: z.string().optional(), grade: z.string().optional(), coursework: z.array(z.string()).optional() })).default([]),
    experience: z.array(z.object({ id: z.string().optional(), company: z.string().min(1), role: z.string().min(1), type: z.string().optional(), start: z.string().optional(), end: z.string().optional(), ...entry })).default([]),
    projects: z.array(z.object({ id: z.string().optional(), name: z.string().min(1), tech: z.array(z.string()).default([]), link: z.string().optional(), ...entry })).default([]),
    skills: z.array(z.string()).default([]),
    achievements: z.array(z.string()).default([]),
    preferences: z.object({ roles: z.array(z.string()).default([]), locations: z.array(z.string()).default([]), remote_ok: z.boolean().default(true), relocate: z.boolean().optional(), level: z.enum(['intern', 'entry', 'mid', 'senior']).default('entry') }).default({ roles: [], locations: [], remote_ok: true, level: 'entry' }),
  }),
  roster: z.object({
    candidateEmail: z.string().min(3),
    reviewerEmails: z.array(z.string()).default([]),
    humanReview: z.enum(['off', 'optional', 'required']).default('optional'),
  }),
  pipeline: z.array(z.object({ jobId: z.string(), title: z.string(), company: z.string(), status: z.string() })).default([]),
});

const draftEntry = z.object({ id: z.string(), bullets: z.array(z.string()) });
export const changeSchema = z.object({
  jobId: z.string().min(1), title: z.string().min(1), company: z.string().min(1),
  url: z.string().optional(), source: z.string().optional(), postedAt: z.string().optional(),
  location: z.string().default(''), remote: z.boolean().default(false),
  level: z.enum(['intern', 'entry', 'mid', 'senior']).default('entry'), minYears: z.number().min(0).optional(),
  description: z.string().default(''), required: z.array(z.string()).optional(), preferred: z.array(z.string()).optional(),
  /** A resume written by an outside agent or person. It is NOT trusted: it must pass the truth guard. */
  tailoredDraft: z.object({ headline: z.string().optional(), summary: z.string().optional(), skills: z.array(z.string()).optional(), experience: z.array(draftEntry).optional(), projects: z.array(draftEntry).optional(), achievements: z.array(z.string()).optional() }).optional(),
  note: z.string().default(''),
});
type Plan = z.infer<typeof planSchema>;
type JobIn = z.infer<typeof changeSchema>;

const NOT_SUBMITTED = 'RIPPLE/OfferRoom never submits applications. The candidate applies on the employer\'s own site.';
const PAYLOAD_RE = /```json resume-payload\n([\s\S]*?)\n```/;

function prep(ctx: Pick<AnalysisContext, 'plan' | 'change' | 'today'>) {
  const profile = normalizeProfile((ctx.plan as Plan).profile);
  const job = normalizeJob(ctx.change as JobIn);
  return { profile, job, fit: scoreFit(profile, job, ctx.today) };
}
const bullets = (items: { id: string; bullets: string[] }[], p: Profile) => items.map((e) => `**${entryLabel(p, e.id)}**\n${e.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n');

function resumeMarkdown(p: Profile, t: Tailored, job: Job, fit: Fit) {
  const matched = fit.matched.slice(0, 3).join(', ') || 'the skills listed above';
  const top = t.projects[0] ? entryLabel(p, t.projects[0].id) : null;
  const cover = `Dear ${job.company} hiring team,\n\nI am applying for the ${job.title} role. I have worked with ${matched}${top ? `, for example in ${top}` : ''}. The details above are taken from my own profile.\n\nThank you for your time.\n${p.name}`;
  return [
    `# ${p.name}`, [p.email, p.location].filter(Boolean).join(' · '), '', `**${t.headline}**`, '', t.summary, '',
    `## Skills\n${t.skills.join(', ')}`, '', `## Experience\n${bullets(t.experience, p) || '_none listed_'}`, '', `## Projects\n${bullets(t.projects, p) || '_none listed_'}`, '',
    `## Achievements\n${t.achievements.map((a) => `- ${a}`).join('\n') || '_none listed_'}`, '',
    `## Education\n${p.education.map((e) => `- ${[e.degree, e.field].filter(Boolean).join(' ')}, ${e.school}`).join('\n') || '_none listed_'}`, '',
    `---\n### Cover note (draft)\n${cover}`, '',
    `> Tailored for **${job.title} @ ${job.company}**. Every claim was checked against the candidate's own approved profile by the truth guard. ${NOT_SUBMITTED}`, '',
    '```json resume-payload', JSON.stringify(t), '```',
  ].join('\n');
}

export const offerroomPack: WorkflowPack = {
  id: 'offerroom',
  name: 'OfferRoom',
  domain: 'Career & Talent Operations',
  version: '1.0.0',
  description: 'Truth-guarded resume tailoring for one candidate: explainable fit score, a truth guard that blocks invented skills/numbers, an independent critique, mock-interview plan, and a candidate-only approval gate. Never submits an application.',
  labels: { baseline: 'Candidate profile & room roster', change: 'Job posting', changeVerb: 'Evaluate job', plan: 'Candidate profile', mission: 'Job-hunt room', blurb: 'Scores a job honestly against your approved profile, tailors a resume that cannot invent anything, critiques it, and waits for YOUR approval.' },
  roles: [
    { key: 'scout', name: 'Scout', kind: 'agent', responsibility: 'Scores the role against the approved profile with an explainable fit report', department: 'Search' },
    { key: 'tailor', name: 'Tailor', kind: 'agent', responsibility: 'Builds a one-page resume and cover note from the profile only, and runs the truth guard', department: 'Applications' },
    { key: 'interviewer', name: 'Interviewer', kind: 'agent', responsibility: 'Critiques the resume like a real interviewer and prepares a role-specific mock interview', department: 'Preparation' },
    { key: 'mentor', name: 'Mentor', kind: 'agent', responsibility: 'Summarises readiness. Its sign-off is advice only, never a human decision', department: 'Coaching' },
    { key: 'candidate', name: 'Candidate', kind: 'human', responsibility: 'The only person who approves a resume, applies, or decides anything about their own job hunt', department: 'Personal' },
    { key: 'resume_reviewer', name: 'Human reviewer', kind: 'human', responsibility: 'Optional senior/friend who reviews the exact resume version', department: 'Personal' },
  ],
  roleOrder: ['scout', 'tailor', 'interviewer', 'mentor'],
  planSchema,
  changeSchema,
  artifacts: [
    { key: 'fit_report', label: 'Fit report', department: 'Search', ownerRole: 'scout', description: 'Explainable 0-100 fit with evidence, gaps and caps' },
    { key: 'resume', label: 'Tailored resume + cover note', department: 'Applications', ownerRole: 'tailor', description: 'Built only from the approved profile; truth guard result included' },
    { key: 'critique', label: 'Interviewer critique', department: 'Preparation', ownerRole: 'interviewer', description: 'Weak verbs, missing impact, hidden skills, questions to defend' },
    { key: 'interview_plan', label: 'Mock-interview plan', department: 'Preparation', ownerRole: 'interviewer', description: 'Role-specific questions with a transparent rubric' },
    { key: 'mentor_brief', label: 'Mentor readiness brief (advice only)', department: 'Coaching', ownerRole: 'mentor', description: 'Checklist of what is ready and what still needs a human' },
  ],
  rules: [
    { id: 'offer.posting', trigger: (i) => i.field === 'job.posting', to: 'fit_report', relation: 'scores_fit', why: 'A new posting must be scored against the approved profile' },
    { id: 'offer.draft', trigger: (i) => i.field === 'job.draft', to: 'resume', relation: 'must_pass_truth_guard', why: 'An externally written resume is untrusted until the truth guard passes' },
  ],
  artifactEdges: [
    { from: 'fit_report', to: 'resume', relation: 'decides_whether_to_tailor', why: 'Weak fits are not tailored without the candidate agreeing' },
    { from: 'resume', to: 'critique', relation: 'is_reviewed_by', why: 'A second opinion before the candidate sees it' },
    { from: 'resume', to: 'interview_plan', relation: 'prepares', why: 'Interview questions come from the same claims the resume makes' },
    { from: 'critique', to: 'mentor_brief', relation: 'summarised_in', why: 'Mentor reports readiness' },
  ],
  decisions: [{ key: 'approve_resume', label: 'Candidate approves the resume for this role', ownerRole: 'candidate', gates: ['resume'] }],

  sample() {
    return {
      title: 'Aanya Rao: Backend Engineer Intern @ Lumen Labs',
      plan: {
        profile: {
          name: 'Aanya Rao', email: 'aanya.rao.dev@example.com', location: 'Bengaluru, India',
          headline: 'Backend-leaning full-stack developer · final-year CS',
          summary: 'Final-year CS student who likes building APIs and shipping small products end to end.',
          education: [{ school: 'Example Institute of Technology, Bengaluru', degree: 'B.Tech', field: 'Computer Science', start: 'Aug 2022', end: 'May 2026', coursework: ['Data Structures', 'DBMS', 'Operating Systems', 'Computer Networks'] }],
          experience: [{ company: 'Campus Placement Cell', role: 'Student Developer (part-time)', start: 'Jan 2025', end: 'Jun 2025', bullets: ['Built a Flask + PostgreSQL portal used by 1,200 students to register for placement drives', 'Cut report generation time from 40 minutes to 3 minutes by moving Excel exports to SQL queries', 'Wrote unit tests with Pytest for the eligibility rules engine'] }],
          projects: [
            { name: 'QueueLess', tech: ['Python', 'FastAPI', 'Redis', 'Docker'], bullets: ['Built a FastAPI service that issues virtual tokens for canteen queues, with Redis for live queue state', 'Containerized the API and Redis with Docker Compose for one-command local setup', 'Handled 300 concurrent users in a load test with Locust after adding connection pooling'] },
            { name: 'StudySync', tech: ['React', 'Node.js', 'MongoDB'], bullets: ['Built a React + Node.js app where study groups share notes and schedule sessions', 'Designed MongoDB schemas for groups, notes and invites with role-based access', 'Added real-time updates with WebSockets so new notes appear instantly'] },
            { name: 'PaperTrail', tech: ['Python', 'LLMs', 'RAG'], bullets: ['Built a RAG chatbot that answers questions over 50 past exam papers with source citations', 'Evaluated answer accuracy on 40 hand-written questions and fixed retrieval misses'] },
          ],
          skills: ['Python', 'Java', 'JavaScript', 'SQL', 'FastAPI', 'Flask', 'React', 'Node.js', 'PostgreSQL', 'MongoDB', 'Redis', 'Docker', 'Git', 'Linux', 'Data Structures', 'REST APIs', 'Pytest'],
          achievements: ['Top 10 of 240 teams at Smart India Hackathon internal round 2024', 'Solved 350+ problems on LeetCode', 'Organized a 3-day Git and open-source workshop for 80 juniors'],
          preferences: { roles: ['backend intern', 'software engineer intern', 'SDE-1'], locations: ['Bengaluru', 'Remote'], remote_ok: true, level: 'intern' },
        },
        roster: { candidateEmail: 'mia@harborvine.example', reviewerEmails: ['ben@harborvine.example'], humanReview: 'optional' },
        pipeline: [],
      },
      change: {
        jobId: 'lumen-backend-intern', title: 'Backend Engineer Intern', company: 'Lumen Labs', location: 'Bengaluru', remote: false, level: 'intern', source: 'pasted link',
        description: 'Requirements: Python, FastAPI, PostgreSQL, Docker, REST APIs, Git. Nice to have: Redis, Kubernetes, CI/CD.',
      },
    };
  },

  detectChanges(plan: Plan, job: JobIn): ChangeItem[] {
    const items: ChangeItem[] = [{ field: 'job.posting', label: `New role to evaluate: ${job.title} @ ${job.company}`, before: `${plan.pipeline.length} tracked`, after: `${plan.pipeline.length + (plan.pipeline.some((p) => p.jobId === job.jobId) ? 0 : 1)} tracked`, kind: 'added', severity: 'medium', note: job.note || `Source: ${job.source ?? 'not stated'}` }];
    if (job.tailoredDraft) items.push({ field: 'job.draft', label: 'Externally written resume draft submitted (untrusted until the truth guard passes)', before: 'none', after: 'draft', kind: 'added', severity: 'high' });
    return items;
  },
  applyChange(plan: Plan, job: JobIn): Plan {
    const next = structuredClone(plan);
    if (!next.pipeline.some((p) => p.jobId === job.jobId)) next.pipeline.push({ jobId: job.jobId, title: job.title, company: job.company, status: 'found' });
    return next;
  },

  parseAnswer(key, text) {
    const t = text.trim();
    if (key === 'low_fit_proceed') { if (/^(y|yes|proceed|tailor)\b/i.test(t)) return { value: true }; if (/^(n|no|skip|decline)\b/i.test(t)) return { value: false }; return { error: 'Reply "yes" to tailor anyway or "no" to skip this role.' }; }
    if (key.startsWith('truth_')) { if (/\b(remove|drop|discard|strip)\b/i.test(t)) return { value: 'remove' }; return { error: 'Reply "remove" to drop the unsupported claims, or add the true facts to the profile and resubmit the job.' }; }
    if (key.startsWith('review_')) {
      if (/^(approve|approved|lgtm|looks good)\b/i.test(t)) return { value: { decision: 'approve', note: t } };
      const m = /^(?:changes?|reject(?:ed)?|needs changes)\b[:,\s-]*(.*)$/i.exec(t);
      if (m) return { value: { decision: 'changes', note: m[1] || t } };
      return { error: 'Reply "approve" or "changes: <what to fix>".' };
    }
    return { value: t };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const plan = ctx.plan as Plan;
    const { profile, job, fit } = prep(ctx);
    const change = ctx.change as JobIn;
    const A = 'offerroom-analyzer';

    if (role === 'scout') {
      const o = new Out(role, `${A}-scout@1`);
      const dup = plan.pipeline.find((p) => p.jobId === change.jobId);
      if (dup) o.warn(`This role is already tracked (status "${dup.status}"). Re-scoring against the current profile.`);
      if (!job.required.length) o.warn('No recognisable required skills in the posting: the skill score is neutral, so treat this fit as low-confidence.', true);
      o.info(`${fit.score}% fit: ${fit.verdict}.`);
      if (fit.missing.length) o.warn(`Missing required skills: ${fit.missing.join(', ')}.`);
      for (const c of fit.cappedBy) o.warn(`Score capped: ${c}.`);
      const proceed = ctx.answers.low_fit_proceed?.value;
      if (fit.score < 60 && proceed === undefined) o.ask({ key: 'low_fit_proceed', text: `Fit for ${job.title} @ ${job.company} is ${fit.score}% (${fit.verdict}). Tailor a resume anyway? Reply "yes" or "no".`, blocking: true, assigneeRole: 'candidate' });
      o.data = { fit, job };
      const rows = [['Dimension', 'Score', 'Why'], ['Required skills (45%)', `${fit.breakdown.required}%`, `${fit.matched.length} of ${job.required.length || 0} matched`], ['Nice-to-haves (10%)', `${fit.breakdown.preferred}%`, `${fit.matchedPreferred.length} matched`], ['Role (15%)', `${fit.breakdown.role}%`, fit.roleNote], ['Seniority (20%)', `${fit.breakdown.level}%`, fit.levelNote], ['Location (10%)', `${fit.breakdown.location}%`, fit.locationNote]];
      o.draft({
        kind: 'fit_report', name: `Fit report: ${job.title} @ ${job.company}`, artifactKey: 'fit_report',
        content: `# ${fit.score}% fit: ${job.title} @ ${job.company}\n**${fit.verdict}**\n\n${table(rows[0], rows.slice(1))}\n\n- Matches: ${fit.matched.join(', ') || 'none of the required skills'}\n- Bonus skills you have: ${fit.matchedPreferred.join(', ') || 'none'}\n- Missing (required): ${fit.missing.join(', ') || 'none'}\n- Missing (nice to have): ${fit.missingPreferred.join(', ') || 'none'}\n${Object.entries(fit.evidence).slice(0, 5).map(([s, w]) => `- ${s}: shown in ${w.join(', ')}`).join('\n')}\n${fit.proveIt.map((x) => `- Prove it: ${x}`).join('\n')}\n${fit.gaps.slice(0, 3).map((g) => `- Close the gap (${g.skill}): ${g.plan}`).join('\n')}\n${fit.cappedBy.length ? `\n> Score capped: ${fit.cappedBy.join('; ')}` : ''}\n\n_Scored by a transparent keyword-and-evidence model, not a judgement of you._`,
      });
      return o.done(`Fit ${fit.score}% (${fit.verdict}).`);
    }

    if (role === 'tailor') {
      const o = new Out(role, `${A}-tailor@1`);
      const proceed = ctx.answers.low_fit_proceed?.value;
      if (fit.score < 60 && proceed !== true) { o.info(proceed === false ? 'The candidate declined to tailor for a weak fit. No resume drafted.' : 'Fit is below 60%: waiting for the candidate to decide whether to tailor anyway.'); return o.done('No resume drafted (fit below 60% and not approved by the candidate).'); }
      const removed = Object.entries(ctx.answers).some(([k, a]) => k.startsWith('truth_') && a.value === 'remove');
      const d = change.tailoredDraft;
      let tailored: Tailored; let source: string;
      if (d && !removed) { tailored = { headline: d.headline ?? profile.headline, summary: d.summary ?? '', skills: d.skills ?? [], experience: d.experience ?? [], projects: d.projects ?? [], achievements: d.achievements ?? [] }; source = 'externally written draft (untrusted, truth-guarded)'; }
      else { tailored = autoTailor(profile, job); source = removed ? 'deterministic auto-tailor (unsupported claims removed at the candidate\'s request)' : 'deterministic auto-tailor from the approved profile'; }
      const issues = verifyTruth(tailored, profile);
      const blocks = issues.filter((i) => i.severity === 'block');
      if (blocks.length) {
        const fp = fingerprint(blocks.map((b) => `${b.path}|${b.message}`).sort().join('\n'));
        o.risk(`TRUTH GUARD BLOCKED ${blocks.length} claim(s) in the ${source}. No resume is produced.`);
        for (const b of blocks.slice(0, 8)) o.risk(`${b.path}: ${b.message}`);
        o.ask({ key: `truth_${fp}`, text: `The truth guard blocked ${blocks.length} claim(s): ${blocks.slice(0, 3).map((b) => b.message).join(' | ')}. Reply "remove" to drop them and use the deterministic tailor, or add the true facts to your profile and resubmit.`, blocking: true, assigneeRole: 'candidate' });
        o.data = { blocked: true };
        return o.done(`Truth guard blocked ${blocks.length} unsupported claim(s); waiting for the candidate.`);
      }
      for (const w of issues.filter((i) => i.severity === 'warn')) o.warn(`${w.path}: ${w.message}`);
      const changes = tailoringChanges(tailored, profile);
      o.info(`Truth guard passed (0 blocking issues). Source: ${source}.`);
      for (const c of changes) o.info(c);
      o.data = { tailored, fit, job, source };
      o.draft({ kind: 'resume', name: `Resume: ${job.title} @ ${job.company}`, artifactKey: 'resume', content: resumeMarkdown(profile, tailored, job, fit) });
      return o.done(`Resume built from the profile and truth-guarded (${source}).`);
    }

    if (role === 'interviewer') {
      const o = new Out(role, `${A}-interviewer@1`);
      const tailored = ctx.results.tailor?.data?.tailored as Tailored | undefined;
      if (!tailored) return o.done('No resume to critique yet.');
      const c = critique(tailored, profile, job);
      o.info(`Resume strength ${c.strength}/100 (${c.findings.length} finding(s)).`);
      for (const f of c.topFixes) o.warn(`${f.kind}: ${f.where}${f.bullet ? ` "${f.bullet.slice(0, 80)}"` : ''}: ${f.fix}`, f.kind === 'no_impact');
      const needNumbers = c.findings.filter((f) => f.kind === 'no_impact').length;
      if (needNumbers) {
        o.warn(`${needNumbers} bullet(s) have no number. Add one ONLY if you have a real figure; never guess.`, true);
        o.work({ key: 'add-real-numbers', title: `Add real numbers to ${needNumbers} resume bullet(s) (only true ones)`, detail: 'Update your profile with genuine figures, then resubmit the job so the truth guard re-checks them.', department: 'Applications', roleKey: 'candidate', kind: 'task', artifactKey: 'resume' });
      }
      o.data = { critique: c };
      o.draft({ kind: 'critique', name: `Interviewer critique: ${job.title}`, artifactKey: 'critique', content: `# Resume critique (strength ${c.strength}/100)\n\n${c.findings.length ? table(['Kind', 'Where', 'Fix'], c.findings.slice(0, 12).map((f) => [f.kind, f.where, f.fix])) : 'No findings.'}\n\n## Be ready to defend\n${c.defend.map((d) => `- (${d.skill}, ${d.where}) ${d.question}`).join('\n') || '_nothing flagged_'}` });
      const qs = interviewPlan(profile, job, fit);
      o.work({ key: 'practice-mock', title: `Practise the ${qs.length}-question mock interview for ${job.company}`, detail: qs.map((q) => `${q.id} [${q.kind}] ${q.question}`).join(' | '), department: 'Preparation', roleKey: 'candidate', kind: 'task', artifactKey: 'interview_plan' });
      o.draft({ kind: 'interview_plan', name: `Mock interview plan: ${job.title} @ ${job.company}`, artifactKey: 'interview_plan', content: `# Mock interview: ${job.title} @ ${job.company}\n\n${qs.map((q) => `${q.id}. [${q.kind}] ${q.question}`).join('\n')}\n\nAnswers are graded on a transparent rubric: relevance 40%, structure 25%, specificity 20%, length 15%. This plan comes from the posting and your own projects; it is not a prediction of what you will be asked.` });
      return o.done(`Critique done (strength ${c.strength}); ${qs.length} mock-interview questions prepared.`);
    }

    // mentor
    const o = new Out(role, `${A}-mentor@1`);
    const tailored = ctx.results.tailor?.data?.tailored as Tailored | undefined;
    const c = ctx.results.interviewer?.data?.critique as { strength: number } | undefined;
    if (!tailored) return o.done('Mentor: nothing is ready for the candidate yet.');
    const resumeFp = fingerprint(JSON.stringify(tailored));
    const mode = plan.roster.humanReview;
    const reviewers = plan.roster.reviewerEmails;
    const reviewKey = `review_${resumeFp}`;
    const review = ctx.answers[reviewKey]?.value as { decision: string; note: string } | undefined;
    const checklist: [string, boolean, string][] = [
      ['Fit ≥ 60% or candidate agreed', fit.score >= 60 || ctx.answers.low_fit_proceed?.value === true, `${fit.score}%`],
      ['Truth guard passed', true, '0 blocking issues'],
      ['Critique strength ≥ 70', (c?.strength ?? 0) >= 70, `${c?.strength ?? 'n/a'}/100`],
      ['Human review', mode === 'off' || mode === 'optional' || review?.decision === 'approve', mode === 'required' ? (review ? review.decision : 'pending') : mode],
    ];
    let blocked = false;
    if (mode === 'required') {
      if (!reviewers.length) { o.risk('Human review is REQUIRED but no reviewer is registered in the roster. No action is proposed.'); blocked = true; }
      else if (!review) { o.ask({ key: reviewKey, text: `Review this exact resume version for ${job.title} @ ${job.company}. Reply "approve" or "changes: <what to fix>".`, blocking: true, assigneeRole: 'resume_reviewer', assigneeOnly: true }); o.info('Waiting for the human reviewer. The candidate cannot approve until they decide.'); blocked = true; }
      else if (review.decision !== 'approve') { o.warn(`Human reviewer asked for changes: ${review.note}`, true); blocked = true; }
      else o.info('Human reviewer approved this exact resume version.');
    } else if (mode === 'optional' && reviewers.length) o.work({ key: 'optional-review', title: `Optional: ask a human reviewer to look at the ${job.company} resume`, detail: 'Reviewer is optional for this room.', department: 'Personal', roleKey: 'resume_reviewer', kind: 'task', artifactKey: 'resume' });
    o.draft({ kind: 'mentor_brief', name: `Mentor brief: ${job.title} @ ${job.company}`, artifactKey: 'mentor_brief', content: `# Mentor readiness brief (ADVICE ONLY)\n\n> A Mentor sign-off is advice. It is never a human decision: only the candidate approves, and only a registered human reviewer reviews.\n\n${table(['Check', 'OK', 'Detail'], checklist.map(([a, ok, d]) => [a, ok ? 'yes' : 'no', d]))}\n\n${NOT_SUBMITTED}` });
    o.data = { resumeFp };
    if (blocked) return o.done('Mentor: not ready. A human step is still outstanding; no approval has been requested.');
    o.act({
      key: 'act-release-resume', type: 'resume_release', title: `Release approved resume pack: ${job.title} @ ${job.company}`, connector: 'document_store',
      ownerRole: 'tailor', consequential: true, draftKind: 'resume', approvalRole: 'manager', ackRoles: ['candidate'],
      rationale: `Truth-guarded resume for ${job.title} @ ${job.company} (fit ${fit.score}%). Only the candidate may approve. This stores the document locally; it does NOT apply to the job.`,
      target: `candidate/${change.jobId}`, effectKey: `resume-${change.jobId}-${resumeFp}`, approver: { role: 'candidate' },
    });
    return o.done('Mentor: ready for the candidate\'s decision (advice only).');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'resume_release') return checks;
    const m = PAYLOAD_RE.exec(observed.content);
    let tailored: Tailored | null;
    try { tailored = m ? (JSON.parse(m[1]) as Tailored) : null; } catch { tailored = null; }
    checks.push({ name: 'resume payload present in read-back', passed: !!tailored, detail: tailored ? 'structured resume payload found in the stored document' : 'no parsable resume payload in the stored document' });
    if (tailored && ctx) {
      const profile = normalizeProfile((ctx.baselinePlan as Plan).profile);
      const blocks = verifyTruth(tailored, profile).filter((i) => i.severity === 'block');
      checks.push({ name: 'truth guard re-run on the stored document', passed: blocks.length === 0, detail: blocks.length ? blocks.slice(0, 3).map((b) => `${b.path}: ${b.message}`).join('; ') : 'every skill, number and bullet in the stored resume traces to the approved profile' });
    }
    const job = ctx?.change as JobIn | undefined;
    if (job) checks.push({ name: 'stored resume names the right role', passed: observed.content.includes(job.title) && observed.content.includes(job.company), detail: `${job.title} @ ${job.company}` });
    const claimsSubmitted = /\b(?:application|resume) (?:was |has been )?submitted\b/i.test(observed.content.replace(NOT_SUBMITTED, ''));
    checks.push({ name: 'does not claim an application was submitted', passed: observed.content.includes('never submits applications') && !claimsSubmitted, detail: 'disclaimer present; no "submitted" claim' });
    return checks;
  },

  completionChecks(ctx) {
    const plan = ctx.baselinePlan as Plan; const job = ctx.change as JobIn;
    const { fit } = prep({ plan, change: job, today: ctx.today });
    const review = Object.entries(ctx.answers).find(([k]) => k.startsWith('review_'))?.[1]?.value as { decision: string } | undefined;
    return [
      { key: 'job_tracked', label: 'Role is tracked in the candidate pipeline', passed: (ctx.revisedPlan as Plan).pipeline.some((p) => p.jobId === job.jobId), detail: `${job.title} @ ${job.company}` },
      { key: 'fit_decision', label: 'Weak fit explicitly accepted by the candidate (or fit ≥ 60%)', passed: fit.score >= 60 || ctx.answers.low_fit_proceed?.value === true, detail: `fit ${fit.score}%` },
      { key: 'human_review', label: 'Required human review recorded for this resume', passed: plan.roster.humanReview !== 'required' || review?.decision === 'approve', detail: plan.roster.humanReview === 'required' ? (review ? `reviewer: ${review.decision}` : 'no review recorded') : `review mode: ${plan.roster.humanReview}` },
    ];
  },
};
