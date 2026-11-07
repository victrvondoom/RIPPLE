import { createHash } from 'node:crypto';
import { buildTree, proofFor, verifyStep, type ProofStep } from '../seal/merkle.js';

/**
 * Selective evidence disclosure (session 21). PURE.
 *
 * A case's evidence records (incident monitor intervals, deploy log lines, status-page entries, ledger rows, prior
 * support commitments) are committed ONCE into a Merkle tree. Each leaf commits to the record AND a per-record salt,
 * so the published root and leaf positions reveal nothing about undisclosed records (a guessed record cannot be
 * confirmed without its salt). A participant who needs one fact receives only that record, its salt and its proof path;
 * anyone can recompute the root and check that the record belongs to the ORIGINAL committed set.
 *
 * verifyDisclosure refuses: forged records (not in the set), modified records (content changed), incomplete
 * disclosures (a requested record missing, or a truncated proof), and unrelated records (valid for another manifest,
 * or not among the records that were requested).
 */
export interface DisclosableRecord { id: string; kind: string; source: string; room: string; content: string }
export interface ManifestPublic { format: 'ripple-evidence-manifest/1'; root: string; count: number; leaves: { index: number; id: string; kind: string; source: string; room: string }[] }
export interface Disclosure { index: number; record: DisclosableRecord; salt: string; proof: ProofStep[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const canon = (r: DisclosableRecord, salt: string) => JSON.stringify([r.id, r.kind, r.source, r.room, r.content, salt]);
/** Per-record salt derived from a case secret that never leaves the server. */
export const recordSalt = (caseSecret: string, recordId: string) => sha(`ripple-evidence-salt|${caseSecret}|${recordId}`);

export function buildManifest(records: DisclosableRecord[], caseSecret: string): { manifest: ManifestPublic; leafStrings: string[] } {
  if (!records.length) throw new Error('an evidence manifest needs at least one record');
  const ids = new Set<string>();
  for (const r of records) { if (ids.has(r.id)) throw new Error(`duplicate evidence record id ${r.id}`); ids.add(r.id); }
  const leafStrings = records.map((r) => canon(r, recordSalt(caseSecret, r.id)));
  const tree = buildTree(leafStrings);
  return { manifest: { format: 'ripple-evidence-manifest/1', root: tree.root, count: records.length, leaves: records.map((r, index) => ({ index, id: r.id, kind: r.kind, source: r.source, room: r.room })) }, leafStrings };
}

/** Discloses exactly the requested ids (in request order). Unknown ids throw: nothing outside the set can be disclosed. */
export function disclose(records: DisclosableRecord[], caseSecret: string, ids: string[]): Disclosure[] {
  const { leafStrings } = buildManifest(records, caseSecret);
  const tree = buildTree(leafStrings);
  return ids.map((id) => {
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`evidence record ${id} is not in this case's manifest`);
    return { index, record: records[index]!, salt: recordSalt(caseSecret, id), proof: proofFor(tree, index) };
  });
}

export function verifyDisclosure(pub: Pick<ManifestPublic, 'root' | 'count'>, disclosures: Disclosure[], requestedIds: string[]): { ok: boolean; items: { id: string; ok: boolean; reason: string }[]; problems: string[] } {
  const problems: string[] = [];
  const items = disclosures.map((d) => {
    const id = d?.record?.id ?? '(no id)';
    if (!requestedIds.includes(id)) return { id, ok: false, reason: 'unrelated: this record was not requested' };
    if (!d.salt || !/^[0-9a-f]{64}$/.test(d.salt)) return { id, ok: false, reason: 'incomplete: missing or malformed salt' };
    const v = verifyStep(pub.root, pub.count, d.index, canon(d.record, d.salt), d.proof ?? []);
    return { id, ok: v.ok, reason: v.ok ? 'belongs to the committed evidence set' : v.reason.includes('proof has') ? `incomplete: ${v.reason}` : `forged or modified: ${v.reason}` };
  });
  for (const id of requestedIds) if (!disclosures.some((d) => d?.record?.id === id)) problems.push(`incomplete: requested record ${id} was not disclosed`);
  const seen = new Set<string>(); for (const d of disclosures) { const id = d?.record?.id; if (id && seen.has(id)) problems.push(`duplicate disclosure of ${id}`); if (id) seen.add(id); }
  return { ok: items.length > 0 && items.every((i) => i.ok) && !problems.length, items, problems };
}
