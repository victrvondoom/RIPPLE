/**
 * Billing SANDBOX model (pure functions, no I/O). The connector `billing_sandbox` persists operations per mission and
 * reads state back through `readLedger`. Nothing here touches Stripe, a bank or any real payment system.
 */
export interface Charge { id: string; invoice: string; amount: number; currency: string; capturedAt: string; source: string }
export interface Seed { account: string; ledger: Charge[] }
export interface BillingOp { op: 'refund' | 'credit'; chargeId?: string; account: string; amount: number; currency: string; seed: Seed; fault?: 'lost_response' }
export interface AppliedOp { key: string; op: BillingOp['op']; chargeId?: string; amount: number }
export interface LedgerRead {
  account: string;
  charges: { id: string; invoice: string; amount: number; refunded: number; refunds: number }[];
  credits: { amount: number }[];
}

const FENCE = 'ripple-billing';
export const SANDBOX_LABEL = 'Billing sandbox (labelled test ledger, not a payment provider)';
export const STATE_MARK = '\n\n=== OBSERVED LEDGER STATE (independent read) ===\n';
export const opBlock = (o: BillingOp) => `\`\`\`${FENCE}\n${JSON.stringify(o)}\n\`\`\``;
export function parseOp(body: string): BillingOp | null {
  const m = new RegExp('```' + FENCE + '\\n([\\s\\S]*?)\\n```').exec(body);
  if (!m) return null;
  try { return JSON.parse(m[1]!) as BillingOp; } catch { return null; }
}
export function parseState(content: string): LedgerRead | null {
  const i = content.indexOf(STATE_MARK); if (i < 0) return null;
  try { return JSON.parse(content.slice(i + STATE_MARK.length)) as LedgerRead; } catch { return null; }
}

/** Provider-side rule (independent of RIPPLE's idempotency key): a charge can be refunded at most once and never above its amount. */
export function refusal(seed: Seed, ops: AppliedOp[], o: BillingOp): string | null {
  if (o.amount <= 0) return 'amount must be positive';
  if (o.op === 'refund') {
    const c = seed.ledger.find((x) => x.id === o.chargeId);
    if (!c) return `charge ${o.chargeId} does not exist`;
    if (ops.some((x) => x.op === 'refund' && x.chargeId === c.id)) return `charge ${c.id} is already refunded`;
    if (o.amount > c.amount + 1e-9) return `refund ${o.amount} exceeds charge amount ${c.amount}`;
  }
  return null;
}
export function readLedger(seed: Seed, ops: AppliedOp[]): LedgerRead {
  return {
    account: seed.account,
    charges: seed.ledger.map((c) => { const r = ops.filter((x) => x.op === 'refund' && x.chargeId === c.id); return { id: c.id, invoice: c.invoice, amount: c.amount, refunded: r.reduce((s, x) => s + x.amount, 0), refunds: r.length }; }),
    credits: ops.filter((x) => x.op === 'credit').map((x) => ({ amount: x.amount })),
  };
}
/** Duplicate captures: the same invoice captured more than once. The earliest capture is the legitimate one. */
export function duplicates(ledger: Charge[]): { original: Charge; duplicate: Charge }[] {
  const by = new Map<string, Charge[]>();
  for (const c of ledger) by.set(c.invoice, [...(by.get(c.invoice) ?? []), c]);
  return [...by.values()].filter((g) => g.length > 1).flatMap((g) => { const s = [...g].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)); return s.slice(1).map((d) => ({ original: s[0]!, duplicate: d })); });
}
