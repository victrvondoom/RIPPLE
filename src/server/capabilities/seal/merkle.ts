import { createHash } from 'node:crypto';

/**
 * Session seal (Flipside capability): a Merkle tree over the steps of a private agent session.
 * Pure and offline; standard-library SHA-256 only. Leaves and nodes are domain-separated (0x00 / 0x01 prefix) so an
 * inner node can never be presented as a leaf. An odd node at a level is paired with itself.
 * The root commits to every step; one step plus its sibling hashes proves that step is in the sealed session without
 * revealing any other step's content.
 */
const h = (prefix: number, ...parts: string[]) => createHash('sha256').update(Buffer.from([prefix])).update(parts.join('')).digest('hex');
export const leafHash = (index: number, content: string) => h(0, String(index), ':', content);
const nodeHash = (l: string, r: string) => h(1, l, r);

export interface SealTree { root: string; levels: string[][] }
export interface ProofStep { hash: string; side: 'left' | 'right' }

export function buildTree(stepContents: string[]): SealTree {
  if (stepContents.length === 0) throw new Error('cannot seal an empty session');
  let level = stepContents.map((c, i) => leafHash(i, c));
  const levels = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1] ?? level[i]));
    levels.push(next); level = next;
  }
  return { root: level[0], levels };
}

/** Sibling hashes from the leaf up to the root. */
export function proofFor(tree: SealTree, index: number): ProofStep[] {
  if (index < 0 || index >= tree.levels[0].length) throw new Error('step index out of range');
  const proof: ProofStep[] = []; let i = index;
  for (let d = 0; d < tree.levels.length - 1; d++) {
    const lv = tree.levels[d]; const sib = i % 2 === 0 ? (lv[i + 1] ?? lv[i]) : lv[i - 1];
    proof.push({ hash: sib, side: i % 2 === 0 ? 'right' : 'left' }); i = Math.floor(i / 2);
  }
  return proof;
}

/** Recomputes the root from one disclosed step and compares it with the sealed root. */
export function verifyStep(root: string, leafCount: number, index: number, content: string, proof: ProofStep[]): { ok: boolean; reason: string } {
  if (!Number.isInteger(index) || index < 0 || index >= leafCount) return { ok: false, reason: 'step index is outside the sealed session' };
  let depth = 0; for (let n = leafCount; n > 1; n = Math.ceil(n / 2)) depth++;
  if (proof.length !== depth) return { ok: false, reason: `proof has ${proof.length} hashes; a ${leafCount}-step seal needs ${depth}` };
  let cur = leafHash(index, content); let i = index;
  for (const p of proof) {
    if (!/^[0-9a-f]{64}$/.test(p.hash)) return { ok: false, reason: 'malformed proof hash' };
    const expectedSide = i % 2 === 0 ? 'right' : 'left';
    if (p.side !== expectedSide) return { ok: false, reason: 'proof path does not match the step position' };
    cur = p.side === 'right' ? nodeHash(cur, p.hash) : nodeHash(p.hash, cur); i = Math.floor(i / 2);
  }
  return cur === root ? { ok: true, reason: 'recomputed root equals the sealed root' } : { ok: false, reason: 'recomputed root differs from the sealed root' };
}
