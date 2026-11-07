import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

/**
 * Event-day run of show (session 18). One reported change (for example, a keynote speaker arriving late) is checked against
 * the day: venue hours, the crew's departure time, room and speaker overlaps, and each speaker's RECORDED availability.
 * Deterministic and pack-local; the engine is unchanged.
 *  - A speaker with no recorded availability is never assumed free. A moved speaker's own approval confirms the new time.
 *  - Candidate fixes are tested on the WHOLE schedule. A fixed session is never moved. The smallest valid fix is proposed.
 *  - The schedule changes only after every affected owner approves (each answer is bound to the exact fix shown, by hash).
 *  - Only the lead planner can publish. The revision is written to the local outbox: nothing is sent to chat or email.
 * Agents propose and check; people decide. The Switch/Mattermost room that carries this conversation is NOT part of this pack.
 */

const HM = z.string().regex(/^\d{2}:\d{2}$/, 'use 24-hour HH:MM');
const session = z.object({
  key: z.string().min(1), title: z.string().min(1), room: z.string().min(1),
  start: HM, end: HM, fixed: z.boolean().default(false), personKey: z.string().min(1).nullable().default(null),
});
const person = z.object({ key: z.string().min(1), name: z.string().min(1), roleKey: z.string().min(1), availableFrom: HM.nullable().default(null) });
export const planSchema = z.object({
  event: z.object({ name: z.string().min(1), date: z.string().min(8), venueOpens: HM, venueCloses: HM, crewLeaves: HM }),
  people: z.array(person),
  sessions: z.array(session).min(1),
});
export const changeSchema = z.object({
  reportedBy: z.string().min(1),
  availability: z.array(z.object({ personKey: z.string().min(1), availableFrom: HM })).default([]),
  note: z.string().default(''),
});
export type Plan = z.infer<typeof planSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Session = Plan['sessions'][number];

const ANALYST = 'ev_analyst';
const PUBLISHER = 'ev_publisher';
const LEAD = 'ev_lead_planner';
const VENUE = 'ev_venue_av';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const minutes = (s: Session) => toMin(s.end) - toMin(s.start);
const personOf = (plan: Plan, key: string | null) => (key ? plan.people.find((p) => p.key === key) : undefined);
const ownerRole = (plan: Plan, sessionKey: string) => personOf(plan, plan.sessions.find((s) => s.key === sessionKey)?.personKey ?? null)?.roleKey;
export const qkey = (hash: string, roleKey: string) => `ev_decide_${hash}_${roleKey}`;

export interface Violation { rule: 'order' | 'hours' | 'crew' | 'availability' | 'room' | 'double-booked'; sessionKey: string; text: string }
/** Pure check of a whole schedule. Used by the analyzer, the verifier and the completion check alike. */
export function checkPlan(plan: Plan): Violation[] {
  const out: Violation[] = [];
  const opens = toMin(plan.event.venueOpens), closes = toMin(plan.event.venueCloses), crew = toMin(plan.event.crewLeaves);
  for (const s of plan.sessions) {
    if (toMin(s.end) <= toMin(s.start)) out.push({ rule: 'order', sessionKey: s.key, text: `${s.title} ends at or before its start` });
    if (toMin(s.start) < opens || toMin(s.end) > closes) out.push({ rule: 'hours', sessionKey: s.key, text: `${s.title} (${s.start}–${s.end}) is outside venue hours ${plan.event.venueOpens}–${plan.event.venueCloses}` });
    if (toMin(s.end) > crew) out.push({ rule: 'crew', sessionKey: s.key, text: `${s.title} runs to ${s.end}, after the crew leaves at ${plan.event.crewLeaves}` });
    const p = personOf(plan, s.personKey);
    if (p?.availableFrom && toMin(s.start) < toMin(p.availableFrom)) out.push({ rule: 'availability', sessionKey: s.key, text: `${p.name} is recorded as available from ${p.availableFrom}, but ${s.title} starts at ${s.start}` });
  }
  for (let i = 0; i < plan.sessions.length; i++) for (let j = i + 1; j < plan.sessions.length; j++) {
    const a = plan.sessions[i], b = plan.sessions[j];
    if (!(toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end))) continue;
    if (a.room === b.room) out.push({ rule: 'room', sessionKey: b.key, text: `${a.title} and ${b.title} overlap in ${a.room}` });
    if (a.personKey && a.personKey === b.personKey) out.push({ rule: 'double-booked', sessionKey: b.key, text: `${personOf(plan, a.personKey)?.name ?? a.personKey} is booked for ${a.title} and ${b.title} at once` });
  }
  return out;
}

