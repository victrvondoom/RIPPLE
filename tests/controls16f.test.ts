import { describe, it, expect } from 'vitest';
import { reconcileDerived, reconcileStatement } from '../src/server/capabilities/reconcile/derived.js';
import { verifySeals, sealLedger } from '../src/server/api/dashboards.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { makeEnv, newBaselinedMission } from './helpers.js';

/** Session 16 (sixth group): derived-value reconciliation. */

describe('reconcileDerived (pure)', () => {
  it('reports match, gap and no cached value without inventing a zero', () => {
    expect(reconcileDerived('balance', 4200, 4200)).toMatchObject({ status: 'match', gap: 0 });
    const gap = reconcileDerived('balance', 4500, 4200);
    expect(gap).toMatchObject({ status: 'gap', gap: 300, cached: 4500, recomputed: 4200 });
    expect(gap.explanation).toMatch(/not overwritten/);
    expect(reconcileDerived('balance', null, 4200)).toMatchObject({ status: 'no-cached-value', gap: null, cached: null });
  });

  it('honours an explicit integer tolerance and refuses non-integers', () => {
    expect(reconcileDerived('count', 10, 9, 1).status).toBe('match');
    expect(() => reconcileDerived('balance', 42.5, 42)).toThrow(/integer/);
  });

  it('compares an entered statement with the recomputed figure and shows the difference, never correcting it', () => {
    const c = reconcileStatement('Operating account', 100_000, 99_250);
    expect(c.status).toBe('gap');
    expect(c.gap).toBe(-750); // statement − recomputed: the statement is 750 below the recomputed balance
    expect(c.explanation).toMatch(/Nothing was corrected/);
    expect(reconcileStatement('Operating account', 100_000, 100_000).status).toBe('match');
  });
});

describe('reconciliation on the ledger seal (trust dashboard)', () => {
  it('a sealed chain reconciles with no gap; deleting an event the seal covers shows the gap', async () => {
    const e = makeEnv(new LocalCollab(), extendedRegistry());
    await newBaselinedMission(e, 'beo-rescue');
    sealLedger(e.engine, e.maya);
    const intact = verifySeals(e.engine, e.maya.workspaceId).seals[0];
    expect(intact.reconciliation).toMatchObject({ status: 'match', gap: 0 });
    e.db.exec("DELETE FROM audit_events WHERE rowid=(SELECT MIN(rowid) FROM audit_events WHERE workspace_id=?)", e.maya.workspaceId);
    const broken = verifySeals(e.engine, e.maya.workspaceId).seals[0];
    expect(broken.intact).toBe(false);
    expect(broken.reconciliation).toMatchObject({ status: 'gap', gap: 1 });
  });

  it('a seal made before the covered rowid was recorded reports no cached value, not a gap', async () => {
    const e = makeEnv(new LocalCollab(), extendedRegistry());
    await newBaselinedMission(e, 'beo-rescue');
    sealLedger(e.engine, e.maya);
    e.db.exec('UPDATE ledger_seals SET last_rowid=NULL WHERE workspace_id=?', e.maya.workspaceId);
    const legacy = verifySeals(e.engine, e.maya.workspaceId).seals[0];
    expect(legacy.reconciliation).toMatchObject({ status: 'no-cached-value', gap: null });
  });
});
