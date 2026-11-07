/**
 * Portable, signed ledger receipt (session 16). Inherited from switch-notary (offline-verifiable receipts over a
 * hash-chained ledger) and Shipyard (hash-chained audit log with verify).
 *
 * RIPPLE already had an internal hash chain over the audit log plus ledger seals (dashboards.ts). What it did NOT have is a
 * statement an outsider can check: "as of this time, the workspace audit log had N events with head H, and I, the holder of this
 * key, say so". A receipt is that statement, signed with Ed25519 when RIPPLE_RECEIPT_PRIVATE_KEY is configured.
 *
 * Honest limits, carried in the receipt itself:
 *  - Unsigned receipts (no key configured) prove nothing about who issued them; they only record the chain head.
 *  - A signature made with the key embedded in the receipt proves internal consistency, not identity. A verifier must supply
 *    the trusted public key out of band.
 *  - The receipt proves the first `events` audit rows still hash to `head`. It does not prove the events were complete or true.
 *  - Keys never live in git. RIPPLE_RECEIPT_PRIVATE_KEY is read from the environment only.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { Actor, Engine } from '../engine/engine.js';
import { nowIso, stable, uid } from '../db/db.js';
import { auditChain } from './dashboards.js';

export const RECEIPT_FORMAT = 'ripple-ledger-receipt/1';

export interface LedgerReceipt {
  format: typeof RECEIPT_FORMAT;
  workspaceId: string;
  issuedAt: string;
  issuedBy: string;
  receiptId: string;
  chain: { events: number; head: string; algorithm: 'sha256-chain over audit_events rowid order' };
  signed: boolean;
  signature: { algorithm: 'Ed25519'; value: string; publicKey: string } | null;
  labels: string[];
}

/** Loads the signing key from the environment (PEM PKCS#8). `\n` escapes are accepted so a one-line env value works. */
export function receiptSigningKey(env: NodeJS.ProcessEnv = process.env): KeyObject | null {
  const pem = env.RIPPLE_RECEIPT_PRIVATE_KEY;
  if (!pem || !pem.trim()) return null;
  return createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem);
}

/** The exact bytes that are signed. Canonical (stable) so the same statement always yields the same payload. */
export function receiptPayload(r: Pick<LedgerReceipt, 'format' | 'workspaceId' | 'issuedAt' | 'receiptId' | 'chain'>): string {
  return stable({ format: r.format, workspaceId: r.workspaceId, issuedAt: r.issuedAt, receiptId: r.receiptId, chain: r.chain });
}

/** Issues a receipt over the current audit chain head. Manager or owner only. The issuance itself is audited AFTER the head is taken. */
export function issueReceipt(e: Engine, a: Actor, env: NodeJS.ProcessEnv = process.env): LedgerReceipt {
  e.require(a, 'owner', 'manager');
  const ch = auditChain(e, a.workspaceId);
  const key = receiptSigningKey(env);
  const base = { format: RECEIPT_FORMAT as typeof RECEIPT_FORMAT, workspaceId: a.workspaceId, issuedAt: nowIso(), receiptId: uid('rcpt') };
  const chain = { events: ch.count, head: ch.head, algorithm: 'sha256-chain over audit_events rowid order' as const };
  const labels: string[] = [];
  let signature: LedgerReceipt['signature'] = null;
  if (key) {
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    const value = sign(null, Buffer.from(receiptPayload({ ...base, chain })), key).toString('base64');
    signature = { algorithm: 'Ed25519', value, publicKey };
    labels.push('signed with Ed25519; verify against a public key you obtained out of band');
  } else {
    labels.push('UNSIGNED: RIPPLE_RECEIPT_PRIVATE_KEY is not configured. This records the chain head only and proves nothing about its issuer.');
  }
  labels.push('proves that the first `events` audit rows still hash to `head`; does not prove completeness or truth of the events');
  const receipt: LedgerReceipt = { ...base, issuedBy: a.name, chain, signed: !!key, signature, labels };
  e.audit(a.workspaceId, null, 'user', a.name, 'receipt_issued', `Ledger receipt ${receipt.receiptId} issued over ${ch.count} event(s) (${key ? 'signed' : 'unsigned'})`, { receiptId: receipt.receiptId, head: ch.head });
  return receipt;
}