/** The reported availability, and nothing else. Fixes are separate. */
function withAvailability(plan: Plan, change: Change): Plan {
  const p = structuredClone(plan);
  for (const a of change.availability) { const person = p.people.find((x) => x.key === a.personKey); if (person) person.availableFrom = a.availableFrom; }
  return p;
}

export interface FixOption { key: string; label: string; moved: string[]; sessions: Session[]; violations: Violation[]; valid: boolean }
/** Candidate fixes for one violated session. A fixed session yields no options. Every option is tested on the whole day. */
export function fixOptions(base: Plan, target: Session): FixOption[] {
  if (target.fixed) return [];
  const out: FixOption[] = [];
  const add = (key: string, label: string, sessions: Session[], moved: string[]) => {
    const violations = checkPlan({ ...base, sessions });
    out.push({ key, label, moved, sessions, violations, valid: violations.length === 0 });
  };
  // Swap start times with an unfixed session of exactly the same length (only those two sessions move).
  for (const other of base.sessions) {
    if (other.key === target.key || other.fixed || minutes(other) !== minutes(target)) continue;
    const sessions = base.sessions.map((s) => s.key === target.key ? { ...s, start: other.start, end: other.end } : s.key === other.key ? { ...s, start: target.start, end: target.end } : s);
    add(`swap:${target.key}:${other.key}`, `Swap ${target.title} with ${other.title}`, sessions, [target.key, other.key]);
  }
  // Move the target to just after a fixed block, and move every later unfixed session by the same amount.
  const oldEnd = toMin(target.end), d = minutes(target);
  const anchors = [...new Set(base.sessions.filter((s) => s.fixed).map((s) => toMin(s.end)))].sort((a, b) => a - b);
  const availableFrom = personOf(base, target.personKey)?.availableFrom;
  for (const T of anchors) {
    if (T < toMin(base.event.venueOpens) || (availableFrom && T < toMin(availableFrom))) continue;
    const delta = T + d - oldEnd;
    const moved = [target.key];
    const sessions = base.sessions.map((s) => {
      if (s.key === target.key) return { ...s, start: fromMin(T), end: fromMin(T + d) };
      if (!s.fixed && toMin(s.start) >= oldEnd) { moved.push(s.key); return { ...s, start: fromMin(toMin(s.start) + delta), end: fromMin(toMin(s.end) + delta) }; }
      return s;
    });
    add(`later:${target.key}:${fromMin(T)}`, `Move ${target.title} to ${fromMin(T)} and move later sessions ${delta} min`, sessions, moved);
  }
  return out;
}

export interface Evaluation {
  state: 'consistent' | 'unknown_person' | 'no_fix' | 'pending' | 'declined' | 'approved';
  unknown: string[]; violations: Violation[]; options: FixOption[]; chosen: FixOption | null;
  hash: string | null; affected: string[]; declinedBy: string[];
}
/** The whole decision state, recomputed from the stored plan, change and answers. Nothing here is taken from a model. */
export function evaluate(planIn: unknown, changeIn: unknown, answers: AnalysisContext['answers'] = {}): Evaluation {
  const plan = planSchema.parse(planIn); const change = changeSchema.parse(changeIn);
  const base = withAvailability(plan, change);
  const unknown = change.availability.filter((a) => !base.people.some((p) => p.key === a.personKey)).map((a) => a.personKey);
  const violations = checkPlan(base);
  const none = { unknown, violations, options: [] as FixOption[], chosen: null as FixOption | null, hash: null as string | null, affected: [] as string[], declinedBy: [] as string[] };
  if (unknown.length) return { ...none, state: 'unknown_person' };
  if (violations.length === 0) return { ...none, state: 'consistent' };
  const target = base.sessions.find((s) => violations.some((v) => v.sessionKey === s.key));
  const options = target ? fixOptions(base, target) : [];
  const chosen = [...options.filter((o) => o.valid)].sort((a, b) => a.moved.length - b.moved.length)[0] ?? null;
  if (!chosen) return { ...none, options, state: 'no_fix' };
  const hash = createHash('sha256').update(JSON.stringify(chosen.sessions.map((s) => [s.key, s.start, s.end]))).digest('hex').slice(0, 8);
  const affected = [...new Set([...chosen.moved.map((k) => ownerRole(base, k)).filter((x): x is string => !!x), VENUE])];
  const declinedBy = affected.filter((r) => answers[qkey(hash, r)]?.value === 'decline');
  const state: Evaluation['state'] = declinedBy.length ? 'declined' : affected.every((r) => answers[qkey(hash, r)]?.value === 'approve') ? 'approved' : 'pending';
  return { state, unknown, violations, options, chosen, hash, affected, declinedBy };
}

