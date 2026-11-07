/**
 * Contradiction detection and documented authority resolution.
 *
 * A Q record (qualifying state) and an N record (non-qualifying state) DEFINITELY conflict when, for every clock
 * offset and every timestamp placement allowed by their uncertainty, their claims overlap in positive measure
 * (or the point claim falls inside the other interval). Only definite conflicts are contradictions; a pair that
 * overlaps for SOME offsets merely constrains the offsets (the bound engine handles that exactly).
 *
 * Resolution policy (never silent; every set-aside record stays in the output with its reason):
 *  1. rank gap ≥ policy.resolveByAuthorityMinGap → the lower-authority record is set aside for the computation;
 *  2. otherwise the conflict is UNRESOLVED and BOTH records are set aside, so the result holds whichever is wrong.
 */
import type { NormRecord } from './evidence.js';
import { formatInstant } from './time.js';
import type { Conflict, ForensicsPolicy, Segment } from './types.js';

export function segment(s: number, e: number): Segment {
  return { start: formatInstant(s), end: formatInstant(e), startMs: s, endMs: e, durationMs: e - s };
}

/** Relative-offset half-width between two records' clocks (0 when they share a clock). */
export function relativeRange(a: NormRecord, b: NormRecord, clockU: Map<string, number>): number {
  return a.clockId === b.clockId ? 0 : (clockU.get(a.clockId) ?? 0) + (clockU.get(b.clockId) ?? 0);
}

/** The overlap guaranteed under every offset, in `q`'s corrected clock frame, or null if none is guaranteed. */
export function definiteOverlap(q: NormRecord, n: NormRecord, R: number): [number, number] | null {
  if (q.kind === 'INTERVAL' && n.kind === 'INTERVAL') {
    const a1 = q.sHi; const b1 = q.eLo; const a2 = n.sHi; const b2 = n.eLo;
    if (a1 >= b1 || a2 >= b2) return null;
    // overlap(ρ) ⇔ ρ ∈ (a2 − b1, b2 − a1); definite ⇔ [−R, R] inside that open interval.
    if (a2 - b1 < -R && R < b2 - a1) return [Math.max(a1, a2 + R), Math.min(b1, b2 - R)];
    return null;
  }
  if (q.kind === 'POINT' && n.kind === 'INTERVAL') {
    if (n.sHi >= n.eLo) return null;
    return q.sLo - R >= n.sHi && q.sHi + R < n.eLo ? [q.sLo, q.sHi + 1] : null;
  }
  if (q.kind === 'INTERVAL' && n.kind === 'POINT') {
    if (q.sHi >= q.eLo) return null;
    return n.sLo - R >= q.sHi && n.sHi + R < q.eLo ? [n.sLo, n.sHi + 1] : null;
  }
  return R === 0 && q.sLo === q.sHi && n.sLo === n.sHi && q.sLo === n.sLo ? [q.sLo, q.sLo + 1] : null;
}

/** Whether the pair overlaps for at least one admissible offset (it then constrains the offsets). */
export function possibleOverlap(q: NormRecord, n: NormRecord, R: number): boolean {
  const qs = q.kind === 'INTERVAL' ? q.sHi : q.sLo; const qe = q.kind === 'INTERVAL' ? q.eLo : q.sHi + 1;
  const ns = n.kind === 'INTERVAL' ? n.sHi : n.sLo; const ne = n.kind === 'INTERVAL' ? n.eLo : n.sHi + 1;
  if (qs >= qe || ns >= ne) return false;
  return ns - qe < R && -R < ne - qs;
}

export interface Resolution { conflicts: Conflict[]; setAside: Map<string, { code: 'SET_ASIDE_BY_AUTHORITY' | 'SET_ASIDE_UNRESOLVED_CONFLICT'; conflictId: string }> }

export function resolveConflicts(records: readonly NormRecord[], clockU: Map<string, number>, policy: ForensicsPolicy, idPrefix = 'C'): Resolution {
  const qs = records.filter((r) => r.polarity === 'Q'); const ns = records.filter((r) => r.polarity === 'N');
  const found: { q: NormRecord; n: NormRecord; ov: [number, number] }[] = [];
  for (const q of qs) for (const n of ns) {
    const ov = definiteOverlap(q, n, relativeRange(q, n, clockU));
    if (ov) found.push({ q, n, ov });
  }
  // Deterministic order: largest rank gap first (most clearly resolvable), then keys.
  found.sort((x, y) => Math.abs(y.q.rank - y.n.rank) - Math.abs(x.q.rank - x.n.rank) || (x.q.key + x.n.key < y.q.key + y.n.key ? -1 : 1));
  const setAside: Resolution['setAside'] = new Map();
  const conflicts: Conflict[] = [];
  let i = 0;
  for (const f of found) {
    const id = `${idPrefix}${++i}`;
    const ids = [...new Set([...f.q.evidenceIds, ...f.n.evidenceIds])];
    const ov = segment(f.ov[0], f.ov[1]);
    const qDesc = `${f.q.key} (${f.q.authority}) says the service was in a qualifying state`;
    const nDesc = `${f.n.key} (${f.n.authority}) says it was not`;
    if (setAside.has(f.q.key) || setAside.has(f.n.key)) {
      conflicts.push({ id, type: 'STATE_CONTRADICTION', evidenceIds: ids, resolution: setAside.get(f.q.key)?.code === 'SET_ASIDE_BY_AUTHORITY' || setAside.get(f.n.key)?.code === 'SET_ASIDE_BY_AUTHORITY' ? 'RESOLVED_BY_AUTHORITY' : 'UNRESOLVED', setAside: [], explanation: `${qDesc}; ${nDesc}. Already handled: a participant was set aside by an earlier conflict.`, overlap: ov });
      continue;
    }
    const gap = Math.abs(f.q.rank - f.n.rank);
    if (gap >= policy.resolveByAuthorityMinGap) {
      const [win, lose] = f.q.rank > f.n.rank ? [f.q, f.n] : [f.n, f.q];
      setAside.set(lose.key, { code: 'SET_ASIDE_BY_AUTHORITY', conflictId: id });
      conflicts.push({ id, type: 'STATE_CONTRADICTION', evidenceIds: ids, resolution: 'RESOLVED_BY_AUTHORITY', kept: win.evidenceIds, setAside: lose.evidenceIds, explanation: `${qDesc}; ${nDesc}, under every admissible clock offset. Authority ${win.authority} outranks ${lose.authority} by ${gap} (policy threshold ${policy.resolveByAuthorityMinGap}), so ${lose.key} is set aside for the computation. It is not deleted.`, overlap: ov });
    } else {
      setAside.set(f.q.key, { code: 'SET_ASIDE_UNRESOLVED_CONFLICT', conflictId: id });
      setAside.set(f.n.key, { code: 'SET_ASIDE_UNRESOLVED_CONFLICT', conflictId: id });
      conflicts.push({ id, type: 'STATE_CONTRADICTION', evidenceIds: ids, resolution: 'UNRESOLVED', setAside: ids, explanation: `${qDesc}; ${nDesc}, under every admissible clock offset. Their authorities (${f.q.authority}, ${f.n.authority}) are too close to prefer either (gap ${gap} < ${policy.resolveByAuthorityMinGap}). Both are set aside, so any conclusion holds whichever of them is wrong.`, overlap: ov });
    }
  }
  return { conflicts, setAside };
}