export interface ReceiptVerdict {
  formatOk: boolean;
  workspaceMatches: boolean;
  signature: 'valid' | 'invalid' | 'absent';
  signerKey: 'trusted' | 'embedded-only' | 'none';
  prefixIntact: boolean;
  eventsNow: number;
  headNow: string;
  /** 'intact' only with a trusted key; 'consistent-untrusted' when the chain and an embedded-key signature agree but nobody trusted vouches for the key. */
  verdict: 'intact' | 'consistent-untrusted' | 'not-intact' | 'unsigned' | 'signature-invalid';
  explanation: string;
}

/**
 * Checks a receipt against the live ledger. `trustedPublicKeyPem` is what the verifier trusts; without it, a signature made by the
 * embedded key only shows the receipt is internally consistent.
 */
export function verifyReceipt(e: Engine, workspaceId: string, receipt: LedgerReceipt, trustedPublicKeyPem?: string): ReceiptVerdict {
  const formatOk = receipt?.format === RECEIPT_FORMAT && typeof receipt.chain?.head === 'string' && Number.isInteger(receipt.chain?.events) && receipt.chain.events >= 0;
  const workspaceMatches = formatOk && receipt.workspaceId === workspaceId;
  const now = auditChain(e, workspaceId);
  const prefixIntact = formatOk && now.count >= receipt.chain.events && auditChain(e, workspaceId, receipt.chain.events).head === receipt.chain.head;

  let signature: ReceiptVerdict['signature'] = 'absent';
  let signerKey: ReceiptVerdict['signerKey'] = 'none';
  if (formatOk && receipt.signed) {
    // A receipt that claims a signature but carries none (or a malformed one) is invalid, never "absent": otherwise it would pass as intact.
    if (!receipt.signature) {
      signature = 'invalid';
    } else {
      const keyPem = trustedPublicKeyPem ?? receipt.signature.publicKey;
      signerKey = trustedPublicKeyPem ? 'trusted' : 'embedded-only';
      try {
        const ok = verify(null, Buffer.from(receiptPayload(receipt)), createPublicKey(keyPem), Buffer.from(receipt.signature.value, 'base64'));
        signature = ok ? 'valid' : 'invalid';
      } catch {
        signature = 'invalid';
      }
    }
  }

  let verdict: ReceiptVerdict['verdict'];
  let explanation: string;
  if (!formatOk || !workspaceMatches) { verdict = 'not-intact'; explanation = 'Not a RIPPLE ledger receipt for this workspace.'; }
  else if (signature === 'invalid') { verdict = 'signature-invalid'; explanation = 'The signature does not match the receipt contents or the key supplied.'; }
  else if (!receipt.signed) { verdict = 'unsigned'; explanation = prefixIntact ? `Unsigned receipt. The first ${receipt.chain.events} event(s) still hash to the recorded head, but nothing shows who issued it.` : `Unsigned receipt, and the ledger changed after it: the first ${receipt.chain.events} event(s) no longer hash to the recorded head.`; }
  else if (!prefixIntact) { verdict = 'not-intact'; explanation = `The ledger changed after this receipt: the first ${receipt.chain.events} event(s) no longer hash to the signed head.`; }
  else if (signerKey !== 'trusted') { verdict = 'consistent-untrusted'; explanation = 'The chain is intact and the signature matches the key embedded in the receipt. No trusted public key was supplied, so this does not establish who signed it.'; }
  else { verdict = 'intact'; explanation = 'The chain is intact and the signature verifies against the trusted public key.'; }

  return { formatOk, workspaceMatches, signature, signerKey, prefixIntact, eventsNow: now.count, headNow: now.head, verdict, explanation };
}