const STATE_LABEL: Record<Evaluation['state'], string> = {
  consistent: 'no change needed', unknown_person: 'availability reported for a person not on the plan', no_fix: 'no checked fix',
  pending: 'fix proposed; waiting for affected owners', declined: 'declined by an affected owner', approved: 'approved by every affected owner',
};

export const runOfShowPack: WorkflowPack = {
  tier: 'extended', system: 'commerce',
  id: 'run-of-show',
  name: 'Run of Show',
  domain: 'Event Operations',
  version: '1.0.0',
  description: 'Event-day run of show: one reported change (for example, a late speaker) is checked against venue hours, crew departure, rooms and recorded availability. The smallest checked fix is proposed. Only the affected owners decide, and only the lead planner publishes.',
  labels: { baseline: 'Approved Run of Show', change: 'Day-of Report', changeVerb: 'Report Change', plan: 'Run of Show', mission: 'Run-of-Show Revision', blurb: 'Checks a day-of change against the whole schedule, proposes the smallest fix that passes, and changes nothing until every affected owner approves. The lead planner publishes to the local outbox.' },
  roles: [
    { key: ANALYST, name: 'Run-of-Show Analyst', kind: 'agent', responsibility: 'Checks the reported change against venue hours, crew departure, rooms and recorded availability; tests candidate fixes on the whole day and names the owners whose sessions move', department: 'Event Management', scope: 'read' },
    { key: PUBLISHER, name: 'Run-of-Show Publisher', kind: 'agent', responsibility: 'Drafts revision 2 only after every affected owner approves; never publishes on its own', department: 'Event Management' },
    { key: LEAD, name: 'Lead Planner', kind: 'human', responsibility: 'Publishes the revision and decides when no checked fix exists', department: 'Event Management' },
    { key: 'ev_speaker_keynote', name: 'Keynote Speaker', kind: 'human', responsibility: 'Confirms the new time for their own session, or declines with a reason', department: 'Speakers' },
    { key: 'ev_panel_lead', name: 'Panel Lead', kind: 'human', responsibility: 'Confirms that the panelists can attend a moved panel slot, or declines with a reason', department: 'Program' },
    { key: VENUE, name: 'Venue & AV Lead', kind: 'human', responsibility: 'Confirms room and AV setup for any moved session', department: 'Venue' },
  ],
  roleOrder: [ANALYST, PUBLISHER],
  planSchema, changeSchema,
  artifacts: [
    { key: 'availability_check', label: 'Availability & constraint check', department: 'Event Management', ownerRole: ANALYST, description: 'The reported change tested against venue hours, crew departure, rooms and recorded availability' },
    { key: 'fix_proposal', label: 'Fix options tested on the whole day', department: 'Event Management', ownerRole: ANALYST, description: 'Every candidate fix with the rule it passes or breaks; the smallest valid fix is proposed' },
    { key: 'run_of_show_v2', label: 'Revision 2 (local outbox)', department: 'Event Management', ownerRole: PUBLISHER, description: 'Drafted only after every affected owner approves; publishing needs the lead planner' },
  ],
  rules: [],
  artifactEdges: [
    { from: 'availability_check', to: 'fix_proposal', relation: 'drives', why: 'A failed check is the only reason a fix is proposed' },
    { from: 'fix_proposal', to: 'run_of_show_v2', relation: 'gates', why: 'The revision is drafted only after every affected owner approves the fix' },
  ],
  decisions: [{ key: 'fix_decisions', label: 'Each affected owner approves their own session; the lead planner publishes', ownerRole: LEAD, gates: ['run_of_show_v2'] }],

  sample() {
    return {
      title: 'Fieldwork Forum: keynote speaker arrives at 11:45',
      plan: {
        event: { name: 'Fieldwork Forum', date: '2026-12-05', venueOpens: '10:30', venueCloses: '17:30', crewLeaves: '17:00' },
        people: [
          { key: 'maya', name: 'Maya Chen (keynote)', roleKey: 'ev_speaker_keynote', availableFrom: null },
          { key: 'jamie', name: 'Jamie (panel lead)', roleKey: 'ev_panel_lead', availableFrom: null },
        ],
        sessions: [
          { key: 'doors', title: 'Doors & registration', room: 'Lobby', start: '10:30', end: '11:00', fixed: true, personKey: null },
          { key: 'keynote', title: 'Opening keynote', room: 'Main hall', start: '11:15', end: '12:00', fixed: false, personKey: 'maya' },
          { key: 'lunch', title: 'Lunch', room: 'Atrium', start: '12:00', end: '13:00', fixed: true, personKey: null },
          { key: 'workshop', title: 'Builders workshop', room: 'Studio', start: '13:00', end: '14:30', fixed: false, personKey: null },
          { key: 'panel', title: "Builders' panel", room: 'Main hall', start: '14:30', end: '15:15', fixed: false, personKey: 'jamie' },
          { key: 'breakdown', title: 'Breakdown', room: 'Main hall', start: '15:30', end: '17:00', fixed: false, personKey: null },
        ],
      },
      change: {
        reportedBy: 'maya@harborvine.example',
        availability: [{ personKey: 'maya', availableFrom: '11:45' }],
        note: 'The flight into SFO is late. The speaker reaches the venue about 11:45.',
      },
    };
  },

  detectChanges(plan: Plan, change: Change): ChangeItem[] {
    const P = planSchema.parse(plan), C = changeSchema.parse(change);
    const e = evaluate(P, C, {});
    return C.availability.map((a) => {
      const person = personOf(P, a.personKey);
      const hit = e.violations.some((v) => P.sessions.find((s) => s.key === v.sessionKey)?.personKey === a.personKey);
      return {
        field: `people.${a.personKey}.availableFrom`,
        label: `${person?.name ?? a.personKey} available from ${a.availableFrom}`,
        before: person?.availableFrom ?? 'not recorded', after: a.availableFrom,
        kind: person?.availableFrom ? 'modified' : 'added', severity: hit ? 'high' : 'low',
        note: hit ? 'Conflicts with a session on the day' : undefined,
      } as ChangeItem;
    });
  },

  // Availability is applied on every revision. The schedule changes only when the approved fix is the one shown (same hash).
  applyChange(plan: Plan, change: Change, answers: AnalysisContext['answers']): Plan {
    const e = evaluate(plan, change, answers);
    const next = withAvailability(planSchema.parse(plan), changeSchema.parse(change));
    if (e.state === 'approved' && e.chosen) next.sessions = e.chosen.sessions;
    return next;
  },

  parseAnswer(key, text) {
    const t = text.trim();
    if (key.startsWith('ev_decide_')) {
      if (/^approve\b/i.test(t)) return { value: 'approve' };
      if (/^decline\b/i.test(t)) {
        const reason = t.replace(/^decline\b[:\s-]*/i, '').trim();
        return reason.length >= 3 ? { value: 'decline' } : { error: 'Reply "decline" with a short reason, so the planner knows what to change.' };
      }
      return { error: 'Reply "approve", or "decline" with a reason.' };
    }
    if (key === 'ev_no_fix') return t ? { value: t } : { error: 'Describe how the planner wants to handle this change.' };
    return { value: t };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const A = 'runofshow-analyzer';
    const plan = planSchema.parse(ctx.plan); const change = changeSchema.parse(ctx.change);
    const e = evaluate(plan, change, ctx.answers);
    const nameOf = (roleKey: string) => plan.people.find((p) => p.roleKey === roleKey)?.name ?? (roleKey === VENUE ? 'Venue & AV Lead' : roleKey);

    if (role === ANALYST) {
      const o = new Out(role, `${A}-feasibility@1`);
      const reported = change.availability.map((a) => `${personOf(plan, a.personKey)?.name ?? a.personKey} from ${a.availableFrom}`).join('; ') || 'none';
      if (e.state === 'consistent') o.info('Every recorded availability and the venue, crew, room and speaker constraints still hold. No change is needed.');
      if (e.state === 'unknown_person') o.risk(`Availability was reported for a person who is not on this plan: ${e.unknown.join(', ')}. Nothing was changed.`);
      if (e.state === 'pending' || e.state === 'no_fix' || e.state === 'declined') for (const v of e.violations) o.risk(v.text);
      if (e.state === 'approved' && e.chosen) o.info(`Resolved by the approved fix: ${e.chosen.label}. Every affected owner approved it.`);
      if (e.state === 'declined') o.risk(`Declined by ${e.declinedBy.map(nameOf).join(', ')}. No revision was drafted. Reasons are in the decision thread.`);
      const violationLines = e.violations.length ? e.violations.map((v) => `- ${v.text}`).join('\n') : '- None.';
      o.draft({ kind: 'availability_check', name: `Check: ${change.reportedBy}'s report`, artifactKey: 'availability_check', content: `# Availability and constraint check\n\nReported by ${change.reportedBy}.${change.note ? ` ${change.note}` : ''}\n\nRecorded availability after this report: ${reported}\n\nResult: **${STATE_LABEL[e.state]}**\n\nConflicts on the current schedule:\n${violationLines}\n\n_Availability is only what has been recorded. A speaker with no recorded availability is never assumed free._` });
      if (e.options.length) {
        const rows = e.options.map((opt) => [opt.label + (opt.key === e.chosen?.key ? ' (proposed)' : ''), opt.moved.length, opt.valid ? 'passes every check' : `breaks: ${opt.violations.map((v) => v.text).join('; ')}`]);
        o.draft({ kind: 'fix_proposal', name: `Fix options: ${change.reportedBy}'s report`, artifactKey: 'fix_proposal', content: `# Fix options tested on the whole day\n\n${table(['Option', 'Sessions moved', 'Result'], rows)}\n\n_Each option is tested on the whole schedule. A fixed session is never moved._` });
      }
      if (e.state === 'no_fix') {
        o.risk('No candidate fix passes every check. The lead planner has to decide how to handle this change.');
        o.ask({ key: 'ev_no_fix', text: 'No checked fix removes every conflict. Describe how you want this handled (for example, cut a session, or accept a late start).', blocking: true, assigneeRole: LEAD, assigneeOnly: true });
      }
      if (e.state === 'pending' && e.chosen && e.hash) {
        const chosen = e.chosen;
        const movesFor = (roleKey: string) => chosen.moved.filter((k) => ownerRole(plan, k) === roleKey).map((k) => {
          const before = plan.sessions.find((s) => s.key === k)!; const after = chosen.sessions.find((s) => s.key === k)!;
          return `${before.title} ${before.start}–${before.end} → ${after.start}–${after.end}`;
        }).join('; ');
        for (const r of e.affected) {
          const mine = r === VENUE
            ? `Room and AV setup changes for: ${chosen.moved.map((k) => plan.sessions.find((s) => s.key === k)!.title).join(', ')}.`
            : `Your session moves: ${movesFor(r)}. Can you attend at the new time?`;
          o.ask({ key: qkey(e.hash, r), text: `Proposed fix (${chosen.label}). ${mine} Reply "approve", or "decline" with a reason.`, blocking: true, assigneeRole: r, assigneeOnly: true });
        }
      }
      return o.done(`Run of show: ${STATE_LABEL[e.state]}.`);
    }

    if (role === PUBLISHER) {
      const o = new Out(role, `${A}-publish@1`);
      if (e.state !== 'approved' || !e.chosen || !e.hash) return o.done(`Nothing to publish yet (${STATE_LABEL[e.state]}). Revision 2 is drafted only after every affected owner approves.`);
      const revised = withAvailability(plan, change); revised.sessions = e.chosen.sessions;
      const left = checkPlan(revised);
      if (left.length) { o.risk(`Not drafted: the approved revision fails a check (${left.map((v) => v.text).join('; ')}).`); return o.done('Revision blocked by a check.'); }
      const changedKeys = new Set(e.chosen.moved);
      const rows = [...revised.sessions].sort((a, b) => toMin(a.start) - toMin(b.start)).map((s) => [`${s.start}–${s.end}`, s.title, s.room, personOf(revised, s.personKey)?.name ?? '—', changedKeys.has(s.key) ? 'moved' : 'unchanged']);
      o.draft({ kind: 'run_of_show_v2', name: `${plan.event.name}: run of show, revision 2`, artifactKey: 'run_of_show_v2', content: `# Run of show, revision 2: ${plan.event.name} (${plan.event.date})\n\nChange: ${e.chosen.label}. Reported by ${change.reportedBy}.\n\n${table(['Time', 'Session', 'Room', 'Speaker', 'Status'], rows)}\n\nApproved by: ${e.affected.map(nameOf).join(', ')}.\nChecked against venue hours ${plan.event.venueOpens}–${plan.event.venueCloses}, crew departure ${plan.event.crewLeaves}, room and speaker overlaps, and recorded availability. All pass.\n\n**Local outbox only.** This revision was written to the RIPPLE outbox. It was not sent to chat or email, and nobody outside RIPPLE has been notified. Publishing it needs the lead planner's approval.` });
      o.act({ key: 'act-publish-revision', type: 'publish_revision', title: `Publish run of show revision 2 (${e.chosen.label})`, connector: 'internal_notify', ownerRole: PUBLISHER, consequential: true, draftKind: 'run_of_show_v2', approvalRole: 'manager', ackRoles: e.affected, rationale: 'Every affected owner approved the moved sessions. Only the lead planner can publish. The revision is stored in the local outbox; nobody is notified outside RIPPLE.', target: `${plan.event.name} run of show`, effectKey: `run-of-show-${plan.event.name}-${e.hash}`, approver: { role: LEAD } });
      return o.done('Revision 2 drafted. Waiting for the lead planner to publish.');
    }

    return new Out(role, `${A}-none@1`).done('No analysis for this role.');
  },

  verifyAction(action, observed, revisedPlan, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'publish_revision') return checks;
    const text = observed.content;
    checks.push({ name: 'labelled local outbox only (nothing sent to chat or email)', passed: text.includes('**Local outbox only.**'), detail: 'scope statement present in the stored revision' });
    if (revisedPlan) {
      const plan = planSchema.parse(revisedPlan);
      const missing = plan.sessions.filter((s) => !text.includes(`${s.start}–${s.end}`) || !text.includes(s.title)).map((s) => s.title);
      checks.push({ name: 'every session time in the stored revision matches the revised plan', passed: missing.length === 0, detail: missing.length ? `missing or changed: ${missing.join(', ')}` : `${plan.sessions.length} sessions checked` });
      const broken = checkPlan(plan);
      checks.push({ name: 'the revised plan still passes venue, crew, room and availability checks', passed: broken.length === 0, detail: broken.length ? broken.map((v) => v.text).join('; ') : 'no violations' });
    }
    if (ctx) {
      const e = evaluate(ctx.baselinePlan, ctx.change, ctx.answers);
      checks.push({ name: 'every affected owner approved, re-read from the recorded decisions', passed: e.state === 'approved', detail: `state: ${e.state}; ${e.affected.length} approval(s) required` });
    }
    return checks;
  },

  completionChecks(ctx) {
    const e = evaluate(ctx.baselinePlan, ctx.change, ctx.answers);
    const broken = checkPlan(planSchema.parse(ctx.revisedPlan));
    return [
      { key: 'availability_matches_people', label: 'Every reported availability matches a person on the plan', passed: e.unknown.length === 0, detail: e.unknown.length ? `unknown: ${e.unknown.join(', ')}` : 'all matched' },
      { key: 'owners_approved', label: 'Every affected owner approved the fix, or no change was needed', passed: e.state === 'approved' || e.state === 'consistent', detail: `state: ${e.state}` },
      { key: 'day_checks_pass', label: 'The run of show passes venue, crew, room and availability checks', passed: broken.length === 0, detail: broken.length ? broken.map((v) => v.text).join('; ') : 'no violations' },
    ];
  },
};
