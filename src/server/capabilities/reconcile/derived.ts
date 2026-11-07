/**
 * Derived-value reconciliation (session 16; inherited from Rupiverse's cached balance with self-heal). A value kept as a cache
 * is recomputed from its source rows and compared; the difference is shown, never silently overwritten.
 * Pure. Values are integers (minor currency units, or counts), so there is no floating-point drift. A missing cached value is
 * reported as such, not as zero.
 * Imported by api/dashboards.ts (ledger seal check: cached event count vs recomputed count).
 */
export type DerivedStatus = 'match' | 'gap' | 'no-cached-value';
export interface DerivedCheck {
  label: string;
  cached: number | null;
  recomputed: number;
  /** cached − recomputed; null when there is no cached value */
  gap: number | null;
  status: DerivedStatus;
  explanation: string;
}

function requireInteger(name: string, v: number) {
  if (!Number.isInteger(v)) throw new Error(`${name} must be an integer (minor units or a count), got ${v}`);
}

/** Compares a cached value with its recomputed value. `tolerance` is an absolute allowance in the same integer unit. */
export function reconcileDerived(label: string, cached: number | null | undefined, recomputed: number, tolerance = 0): DerivedCheck {
  requireInteger('recomputed', recomputed);
  if (cached === null || cached === undefined) {
    return { label, cached: null, recomputed, gap: null, status: 'no-cached-value', explanation: `${label}: no cached value is stored, so there is nothing to compare. Recomputed value is ${recomputed}.` };
  }
  requireInteger('cached', cached);
  const gap = cached - recomputed;
  if (Math.abs(gap) <= tolerance) return { label, cached, recomputed, gap, status: 'match', explanation: `${label}: cached ${cached} matches the recomputed ${recomputed}.` };
  return { label, cached, recomputed, gap, status: 'gap', explanation: `${label}: cached ${cached} differs from the recomputed ${recomputed} by ${gap > 0 ? '+' : ''}${gap}. The cache is not overwritten; the difference is shown for review.` };
}

/** Compares a figure the person entered (e.g. a bank statement balance) with the recomputed one. The gap is shown, not corrected. */
export function reconcileStatement(label: string, recomputed: number, statement: number, tolerance = 0): DerivedCheck {
  const c = reconcileDerived(`${label} (statement)`, statement, recomputed, tolerance);
  return { ...c, label, cached: statement, explanation: c.status === 'match' ? `${label}: the statement ${statement} agrees with the recomputed ${recomputed}.` : `${label}: the statement ${statement} differs from the recomputed ${recomputed} by ${(statement - recomputed) > 0 ? '+' : ''}${statement - recomputed}. Nothing was corrected; review the rows.` };
}
