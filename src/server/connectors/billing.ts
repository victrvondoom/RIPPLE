import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from '../db/db.js';
import type { Connector, ConnectorRequest, ConnectorResult, Observation } from './index.js';
import { parseOp, readLedger, refusal, STATE_MARK, type AppliedOp, type Seed } from '../packs/billing/ledger.js';

interface State { seed: Seed; ops: AppliedOp[]; bodies: Record<string, string>; attempts: Record<string, number>; unreadable: number; faults: string[] }
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

/**
 * Billing SANDBOX connector: refunds and service credits against a labelled, per-mission test ledger, with an independent
 * read-back of the ledger. It never contacts Stripe, a bank or any payment provider; its mode says so.
 * Two independent duplicate-refund guards: RIPPLE's idempotency key (same approved content = same effect) and the
 * provider-side rule in `refusal` (a charge is refunded at most once, whatever key is used).
 * Scripted fault (`fault: "lost_response"` in the approved operation, fires once): the refund COMMITS, the call then times
 * out, and the status read is unavailable once — so the engine records EXECUTION_UNKNOWN and must read back before retrying.
 */
export class BillingSandboxConnector implements Connector {
  readonly key = 'billing_sandbox';
  readonly name = 'Billing sandbox (test ledger)';
  readonly mode = 'sandbox';
  readonly description = 'Applies refunds and service credits to a labelled per-mission test ledger and reads it back. Not a payment provider.';
  constructor(private root: string) {}
  private file(ws: string, m: string) { return resolve(join(this.root, safe(ws), safe(m), 'billing', 'state.json')); }
  private load(ws: string, m: string): State | null { const f = this.file(ws, m); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as State : null; }
  private save(ws: string, m: string, s: State) { const f = this.file(ws, m); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s), 'utf8'); }

  execute(req: ConnectorRequest): ConnectorResult {
    const o = parseOp(req.body);
    if (!o) throw new Error('Not a billing sandbox operation (no ripple-billing block in the approved document).');
    const s = this.load(req.workspaceId, req.missionId) ?? { seed: o.seed, ops: [], bodies: {}, attempts: {}, unreadable: 0, faults: [] };
    s.attempts[req.idempotencyKey] = (s.attempts[req.idempotencyKey] ?? 0) + 1;
    const deduped = s.ops.some((x) => x.key === req.idempotencyKey);
    const location = `${this.file(req.workspaceId, req.missionId)}#${o.op}:${o.chargeId ?? o.account}`;
    if (!deduped) {
      const why = refusal(s.seed, s.ops, o);
      if (why) { this.save(req.workspaceId, req.missionId, s); throw new Error(`Billing sandbox refused the ${o.op}: ${why}`); }
      s.ops.push({ key: req.idempotencyKey, op: o.op, chargeId: o.chargeId, amount: o.amount }); s.bodies[req.idempotencyKey] = req.body;
    }
    if (o.fault === 'lost_response' && s.attempts[req.idempotencyKey] === 1) {
      s.unreadable = 1; s.faults.push(`${o.op} ${o.chargeId ?? ''}: committed, then the response was lost and the status read was unavailable once`);
      this.save(req.workspaceId, req.missionId, s);
      throw new Error(`Billing API timed out after 30 s on ${o.op} ${o.chargeId ?? ''} (scripted scenario fault in the sandbox)`);
    }
    this.save(req.workspaceId, req.missionId, s);
    return { effectId: sha256(location + req.idempotencyKey).slice(0, 12), location, contentHash: sha256(req.body), deduped, deliveryNote: 'Applied to the billing sandbox only; no payment provider was contacted and no money moved.' };
  }

  observe(req: Pick<ConnectorRequest, 'workspaceId' | 'missionId' | 'idempotencyKey'>): Observation {
    const s = this.load(req.workspaceId, req.missionId); const location = this.file(req.workspaceId, req.missionId);
    if (!s) return { found: false, content: '', contentHash: '', count: 0, location };
    if (s.unreadable > 0) { s.unreadable -= 1; this.save(req.workspaceId, req.missionId, s); throw new Error('Billing status endpoint unavailable (scripted scenario fault in the sandbox)'); }
    const count = s.ops.filter((x) => x.key === req.idempotencyKey).length;
    if (!count) return { found: false, content: '', contentHash: '', count: 0, location };
    const content = `${s.bodies[req.idempotencyKey]}${STATE_MARK}${JSON.stringify(readLedger(s.seed, s.ops))}`;
    return { found: true, content, contentHash: sha256(content), count, location };
  }
}
