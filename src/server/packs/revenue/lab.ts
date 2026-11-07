/**
 * Revenue warehouse SANDBOX model (Reality Lab, not production).
 *
 * Pure and deterministic: given the order rows, the deploy that renamed a field and the operations applied so far,
 * it computes exactly what a read of the warehouse would show. Analyzers (pre-remediation observation), the sandbox
 * connector (post-action read-back) and the independent verifier all call THIS function, so nothing is typed in.
 */
export interface OrderRow { id: string; day: string; at: string; amount: number }
export interface Deploy { commit: string; baseCommit: string; service: string; deployedAt: string; renamed: { from: string; to: string }[] }
export interface Op { key: string; op: 'apply_mapping' | 'recompute' | 'rollback' | 'backfill' }
export interface Seed { orders: OrderRow[]; ledgerCents: number; deploy: Deploy; amountField: string }

export interface WarehouseRead {
  sandbox: string;
  deployedCommit: string;
  rows: number; ledgerRows: number;
  /** stored column populated per row after the deploy */
  storedField: Record<string, number>;
  nullUnderMapping: number;
  mapping: string;
  pipelineCents: number; ledgerCents: number;
  viewCents: number; viewFresh: boolean;
  perDay: { day: string; pipelineCents: number; ledgerCents: number }[];
  firstNullAt: string | null;
  fixtures: { name: string; row: Record<string, number | null>; mapped: number | null; want: number; ok: boolean }[];
  ops: string[];
}
export const SANDBOX_LABEL = 'Reality Lab warehouse sandbox (deterministic, labelled; not a production warehouse)';

type Cols = Record<string, number | null>;
/** Stored representation of each order after the deploy + ops. Rows written at/after deployedAt use the renamed column unless backfilled. */
function stored(seed: Seed, ops: Op[]) {
  const ren = seed.deploy.renamed.find((r) => r.from === seed.amountField);
  const backfilled = ops.some((o) => o.op === 'backfill');
  return seed.orders.map((o) => {
    const drifted = !!ren && o.at >= seed.deploy.deployedAt && !backfilled;
    const cols: Cols = drifted ? { [ren!.to]: o.amount } : { [seed.amountField]: o.amount };
    return { ...o, cols };
  });
}
function mapper(seed: Seed, ops: Op[]) {
  const ren = seed.deploy.renamed.find((r) => r.from === seed.amountField);
  const fixed = !!ren && ops.some((o) => o.op === 'apply_mapping');
  return {
    label: fixed ? `COALESCE(${seed.amountField}, ${ren!.to})` : seed.amountField,
    read: (cols: Cols): number | null => (fixed ? (cols[seed.amountField] ?? cols[ren!.to] ?? null) : (cols[seed.amountField] ?? null)),
  };
}

export function readWarehouse(seed: Seed, ops: Op[]): WarehouseRead {
  const rows = stored(seed, ops); const map = mapper(seed, ops);
  const vals = rows.map((r) => map.read(r.cols));
  const pipelineCents = vals.reduce<number>((s, v) => s + (v ?? 0), 0);
  // The revenue view is a materialised snapshot: it reflects the state at the LAST recompute (or the original state if never recomputed).
  const lastRecompute = ops.map((o, i) => (o.op === 'recompute' ? i : -1)).filter((i) => i >= 0).pop();
  const viewOps = lastRecompute === undefined ? [] : ops.slice(0, lastRecompute + 1);
  const vMap = mapper(seed, viewOps);
  const viewCents = stored(seed, viewOps).reduce<number>((s, r) => s + (vMap.read(r.cols) ?? 0), 0);
  const days = [...new Set(seed.orders.map((o) => o.day))].sort();
  const storedField: Record<string, number> = {};
  for (const r of rows) for (const k of Object.keys(r.cols)) storedField[k] = (storedField[k] ?? 0) + 1;
  const firstNullAt = rows.filter((_, i) => vals[i] === null).map((r) => r.at).sort()[0] ?? null;
  const ren = seed.deploy.renamed.find((r) => r.from === seed.amountField);
  const fx: { name: string; row: Cols; want: number }[] = [{ name: `legacy row (${seed.amountField})`, row: { [seed.amountField]: 4200 }, want: 4200 }];
  if (ren) fx.push({ name: `post-deploy row (${ren.to})`, row: { [ren.to]: 4200 }, want: 4200 });
  return {
    sandbox: SANDBOX_LABEL,
    deployedCommit: ops.some((o) => o.op === 'rollback') ? seed.deploy.baseCommit : seed.deploy.commit,
    rows: rows.length, ledgerRows: seed.orders.length, storedField,
    nullUnderMapping: vals.filter((v) => v === null).length, mapping: map.label,
    pipelineCents, ledgerCents: seed.ledgerCents, viewCents, viewFresh: viewCents === pipelineCents,
    perDay: days.map((d) => ({ day: d, pipelineCents: rows.reduce((s, r, i) => s + (r.day === d ? vals[i] ?? 0 : 0), 0), ledgerCents: seed.orders.filter((o) => o.day === d).reduce((s, o) => s + o.amount, 0) })),
    firstNullAt, fixtures: fx.map((f) => { const mapped = map.read(f.row); return { ...f, mapped, ok: mapped === f.want }; }),
    ops: ops.map((o) => o.op),
  };
}
export const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Ops travel inside the approved document as a fenced block, so the approval binds to the exact operation. */
export const OP_FENCE = 'ripple-op';
export function opBlock(o: { op: Op['op']; seed: Seed; fault?: string }) { return `\`\`\`${OP_FENCE}\n${JSON.stringify(o)}\n\`\`\``; }
export function parseOp(body: string): { op: Op['op']; seed: Seed; fault?: string } | null {
  const m = new RegExp('```' + OP_FENCE + '\\n([\\s\\S]*?)\\n```').exec(body);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
export const STATE_MARK = '\n\n=== OBSERVED WAREHOUSE STATE (independent read) ===\n';
export function parseState(content: string): WarehouseRead | null {
  const i = content.indexOf(STATE_MARK); if (i < 0) return null;
  try { return JSON.parse(content.slice(i + STATE_MARK.length)); } catch { return null; }
}
