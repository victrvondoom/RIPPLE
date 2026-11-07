import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { candidates, coverage, podFlowPack } from '../src/server/packs/podflow/pack.js';
import { makeEnv, startPack, approveAll, executeAll, finishReviews, missionRow, kinds, artifact, row, rows, answer } from './helpers.js';

const S = () => podFlowPack.sample();
const selKey = (env: any, id: string) => row(env, "SELECT key FROM questions WHERE mission_id=? AND key LIKE 'clip_selection_%' ORDER BY created_at DESC", id).key as string;

describe('PodFlow', () => {
  it('rejects invalid input, including unknown platforms before any state change', async () => {
    const env = makeEnv(); const s = S(); const bad: any = structuredClone(s.plan); delete bad.platforms;
    await expect(env.engine.createMission(env.maya, { packId: 'podflow', title: 'x', plan: bad })).rejects.toThrow(/platforms/);
    const { mission } = await (await import('./helpers.js')).newBaselinedMission(env, 'podflow');
    await expect(env.engine.submitChange(env.maya, mission.id, { ...s.change, segments: [] })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, mission.id, { ...s.change, segments: [{ startSec: 0, endSec: -1, speaker: 'a', text: 'x' }] })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, mission.id, { ...s.change, platforms: ['tiktok'] })).rejects.toThrow(/Unknown platform/);
    expect(missionRow(env, mission.id).state).toBe('baseline_ready');
  });

  it('measures transcript coverage honestly and finds deterministic, claim-flagged highlight candidates', async () => {
    const s = S(); const cv = coverage(s.plan, s.change.segments); expect(cv.pct).toBeGreaterThan(0.8); expect(cv.pct).toBeLessThan(0.9); expect(cv.gaps).toHaveLength(1);
    const a = candidates(s.plan, s.change.segments, s.change.platforms); const b = candidates(s.plan, s.change.segments, s.change.platforms);
    expect(a).toEqual(b); expect(a.length).toBe(4); expect(a.every((c, i) => c.n === i + 1 && c.dur >= 20 && c.dur <= 90)).toBe(true);
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(a[i].startSec < a[j].endSec && a[i].endSec > a[j].startSec).toBe(false);   // non-overlapping
    const claims = a.flatMap((c) => c.flags.map((f) => f.type)); expect(claims).toEqual(expect.arrayContaining(['statistic', 'absolute', 'advice_regulated', 'superlative']));
    expect(a.find((c) => c.dur > 60)!.trims[0]).toMatchObject({ platform: 'youtube_shorts', max: 60 });
  });

  it('blocks until the creator approves clips, and the approval is bound to the exact candidate set', async () => {
    const env = makeEnv(); const { id, state, sample } = await startPack(env, 'podflow');
    expect(state()).toBe('blocked'); expect(missionRow(env, id).state_reason).toMatch(/approve/i); expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', id)).toHaveLength(0);
    const k = selKey(env, id); await expect(answer(env, id, k, 'the good ones')).rejects.toThrow(/clip numbers/);
    await answer(env, id, k, '1, 4'); expect(state()).toBe('awaiting_approval');
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", id).map((a) => a.key).sort()).toEqual(['export_checklist', 'export_kit']);
    expect(kinds(env, id)).toEqual(expect.arrayContaining(['artifact:transcript', 'artifact:highlight_candidates', 'artifact:factcheck_log', 'artifact:captions_titles', 'artifact:content_kit', 'artifact:publish_checklist']));
    // a revised transcript yields a different candidate set → the old approval does NOT carry over
    const seg = structuredClone(sample.change.segments); seg[2].text = 'Pricing was hard. ' + seg[2].text; seg[0].endSec += 9;
    await env.engine.submitChange(env.maya, id, { ...sample.change, receivedOn: '2026-11-04', segments: seg.map((s: any, i: number) => (i < 1 ? s : { ...s, startSec: s.startSec + 9, endSec: s.endSec + 9 })) });
    expect(state()).toBe('blocked'); expect(selKey(env, id)).not.toBe(k); expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", id).length).toBe(2);
  });

  it('labels the source honestly, flags claims for the creator, respects platform limits, gates uploads on a media check', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'podflow'); await answer(env, id, selKey(env, id), '1,4');
    const kit = artifact(env, id, 'content_kit');
    expect(kit).toMatch(/SOURCE: transcript text only — no audio or video was processed/); expect(kit).toMatch(/CLIP 1 \| 00:01:26–00:02:34 \| 68s/); expect(kit).toMatch(/TRIM\[youtube_shorts\]/);
    for (const m of kit.matchAll(/CAPTION\[youtube_shorts\]: (.*)/g)) expect(m[1].length).toBeLessThanOrEqual(150);
    for (const m of kit.matchAll(/CAPTION\[x\]: (.*)/g)) expect(m[1].length).toBeLessThanOrEqual(280);
    for (const m of kit.matchAll(/TITLE\[[AB]\]: (.*)/g)) expect(m[1].length).toBeLessThanOrEqual(100);
    expect(kit).toMatch(/FLAG: statistic/); expect(kit).not.toMatch(/\bverified\b/i);
    const reviews = rows(env, "SELECT title FROM work_items WHERE mission_id=? AND analysis_rev=? AND kind='review'", id, missionRow(env, id).analysis_rev).map((w) => w.title);
    expect(reviews.some((t) => /Check selected clip timestamps against the real audio\/video/.test(t))).toBe(true); expect(reviews.filter((t) => /Verify claim/.test(t)).length).toBeGreaterThanOrEqual(3);
    const up = row(env, "SELECT * FROM work_items WHERE mission_id=? AND title LIKE 'Upload clip 1%'", id); expect(() => env.engine.updateWorkItem(env.maya, id, up.id, 'done')).toThrow(/prerequisite/);
    const factFinding = JSON.parse(row(env, "SELECT output FROM agent_runs WHERE mission_id=? AND role_key='factcheck' ORDER BY started_at DESC", id).output).findings;
    expect(factFinding.some((f: any) => /RIPPLE has NOT verified this/.test(f.text))).toBe(true);
  });

  it('executes with kit-specific verification, refuses completion until every claim and the media check are reviewed', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'podflow'); await answer(env, id, selKey(env, id), '1,4');
    await approveAll(env, id); await executeAll(env, id);
    expect(rows(env, "SELECT check_name FROM evidence WHERE mission_id=? AND kind='verification'", id).map((e) => e.check_name)).toEqual(expect.arrayContaining(['source labelled as transcript text', 'every approved clip present with timestamps', 'captions within platform limits', 'every uncertainty flag travels with the kit', 'does not claim media was processed']));
    await expect(env.engine.completeMission(env.maya, id)).rejects.toThrow(/reviews/);
    finishReviews(env, id); await env.engine.completeMission(env.maya, id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.selectedClips).toEqual([1, 4]); expect(b2.kits[0]).toMatchObject({ sourceKind: 'transcript_text' }); expect(b2.transcript.length).toBeGreaterThan(10);
    expect(JSON.parse(row(env, 'SELECT unresolved FROM outcomes WHERE mission_id=?', id).unresolved).join('\n')).toMatch(/Upload clip 1/);   // publishing stays visibly open
  });

  it('kit verification fails if a caption exceeds the platform limit or a flag is removed', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'podflow'); await answer(env, id, selKey(env, id), '4'); await approveAll(env, id); await executeAll(env, id);
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='export_kit'", id); const loc = JSON.parse(a.result).location;
    writeFileSync(loc, readFileSync(loc, 'utf8').replace(/CAPTION\[youtube_shorts\]: /, 'CAPTION[youtube_shorts]: ' + 'x'.repeat(200) + ' ').replace(/FLAG: statistic[^\n]*\n/, ''));
    env.engine.verifyAction(env.maya, missionRow(env, id), a.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verification_failed');
    expect(rows(env, 'SELECT check_name FROM evidence WHERE action_id=? AND passed=0', a.id).map((e) => e.check_name)).toEqual(expect.arrayContaining(['captions within platform limits', 'every uncertainty flag travels with the kit']));
  });
});
