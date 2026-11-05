import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluate, submitReadyPack } from '../src/server/packs/submitready/pack.js';
import { makeEnv, startPack, answer, approveAll, executeAll, ackAll, finishReviews, missionRow, kinds, artifact, row, rows } from './helpers.js';

const S = () => submitReadyPack.sample();
const st = (e: ReturnType<typeof evaluate>) => Object.fromEntries(e.reqs.map((r) => [r.id, r.status]));
const ev = (ref: string, extra: any = {}) => ({ kind: 'file', ref, verified: true, title: 'Orbit: Adaptive Routing', teamName: 'Team Orbit', ...extra });
/** A progress update (relative to baseline v1) that evidences everything. */
const ready = (s = S()) => ({ ...s.change, notApplicable: ['R8'], citations: [{ id: 'c2', source: 'Stanford routing study (2022)', usedIn: ['d_report', 'd_slides'], verified: true }], updates: [
  { deliverableId: 'd_report', status: 'complete', addEvidence: ev('report-final.pdf') }, { deliverableId: 'd_slides', status: 'complete', addEvidence: ev('slides-final.pdf', { title: 'Orbit: Adaptive Routing' }) },
  { deliverableId: 'd_video', status: 'complete', ownerId: 'm4', addEvidence: ev('https://video.example/orbit-demo', { kind: 'link' }) }, { deliverableId: 'd_cites', status: 'complete', addEvidence: ev('citations.bib') },
  { deliverableId: 'd_peer', status: 'complete', addEvidence: ev('peer-eval.pdf') }] });

