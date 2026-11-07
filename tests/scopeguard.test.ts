import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { classify, scopeGuardPack } from '../src/server/packs/scopeguard/pack.js';
import { makeEnv, newBaselinedMission, startPack, answer, approveAll, executeAll, ackAll, finishReviews, missionRow, kinds, artifact, row, rows } from './helpers.js';

describe('ScopeGuard', () => {
  it('rejects invalid plans and requests', async () => {
    const env = makeEnv(); const s = scopeGuardPack.sample();
    const bad: any = structuredClone(s.plan); delete bad.rateCard;
    await expect(env.engine.createMission(env.maya, { packId: 'scopeguard', title: 'x', plan: bad })).rejects.toThrow(/rateCard/);
    const { mission } = await newBaselinedMission(env, 'scopeguard');
    await expect(env.engine.submitChange(env.maya, mission.id, { ...s.change, items: [] })).rejects.toThrow(/validation/);
    await expect(env.engine.submitChange(env.maya, mission.id, { ...s.change, items: [{ title: 'x', kind: 'dream' }] })).rejects.toThrow(/validation/);
  });

  it('classifies included / out-of-scope / uncertain from the approved scope and allowances', async () => {
    const s = scopeGuardPack.sample(); const c = classify(s.plan, s.change);
    const by = Object.fromEntries(c.map((x) => [x.title, x]));
    expect(by['Table-booking flow with online deposit'].status).toBe('out_of_scope');
    expect(by['Stripe payments for deposits'].reason).toMatch(/not in the approved integration list/);
    expect(by['Pricing page'].reason).toMatch(/exceeds page limit \(12 used \+ 1 requested > 12\)/);
    expect(by['Contact page copy tweak'].status).toBe('included');                 // matches approved scope line s3
    expect(by['Homepage hero revision'].reason).toMatch(/revision round 2 of 2/);   // uses the last included round
    expect(by['Make the whole site feel more premium'].status).toBe('uncertain');
    // a second revision request would exceed the allowance
    const again = classify(s.plan, { ...s.change, items: [{ title: 'r1', kind: 'revision', clarity: 'clear' }, { title: 'r2', kind: 'revision', clarity: 'clear' }] });
    expect(again.map((x) => x.status)).toEqual(['included', 'out_of_scope']);
    // explicitly excluded scope line
    expect(classify(s.plan, { ...s.change, items: [{ title: 'Online ordering', kind: 'feature', matchesScopeId: 's4', clarity: 'clear' }] })[0].reason).toMatch(/explicitly excluded/);
  });

  it('blocks on an uncertain request, then proposes gated actions after a human decides', async () => {
    const env = makeEnv(); const r = await startPack(env, 'scopeguard'); const id = r.id;
    expect(r.state()).toBe('blocked'); expect(missionRow(env, id).state_reason).toMatch(/premium/);
    expect(rows(env, 'SELECT * FROM actions WHERE mission_id=?', id)).toHaveLength(0);
    await expect(answer(env, id, 'classify_6', 'maybe?')).rejects.toThrow(/in scope|out of scope/i);
    await answer(env, id, 'classify_6', 'out of scope');
    expect(r.state()).toBe('awaiting_approval');
    expect(rows(env, "SELECT key FROM actions WHERE mission_id=? AND status='proposed'", id).map((a) => a.key).sort()).toEqual(['notify_team', 'publish_change_order', 'send_client_message']);
    const k = kinds(env, id);
    expect(k).toEqual(expect.arrayContaining(['artifact:scope_doc', 'artifact:estimate', 'artifact:change_order', 'artifact:schedule', 'artifact:task_board', 'artifact:client_comms', 'decision:approve_co']));
    // required work: reviews gate completion; tasks depend on the client's acceptance
    const items = rows(env, 'SELECT * FROM work_items WHERE mission_id=? AND analysis_rev=?', id, missionRow(env, id).analysis_rev);
    expect(items.filter((w) => w.kind === 'review').map((w) => w.role_key).sort()).toEqual(['human_finance', 'human_lead', 'human_pm']);
    const task = items.find((w) => /^designer: /.test(w.title))!;
    expect(() => env.engine.updateWorkItem(env.maya, id, task.id, 'done')).toThrow(/prerequisite/);
  });

  it('never promises price or dates to the client and marks estimates as internal', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'scopeguard'); await answer(env, id, 'classify_6', 'out of scope');
    const msg = artifact(env, id, 'client_message'); const co = artifact(env, id, 'change_order'); const est = artifact(env, id, 'estimate');
    expect(msg).not.toMatch(/[$€£₹]\s?\d/); expect(msg).not.toMatch(/\d{4}-\d{2}-\d{2}/); expect(msg).toMatch(/outside the agreed scope/);
    expect(co).toMatch(/TO BE CONFIRMED/); expect(co).toMatch(/DRAFT, pending/); expect(est).toMatch(/INTERNAL, not a quote/);
    expect(msg).toMatch(/covered by the agreed scope/);   // included items are reported as included
  });

  it('executes after approval, verifies domain checks, refuses completion until reviews/acks done, then versions the scope', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'scopeguard'); await answer(env, id, 'classify_6', 'out of scope');
    const co = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='publish_change_order'", id);
    await expect(env.engine.executeAction(env.maya, id, co.id)).rejects.toThrow(/only approved/);
    await approveAll(env, id); await executeAll(env, id);
    expect(rows(env, 'SELECT status FROM actions WHERE mission_id=?', id).filter((a) => a.status === 'verified')).toHaveLength(3);
    const names = rows(env, "SELECT check_name FROM evidence WHERE mission_id=? AND kind='verification'", id).map((e) => e.check_name);
    expect(names).toEqual(expect.arrayContaining(['change order lists every out-of-scope item', 'no price quoted to client', 'no deadline promised to client']));
    await expect(env.engine.completeMission(env.maya, id)).rejects.toThrow(/acknowledgements|reviews/);
    ackAll(env, id); finishReviews(env, id);
    await env.engine.completeMission(env.maya, id);
    const b2 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=2', id).plan);
    expect(b2.changeOrders[0]).toMatchObject({ ref: 'CO-1', status: 'issued_pending_client_acceptance' });
    expect(b2.scope.filter((x: any) => x.changeOrder === 'CO-1').length).toBe(5);   // booking, Stripe, Pricing, Team, premium (decided out of scope)
    expect(b2.project.endDate).toBe('2026-12-18'); expect(b2.project.proposedEndDate > '2026-12-18').toBe(true);   // proposed, not committed
    const v1 = JSON.parse(row(env, 'SELECT plan FROM baselines WHERE mission_id=? AND version=1', id).plan); expect(v1.changeOrders).toHaveLength(0);
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type IN ('approval_approved','action_executed','action_verified','mission_completed')", id).length).toBeGreaterThanOrEqual(10);
  });

  it('fails verification if the client message is tampered to include a price', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'scopeguard'); await answer(env, id, 'classify_6', 'in scope');
    await approveAll(env, id); await executeAll(env, id);
    const a = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_client_message'", id);
    const loc = JSON.parse(a.result).location; writeFileSync(loc, `${(await import('node:fs')).readFileSync(loc, 'utf8')}\nThe price is $12,000.`);
    env.engine.verifyAction(env.maya, missionRow(env, id), a.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', a.id).status).toBe('verification_failed');
    expect(rows(env, "SELECT * FROM evidence WHERE action_id=? AND passed=0", a.id).map((e) => e.check_name)).toContain('no price quoted to client');
  });

  it('a newer request makes queued actions stale (no silent execution of outdated scope)', async () => {
    const env = makeEnv(); const { id, sample } = await startPack(env, 'scopeguard'); await answer(env, id, 'classify_6', 'out of scope');
    await approveAll(env, id);
    await env.engine.submitChange(env.maya, id, { ...sample.change, receivedOn: '2026-11-10', items: [{ title: 'Loyalty programme', kind: 'feature', clarity: 'clear' }] });
    expect(rows(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", id).length).toBe(3);
    const stale = row(env, "SELECT * FROM actions WHERE mission_id=? AND status='stale'", id);
    await expect(env.engine.executeAction(env.maya, id, stale.id)).rejects.toThrow(/stale/);
  });

  it('an all-included request needs no change order', async () => {
    const env = makeEnv(); const { id } = await startPack(env, 'scopeguard', (c) => ({ ...c, items: [{ title: 'Contact page copy tweak', kind: 'page', matchesScopeId: 's3', clarity: 'clear' }] }));
    expect(missionRow(env, id).state).toBe('awaiting_approval');
    expect(rows(env, 'SELECT key FROM actions WHERE mission_id=?', id).map((a) => a.key).sort()).toEqual(['notify_team', 'send_client_message']);
    expect(artifact(env, id, 'change_order')).toBeUndefined();
  });
});
