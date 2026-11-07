import { createHash } from 'node:crypto';
import { buildTree } from '../seal/merkle.js';

/**
 * Machine-verifiable receipts (session 21). PURE.
 *
 *  - Verifier receipt: the independent verifier's PASS/FAIL over the checks it ran itself, bound to the case revision,
 *    the approved payload hashes and a digest of the read-backs it inspected. FAIL carries a work order.
 *  - Resolution receipt: the case's final record (intent, timeline, rooms, handoffs, evidence root, human decisions,
 *    payload hashes, observations, executions, verifier verdict, recovery history, remaining uncertainty, status).
 *
 * Both are canonical JSON hashed with SHA-256, plus a Merkle root over their top-level sections so one section can be
 * shown without the rest. verifyReceipt recomputes both; any edited byte is detected. These receipts are tamper-EVIDENT,
 * not signed: who issued one is established by where it was published (the Switch room document) and by the optional
 * Ed25519 ledger receipt (api/receipt.ts).
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

export interface SealedReceipt<T extends Record<string, unknown>> { body: T; bodyHash: string; sectionRoot: string; sections: string[] }

export function sealReceipt<T extends Record<string, unknown>>(body: T): SealedReceipt<T> {
  const sections = Object.keys(body).sort();
  const tree = buildTree(sections.map((k) => `${k}=${canonical(body[k])}`));
  return { body, bodyHash: sha(canonical(body)), sectionRoot: tree.root, sections };
}

export function verifyReceipt(r: { body: Record<string, unknown>; bodyHash: string; sectionRoot: string }): { ok: boolean; reason: string } {
  if (!r || typeof r.body !== 'object' || !r.body) return { ok: false, reason: 'no receipt body' };
  const h = sha(canonical(r.body));
  if (h !== r.bodyHash) return { ok: false, reason: `body hash mismatch: recomputed ${h.slice(0, 12)}…, receipt says ${String(r.bodyHash).slice(0, 12)}…` };
  const sections = Object.keys(r.body).sort();
  const root = buildTree(sections.map((k) => `${k}=${canonical(r.body[k])}`)).root;
  if (root !== r.sectionRoot) return { ok: false, reason: 'section Merkle root mismatch' };
  return { ok: true, reason: 'body hash and section root recomputed and equal' };
}

export interface VerifierCheck { name: string; passed: boolean; detail: string; ownerRole?: string; fix?: string }
export function verifierReceiptBody(a: { caseRef: string; missionId: string; analysisRev: number; verifier: string; checks: VerifierCheck[]; inputsDigest: string; payloadHashes: string[]; issuedAt: string }) {
  const passed = a.checks.length > 0 && a.checks.every((c) => c.passed);
  return {
    format: 'ripple-verifier-receipt/1', caseRef: a.caseRef, missionId: a.missionId, analysisRev: a.analysisRev, verifier: a.verifier,
    result: passed ? 'PASS' : 'FAIL', checks: a.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
    inputsDigest: a.inputsDigest, payloadHashes: [...a.payloadHashes].sort(), issuedAt: a.issuedAt,
    workOrder: passed ? [] : a.checks.filter((c) => !c.passed).map((c, i) => ({ id: `WO-${i + 1}`, check: c.name, owner: c.ownerRole ?? 'incident commander', action: c.fix ?? `Resolve: ${c.detail}`, status: 'open' })),
    limits: ['The verifier reads approved payloads, approval rows and connector read-backs only; it never reads an executor report.', 'Connector targets are the labelled sandbox ledger and dry-run outbox: no money moved, no email was sent.'],
  };
}