describe('SubmitReady', () => {
  it('rejects invalid input', async () => {
    const env = makeEnv(); const s = S(); const bad: any = structuredClone(s.plan); bad.rubric = [];
    await expect(env.engine.createMission(env.maya, { packId: 'submitready', title: 'x', plan: bad })).rejects.toThrow(/rubric/);
    const r = await startPack(env, 'submitready');
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, receivedOn: '12/11/2026' })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, r.id, { ...s.change, updates: [{ deliverableId: 'd_report', status: 'finished' }] })).rejects.toThrow(/validation/);
  });

  it('distinguishes verified / incomplete / uncertain / not applicable strictly from evidence', () => {
    const s = S(); const e = evaluate(s.plan, s.change); const x = st(e);
    expect(x).toEqual({ R1: 'uncertain', R2: 'uncertain', R3: 'verified', R4: 'incomplete', R5: 'incomplete', R6: 'uncertain', R7: 'incomplete', R8: 'uncertain' });
    expect(e.reqs.find((r) => r.id === 'R1')!.reason).toMatch(/evidence recorded but not verified/); expect(e.reqs.find((r) => r.id === 'R3')!.evidence[0]).toMatch(/a41f9c2/);
    expect(e.reqs.find((r) => r.id === 'R6')!.reason).toMatch(/Stanford routing study/); expect(e.ver).toBe(20);
    // "complete" without evidence is NOT verified
    const noev = evaluate(s.plan, { ...s.change, updates: [{ deliverableId: 'd_video', status: 'complete', ownerId: 'm4' }] }); expect(st(noev).R4).toBe('incomplete'); expect(noev.reqs.find((r) => r.id === 'R4')!.reason).toMatch(/NO evidence/);
    // a not-applicable claim stays uncertain until a human confirms it
    expect(st(evaluate(s.plan, s.change)).R8).toBe('uncertain'); expect(st(evaluate(s.plan, s.change, { na_R8: { text: 'yes', value: 'yes' } })).R8).toBe('not_applicable');
    expect(st(evaluate(s.plan, s.change, { na_R8: { text: 'no', value: 'no' } })).R8).toBe('uncertain');
    expect(Object.values(st(evaluate(s.plan, ready(), { na_R8: { text: 'yes', value: 'yes' } }))).every((v) => v === 'verified' || v === 'not_applicable')).toBe(true);
  });

  it('detects cross-deliverable inconsistencies and deadline risk', () => {
    const s = S(); const e = evaluate(s.plan, s.change); expect(e.issues).toEqual(['Title mismatch in Presentation slides: "Orbit: Adaptive Routing v2" vs project title "Orbit: Adaptive Routing"'].map((x) => x));
    const wrong = evaluate(s.plan, { ...s.change, updates: [{ deliverableId: 'd_report', status: 'complete', addEvidence: ev('r.pdf', { teamName: 'Team Nova' }) }] }); expect(wrong.issues.join()).toMatch(/Team name mismatch/);
    const items = submitReadyPack.detectChanges(s.plan, { ...s.change, receivedOn: '2026-11-18' }).map((i) => i.field); expect(items).toContain('deadline.at_risk');
    expect(submitReadyPack.detectChanges(s.plan, { ...s.change, receivedOn: '2026-11-25' }).map((i) => i.field)).toContain('deadline.passed');
  });

  it('blocks on an unowned deliverable, then proposes gated actions and per-owner work', async () => {
    const env = makeEnv(); const { id, state } = await startPack(env, 'submitready');
    expect(state()).toBe('blocked'); expect(missionRow(env, id).state_reason).toMatch(/Demo video/); expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', id)).toHaveLength(0);
    await expect(answer(env, id, 'owner_d_video', 'nobody')).rejects.toThrow(/Answer with one of/); await answer(env, id, 'owner_d_video', 'Ben'); expect(state()).toBe('awaiting_approval');
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", id).map((a) => a.key).sort()).toEqual(['notify_team', 'publish_checklist', 'publish_report']);
    expect(kinds(env, id)).toEqual(expect.arrayContaining(['artifact:compliance_report', 'artifact:deliverables', 'artifact:evidence_log', 'artifact:citation_log', 'artifact:submission_package']));
    const work = rows(env, 'SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=?', id, missionRow(env, id).analysis_rev);
    expect(work.some((w) => /R4: Complete Demo video/.test(w.title) && w.role_key === 'human_member')).toBe(true); expect(work.some((w) => w.kind === 'review' && /Team lead reviews/.test(w.title))).toBe(true);
    expect(rows(env, "SELECT * FROM questions WHERE mission_id=? AND key='na_R8'", id)[0].blocking).toBe(0);
  });

  it('never claims a requirement is met without evidence: report lines and verification', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'submitready'); await answer(env, id, 'owner_d_video', 'Ben');
    const rep = artifact(env, id, 'compliance_report'); const lines = rep.split('\n').filter((l) => l.startsWith('REQ '));
    expect(lines).toHaveLength(8); expect(lines.find((l) => l.startsWith('REQ R3'))).toMatch(/VERIFIED .*evidence: github\.com\/team-orbit\/routing@a41f9c2/); expect(lines.find((l) => l.startsWith('REQ R1'))).toMatch(/UNCERTAIN .*gap:/);
    expect(rep).toMatch(/Evidence-backed readiness: \*\*20\/100 points\*\*/);
    await approveAll(env, id); await executeAll(env, id);
    expect(rows(env, 'SELECT key,status FROM actions WHERE mission_id=? AND analysis_rev=?', id, missionRow(env, id).analysis_rev).every((a) => a.status === 'verified')).toBe(true);   // all three verified, incl. the report
    expect(rows(env, "SELECT check_name FROM evidence WHERE mission_id=? AND kind='verification'", id).map((e) => e.check_name)).toEqual(expect.arrayContaining(['every rubric requirement appears', 'no VERIFIED claim without verified evidence', 'statuses match the recorded evidence']));
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_report'", id); const loc = JSON.parse(a.result).location;
    writeFileSync(loc, readFileSync(loc, 'utf8').replace(/REQ R4 \| INCOMPLETE/, 'REQ R4 | VERIFIED')); env.engine.verifyAction(env.maya, missionRow(env, id), a.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verification_failed');
    expect(rows(env, 'SELECT check_name FROM evidence WHERE action_id=? AND passed=0', a.id).map((e) => e.check_name)).toEqual(expect.arrayContaining(['no VERIFIED claim without verified evidence', 'statuses match the recorded evidence']));
  });

  it('is not completable while requirements are unverified; completes only after evidence-backed updates and a human N/A confirmation', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'submitready'); await answer(env, id, 'owner_d_video', 'Ben'); await approveAll(env, id); await executeAll(env, id); ackAll(env, id); finishReviews(env, id);
    expect(() => env.engine.completeMission(env.maya, id)).toThrow(/evidence-verified/);
    await env.engine.submitChange(env.maya, id, ready()); expect(missionRow(env, id).state).toBe('awaiting_approval');
    await answer(env, id, 'na_R8', 'yes — instructor confirmed by email');                         // human confirmation, on the record
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", id).length).toBeGreaterThanOrEqual(3);
    await approveAll(env, id); await executeAll(env, id); ackAll(env, id); finishReviews(env, id);
    expect(rows(env, "SELECT status FROM actions WHERE mission_id=? AND analysis_rev=?", id, missionRow(env, id).analysis_rev).every((a) => a.status === 'verified')).toBe(true);
    expect(artifact(env, id, 'compliance_report')).toMatch(/\*\*96\/96 points\*\*/); env.engine.completeMission(env.maya, id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.rubric.find((r: any) => r.id === 'R8').applicable).toBe(false); expect(Object.values(b2.reports.at(-1).statuses).every((v) => v === 'verified' || v === 'not_applicable')).toBe(true);
    expect(missionRow(env, id)).toMatchObject({ state: 'completed', current_baseline_version: 2 });
  });

  it('shared citation evidence: verifying citations satisfies the dependent citation tasks (explicit link, audited)', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'submitready'); await answer(env, id, 'owner_d_video', 'Ben');
    const work = rows(env, 'SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=?', id, missionRow(env, id).analysis_rev); const ver = work.find((w) => /Verify every citation/.test(w.title))!; const dep = work.find((w) => /^R6: /.test(w.title))!;
    expect(dep.status).toBe('open'); env.engine.updateWorkItem(env.maya, id, ver.id, 'done'); expect(row(env, 'SELECT status FROM work_items WHERE id=?', dep.id).status).toBe('done');
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='evidence_linked'", id)).toHaveLength(1);
    expect(missionRow(env, id).state).toBe('awaiting_approval');       // but marking a task done does NOT change the evidenced status of R6
    expect(JSON.parse(row(env, "SELECT output FROM agent_runs WHERE mission_id=? AND role_key='rubric' ORDER BY started_at DESC", id).output).findings.some((f: any) => /R6.*UNCERTAIN/.test(f.text))).toBe(true);
  });
});
