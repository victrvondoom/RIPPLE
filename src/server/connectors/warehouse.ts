import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from '../db/db.js';
import type { Connector, ConnectorRequest, ConnectorResult, Observation } from './index.js';
import { parseOp, readWarehouse, STATE_MARK, type Op, type Seed } from '../packs/revenue/lab.js';

interface State { seed: Seed | null; ops: Op[]; bodies: Record<string, string>; attempts: Record<string, number>; unreadable: number; faults: string[] }
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

/**
 * Warehouse SANDBOX connector (Reality Lab). Applies revenue-pipeline operations to a per-mission, file-backed sandbox and
 * reads the resulting warehouse state back independently. It never touches a real warehouse; its mode says so.
 *
 * Scripted scenario faults travel inside the approved operation (`fault`), are recorded, and fire once:
 *  - `lost_response`: the operation COMMITS, then the call reports a timeout, and the status endpoint is unreadable for one read.
 * The engine must therefore never assume failure from the error, and never repeat the write blindly.
 */
export class WarehouseSandboxConnector implements Connector {
  readonly key = 'warehouse_sandbox';
  readonly name = 'Warehouse sandbox (Reality Lab)';
  readonly mode = 'sandbox';
  readonly description = 'Applies revenue-pipeline operations to a labelled per-mission warehouse sandbox and reads the state back. Not a production warehouse.';
  constructor(private root: string) {}
  private file(ws: string, m: string) { return resolve(join(this.root, safe(ws), safe(m), 'warehouse', 'state.json')); }
  private load(ws: string, m: string): State | null { const f = this.file(ws, m); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as State : null; }
  private save(ws: string, m: string, s: State) { const f = this.file(ws, m); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s), 'utf8'); }

  execute(req: ConnectorRequest): ConnectorResult {
    const o = parseOp(req.body);
    if (!o) throw new Error('Not a warehouse sandbox operation (no ripple-op block in the approved document).');
    const s = this.load(req.workspaceId, req.missionId) ?? { seed: o.seed, ops: [], bodies: {}, attempts: {}, unreadable: 0, faults: [] };
    s.attempts[req.idempotencyKey] = (s.attempts[req.idempotencyKey] ?? 0) + 1;
    const deduped = s.ops.some((x) => x.key === req.idempotencyKey);
    if (!deduped) { s.ops.push({ key: req.idempotencyKey, op: o.op }); s.bodies[req.idempotencyKey] = req.body; }
    const location = `${this.file(req.workspaceId, req.missionId)}#${o.op}`;
    if (o.fault === 'lost_response' && s.attempts[req.idempotencyKey] === 1) {
      s.unreadable = 1; s.faults.push(`${o.op}: committed, then the response was lost and the status endpoint was unreadable once`);
      this.save(req.workspaceId, req.missionId, s);
      throw new Error(`Warehouse API timed out after 30 s while running "${o.op}" (scripted scenario fault in the sandbox)`);
    }
    this.save(req.workspaceId, req.missionId, s);
    return { effectId: sha256(location + req.idempotencyKey).slice(0, 12), location, contentHash: sha256(req.body), deduped, deliveryNote: 'Applied to the Reality Lab warehouse sandbox only; no production warehouse was touched.' };
  }

  observe(req: Pick<ConnectorRequest, 'workspaceId' | 'missionId' | 'idempotencyKey'>): Observation {
    const s = this.load(req.workspaceId, req.missionId);
    const location = this.file(req.workspaceId, req.missionId);
    if (!s || !s.seed) return { found: false, content: '', contentHash: '', count: 0, location };
    if (s.unreadable > 0) { s.unreadable -= 1; this.save(req.workspaceId, req.missionId, s); throw new Error('Warehouse status endpoint unavailable (scripted scenario fault in the sandbox)'); }
    const count = s.ops.filter((x) => x.key === req.idempotencyKey).length;
    if (!count) return { found: false, content: '', contentHash: '', count: 0, location };
    const content = `${s.bodies[req.idempotencyKey]}${STATE_MARK}${JSON.stringify(readWarehouse(s.seed, s.ops))}`;
    return { found: true, content, contentHash: sha256(content), count, location };
  }
}
