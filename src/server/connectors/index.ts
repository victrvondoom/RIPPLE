import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../db/db.js';
import { WarehouseSandboxConnector } from './warehouse.js';
import { BillingSandboxConnector } from './billing.js';

export interface ConnectorRequest { workspaceId: string; missionId: string; idempotencyKey: string; subject: string; target: string; body: string }
export interface ConnectorResult { effectId: string; location: string; contentHash: string; deduped: boolean; deliveryNote: string }
export interface Observation { found: boolean; content: string; contentHash: string; count: number; location: string }
export interface Connector {
  key: string; name: string; mode: string; description: string;
  execute(req: ConnectorRequest): ConnectorResult;
  /** Independent read-back of the real effect (never trusts execute()'s return value). */
  observe(req: Pick<ConnectorRequest, 'workspaceId' | 'missionId' | 'idempotencyKey'>): Observation;
}

/**
 * File-backed local connectors. These perform a REAL, observable effect (a file in the outbox) but they do NOT
 * reach external systems: nothing is emailed, no chat is posted. Their `mode` says so and it is surfaced in the UI/evidence.
 */
class FileConnector implements Connector {
  constructor(public key: string, public name: string, public mode: string, public description: string, private dir: string, private root: string, private ext: string, private deliveryNote: string) {}
  private folder(ws: string, m: string) { return resolve(join(this.root, safe(ws), safe(m), this.dir)); }
  private path(r: Pick<ConnectorRequest, 'workspaceId' | 'missionId' | 'idempotencyKey'>) { return join(this.folder(r.workspaceId, r.missionId), `${safe(r.idempotencyKey)}.${this.ext}`); }
  execute(req: ConnectorRequest): ConnectorResult {
    const path = this.path(req);
    const deduped = existsSync(path);                               // idempotency: same key => same single effect
    const body = this.ext === 'eml' ? `To: ${req.target}\nSubject: ${req.subject}\nX-Ripple-Idempotency-Key: ${req.idempotencyKey}\nX-Ripple-Delivery: DRY-RUN (not sent)\n\n${req.body}` : req.body;
    if (!deduped) { mkdirSync(this.folder(req.workspaceId, req.missionId), { recursive: true }); writeFileSync(path, body, 'utf8'); }
    return { effectId: sha256(path).slice(0, 12), location: path, contentHash: sha256(deduped ? readFileSync(path, 'utf8') : body), deduped, deliveryNote: this.deliveryNote };
  }
  observe(req: Pick<ConnectorRequest, 'workspaceId' | 'missionId' | 'idempotencyKey'>): Observation {
    const path = this.path(req);
    if (!existsSync(path)) return { found: false, content: '', contentHash: '', count: 0, location: path };
    const content = readFileSync(path, 'utf8');
    const count = readdirSync(this.folder(req.workspaceId, req.missionId)).filter((f) => f.startsWith(safe(req.idempotencyKey))).length;
    return { found: true, content, contentHash: sha256(content), count, location: path };
  }
}
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

export function buildConnectors(root: string): Record<string, Connector> {
  return {
    document_store: new FileConnector('document_store', 'Document store', 'local-filesystem', 'Writes the document to the mission document store (local files).', 'documents', root, 'md', 'Stored locally; no external document system connected.'),
    internal_notify: new FileConnector('internal_notify', 'Internal notification', 'local-outbox', 'Queues an internal notification to a department lead in the local outbox. Nothing is pushed to chat/email.', 'notifications', root, 'txt', 'Queued in local outbox only; recipient is NOT actually notified outside RIPPLE.'),
    email_outbox: new FileConnector('email_outbox', 'Email outbox (dry-run)', 'dry-run', 'Writes an .eml file. No SMTP configured — nothing is sent.', 'email', root, 'eml', 'DRY-RUN: no email was sent.'),
    warehouse_sandbox: new WarehouseSandboxConnector(root),
    billing_sandbox: new BillingSandboxConnector(root),
  };
}
