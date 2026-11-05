import { describe, it, expect } from 'vitest';
import { makeEnv, row, rows, toAwaitingApproval } from './helpers.js';
import type { Connector, ConnectorRequest } from '../src/server/connectors/index.js';

/**
 * Recovery invariant: a thrown connector error is NOT proof that nothing happened.
 * These tests drive the real engine and the real local file connector. Only the connector's
 * execute/observe are wrapped, to simulate a lost response and a failing read-back.
 */
async function approvedEmailAction() {
  const env = makeEnv();
  const id = await toAwaitingApproval(env, 18);
  const act = row(env, "SELECT * FROM actions WHERE mission_id=? AND key='send_client'", id);
  await env.engine.decideApproval(env.maya, id, row(env, 'SELECT id FROM approvals WHERE subject_id=?', act.id).id, 'approved', '');
  return { env, id, act };
}

type Faults = { writeBeforeThrow: boolean; loseResponse: boolean; readBackBroken: boolean };

/** Installs a wrapper around the real email connector. Faults are mutable so one test can change them between attempts. */
function wrapEmailConnector(env: ReturnType<typeof makeEnv>, faults: Faults) {
  const real = env.engine.connectors.email_outbox;
  const calls = { execute: 0 };
  const wrapped: Connector = {
    key: real.key, name: real.name, mode: real.mode, description: real.description,
    execute(req: ConnectorRequest) {
      calls.execute++;
      if (!faults.writeBeforeThrow) throw new Error('connection reset before the request reached the connector');
      const r = real.execute(req);                  // the effect really lands…
      if (faults.loseResponse) throw new Error('socket hang up: response lost after write');   // …but the caller only sees an error
      return r;
    },
    observe(req) {
      if (faults.readBackBroken) throw new Error('read-back unavailable (503)');
      return real.observe(req);
    },
  };
  env.engine.connectors.email_outbox = wrapped;
  return calls;
}

describe('execution outcome: lost response and read-back', () => {
  it('a lost response after a real write is read back and verified, not recorded as failed', async () => {
    const { env, id, act } = await approvedEmailAction();
    const calls = wrapEmailConnector(env, { writeBeforeThrow: true, loseResponse: true, readBackBroken: false });
    await env.engine.executeAction(env.maya, id, act.id);

    const after = row(env, 'SELECT * FROM actions WHERE id=?', act.id);
    expect(after.status).toBe('verified');
    expect(calls.execute).toBe(1);                      // never repeated
    expect(JSON.parse(after.result).recoveredBy).toBe('read-back');
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_effect_observed'", id)).toHaveLength(1);
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_failed'", id)).toHaveLength(0);
    const states = rows(env, 'SELECT lifecycle_state FROM causal_events WHERE mission_id=? AND idempotency_key=?', id, act.idempotency_key).map((r) => r.lifecycle_state);
    expect(states).toContain('OBSERVED');
    expect(states).toContain('VERIFIED');
    expect(states).not.toContain('FAILED');
  });

  it('an error with confirmed absence is FAILED (safe to retry); the retry lands exactly once', async () => {
    const { env, id, act } = await approvedEmailAction();
    const faults: Faults = { writeBeforeThrow: false, loseResponse: false, readBackBroken: false };
    const calls = wrapEmailConnector(env, faults);
    await env.engine.executeAction(env.maya, id, act.id);

    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'failed' });
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('recovery_required');
    expect(rows(env, "SELECT * FROM causal_events WHERE mission_id=? AND lifecycle_state='FAILED'", id).length).toBeGreaterThan(0);
    expect(rows(env, "SELECT * FROM causal_events WHERE mission_id=? AND lifecycle_state='EXECUTION_UNKNOWN'", id)).toHaveLength(0);

    // recovery: the connector now succeeds with the same idempotency key
    faults.writeBeforeThrow = true;
    await env.engine.executeAction(env.maya, id, act.id);
    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'verified', attempts: 2 });
    expect(calls.execute).toBe(2);
    expect(env.engine.connectors.email_outbox.observe({ workspaceId: env.maya.workspaceId, missionId: id, idempotencyKey: act.idempotency_key }).count).toBe(1);
  });

  it('when the read-back also fails the outcome is EXECUTION_UNKNOWN: nothing is repeated and retry is refused', async () => {
    const { env, id, act } = await approvedEmailAction();
    const calls = wrapEmailConnector(env, { writeBeforeThrow: true, loseResponse: true, readBackBroken: true });
    await env.engine.executeAction(env.maya, id, act.id);

    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'execution_unknown' });
    expect(row(env, 'SELECT state FROM missions WHERE id=?', id).state).toBe('recovery_required');
    expect(rows(env, "SELECT * FROM causal_events WHERE mission_id=? AND lifecycle_state='EXECUTION_UNKNOWN'", id)).toHaveLength(1);
    expect(rows(env, "SELECT * FROM causal_events WHERE mission_id=? AND lifecycle_state='FAILED'", id)).toHaveLength(0);
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_unknown'", id)).toHaveLength(1);

    // completion can never pass while an outcome is unknown
    const check = env.engine.completionPreview(env.maya, id).checks.find((c: any) => c.key === 'no_failed_or_stale');
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
    expect(check!.detail).toMatch(/execution_unknown/);

    // retry while still unknown: refused with 409, and the connector is NOT called again
    await expect(env.engine.executeAction(env.maya, id, act.id)).rejects.toMatchObject({ status: 409, code: 'still_unknown' });
    expect(calls.execute).toBe(1);
    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id).status).toBe('execution_unknown');
  });

  it('once read-back works, an unknown action is resolved by observation and verified without a second execute', async () => {
    const { env, id, act } = await approvedEmailAction();
    const faults: Faults = { writeBeforeThrow: true, loseResponse: true, readBackBroken: true };
    const calls = wrapEmailConnector(env, faults);
    await env.engine.executeAction(env.maya, id, act.id);
    expect(row(env, 'SELECT status FROM actions WHERE id=?', act.id).status).toBe('execution_unknown');

    faults.readBackBroken = false;                      // the connector recovers
    await env.engine.executeAction(env.maya, id, act.id);
    expect(row(env, 'SELECT * FROM actions WHERE id=?', act.id)).toMatchObject({ status: 'verified' });
    expect(calls.execute).toBe(1);                      // effect observed, not repeated
    expect(rows(env, "SELECT * FROM audit_events WHERE mission_id=? AND type='action_effect_observed'", id).length).toBeGreaterThanOrEqual(1);
  });
});
