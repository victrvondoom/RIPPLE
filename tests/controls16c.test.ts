import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { RepeatGuard } from '../src/server/engine/repeat.js';
import { inQuietWindow, validQuietWindow } from '../src/server/engine/quiet.js';
import { makeEnv, startPack, row, type Env } from './helpers.js';

/** Session 16 (third group): repeat suppression, quiet hours, approval expiry. */

afterEach(() => { vi.useRealTimers(); });

describe('repeat suppression', () => {
  it('records the first occurrence, suppresses an identical one inside five minutes, and records again after the window', () => {
    const g = new RepeatGuard(5 * 60_000);
    const t0 = Date.parse('2026-11-07T10:00:00Z');
    expect(g.admit('k', t0)).toBe(true);
    expect(g.admit('k', t0 + 60_000)).toBe(false);
    expect(g.admit('other', t0 + 60_000)).toBe(true);
    expect(g.admit('k', t0 + 5 * 60_000 + 1)).toBe(true);
  });
});

describe('quiet hours', () => {
  it('handles a window that wraps midnight, a normal window, and an empty window', () => {
    const night = { fromHour: 22, toHour: 6 };
    expect(inQuietWindow(night, new Date('2026-11-07T23:30:00Z'))).toBe(true);
    expect(inQuietWindow(night, new Date('2026-11-07T05:59:00Z'))).toBe(true);
    expect(inQuietWindow(night, new Date('2026-11-07T06:00:00Z'))).toBe(false);
    expect(inQuietWindow(night, new Date('2026-11-07T12:00:00Z'))).toBe(false);
    expect(inQuietWindow({ fromHour: 9, toHour: 17 }, new Date('2026-11-07T10:00:00Z'))).toBe(true);
    expect(inQuietWindow({ fromHour: 9, toHour: 9 }, new Date('2026-11-07T09:00:00Z'))).toBe(false);
  });

  it('rejects out-of-range hours', () => {
    expect(validQuietWindow({ fromHour: 25, toHour: 6 })).toBe(false);
    expect(validQuietWindow({ fromHour: 1.5, toHour: 6 })).toBe(false);
    expect(validQuietWindow({ fromHour: 22, toHour: 6 })).toBe(true);
  });
});

const env = (): Env => makeEnv(new LocalCollab(), extendedRegistry());
const act = (e: Env, id: string, key: string) => row(e, "SELECT * FROM actions WHERE mission_id=? AND key=? AND analysis_rev=(SELECT analysis_rev FROM missions WHERE id=?) AND status NOT IN ('superseded','stale')", id, key, id);
const approval = (e: Env, id: string, key: string) => row(e, "SELECT * FROM approvals WHERE subject_id=? AND status='pending'", act(e, id, key).id);

describe('quiet hours in the engine: refused without changing state', () => {
  it('refuses to execute an approved action inside its quiet window, then runs it once outside the window', async () => {
    const e = env();
    const nora = e.actor('nora@harborvine.example');
    const r = await startPack(e, 'billing-dispute');
    await e.engine.decideApproval(nora, r.id, approval(e, r.id, 'refund_duplicate').id, 'approved', 'ok');
    const refund = act(e, r.id, 'refund_duplicate');
    e.db.exec('UPDATE actions SET quiet_hours=? WHERE id=?', JSON.stringify({ fromHour: 22, toHour: 6 }), refund.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T23:30:00Z'));
    await expect(e.engine.executeAction(nora, r.id, refund.id)).rejects.toMatchObject({ status: 423, code: 'quiet_hours' });
    expect(act(e, r.id, 'refund_duplicate').status).toBe('approved');
    expect(e.db.get("SELECT id FROM audit_events WHERE mission_id=? AND type='action_deferred_quiet'", r.id)).toBeDefined();
    vi.setSystemTime(new Date('2026-11-08T07:00:00Z'));
    await expect(e.engine.executeAction(nora, r.id, refund.id)).resolves.toBeDefined();
  });
});

describe('approval expiry (Shipyard TTL)', () => {
  it('refuses to decide an expired approval and returns its action to stale', async () => {
    const e = env();
    const nora = e.actor('nora@harborvine.example');
    const r = await startPack(e, 'billing-dispute');
    const ap = approval(e, r.id, 'refund_duplicate');
    e.db.exec("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", ap.id);
    await expect(e.engine.decideApproval(nora, r.id, ap.id, 'approved', 'late')).rejects.toMatchObject({ status: 409, code: 'expired' });
    expect(row(e, 'SELECT status FROM approvals WHERE id=?', ap.id).status).toBe('expired');
    expect(row(e, 'SELECT status FROM actions WHERE id=?', ap.subject_id).status).toBe('stale');
    expect(e.db.get("SELECT id FROM audit_events WHERE mission_id=? AND type='approval_expired'", r.id)).toBeDefined();
  });

  it('the sweep expires only pending approvals past their expiry', async () => {
    const e = env();
    const r = await startPack(e, 'billing-dispute');
    const credit = approval(e, r.id, 'issue_sla_credit');
    e.db.exec("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", credit.id);
    const refund = approval(e, r.id, 'refund_duplicate');
    e.db.exec("UPDATE approvals SET expires_at='2999-01-01T00:00:00.000Z' WHERE id=?", refund.id);
    expect(e.engine.sweepExpiredApprovals()).toBe(1);
    expect(row(e, 'SELECT status FROM approvals WHERE id=?', credit.id).status).toBe('expired');
    expect(row(e, 'SELECT status FROM approvals WHERE id=?', refund.id).status).toBe('pending');
  });
});
