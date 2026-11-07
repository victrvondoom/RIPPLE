/**
 * The three must-pass demo scenarios of the Billing & SLA Dispute pack, driven through RIPPLE's HTTP API by the people who
 * own each decision, with RIPPLE connected to a REAL Switch server; every mission's Switch room is then read back.
 *   1. Happy path      — refund + SLA credit approved by Finance, fix confirmed by Engineering, reply approved by Support.
 *   2. Rejection gate  — the customer demands a $10,000 credit (over the SLA cap); Finance rejects; it never executes.
 *   3. Timeout recovery— the refund commits but the response is lost; UNKNOWN → read-back → verified, never repeated.
 *   npx tsx scripts/e2e-billing-switch.ts [--base http://localhost:8797]
 * Evidence (no keys): docs/evidence/e2e-billing-switch-<date>.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { billingPack } from '../src/server/packs/billing/pack.js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : d; };
const BASE = arg('--base', 'http://localhost:8797'); const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const env = Object.fromEntries((existsSync('.env') ? readFileSync('.env', 'utf8') : '').split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
const steps: { scenario: string; step: string; ok: boolean; detail: string }[] = [];
let scenario = '';
const rec = (step: string, ok: boolean, detail: string) => { steps.push({ scenario, step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${step} — ${detail}`); if (!ok) throw new Error(step); };
type Call = (method: string, path: string, body?: unknown) => Promise<any>;

async function session(email: string): Promise<Call> {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error(`login ${email}: HTTP ${r.status}`);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${method} ${path} as ${email}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 240)}`) as Error & { status: number }; e.status = res.status; throw e; }
    return j;
  };
}
const refused = async (p: Promise<unknown>, status: number) => p.then(() => false, (e) => (e as { status?: number }).status === status);
async function roomHistory(roomId: string) {
  await new Promise((r) => setTimeout(r, 1200));
  if (!env.SWITCH_BRIDGE_URL) return { status: 0, events: [] as { sender_name: string; body: string }[] };
  const h = await fetch(`${env.SWITCH_BRIDGE_URL}/agents/${env.SWITCH_AGENT_ID}/rooms/${roomId}/history?limit=200`, { headers: { Authorization: `Bearer ${env.SWITCH_AGENT_API_KEY}` } });
  return { status: h.status, events: h.ok ? ((await h.json()) as { events: { sender_name: string; body: string }[] }).events : [] };
}

async function open(maya: Call, mutatePlan: (p: any) => void, mutateChange: (c: any) => void) {
  const s = billingPack.sample(); const plan: any = structuredClone(s.plan); const change: any = structuredClone(s.change); mutatePlan(plan); mutateChange(change);
  const { mission } = await maya('POST', '/api/missions', { packId: 'billing-dispute', title: `${s.title} [${scenario}]`, plan, source: 'e2e-billing-switch (synthetic sample)' });
  await maya('POST', `/api/missions/${mission.id}/baseline`, { note: 'synthetic account record' });
  const d = await maya('POST', `/api/missions/${mission.id}/changes`, change);
  rec('mission opened from the customer email', ['awaiting_approval', 'blocked'].includes(d.mission.state), `${mission.id} state=${d.mission.state}`);
  rec('mission room is a real Switch room', d.room?.mode === 'switch' && !!d.room?.external_id, `room ${d.room?.external_id}`);
  return { id: mission.id as string, d };
}
const cur = (d: any, key: string) => d.actions.find((a: any) => a.key === key && a.current);
const pendingFor = (d: any, key: string) => d.approvals.find((ap: any) => ap.subject_id === cur(d, key)?.id && ap.status === 'pending');

async function main() {
  const maya = await session('maya@harborvine.example'), nora = await session('nora@harborvine.example'), eli = await session('eli@harborvine.example'), sofia = await session('sofia@harborvine.example');
  const rooms: Record<string, unknown> = {};
  const decide = (who: Call, id: string, d: any, key: string, decision: 'approved' | 'rejected', note: string) => who('POST', `/api/missions/${id}/approvals/${pendingFor(d, key).id}/decide`, { decision, note });
  const execute = (who: Call, id: string, d: any, key: string) => who('POST', `/api/missions/${id}/actions/${cur(d, key).id}/execute`);
  const confirmFix = async (id: string) => { const d = await eli('GET', `/api/missions/${id}`); const w = d.workItems.find((x: any) => x.current && x.data?.key === 'bd-patch-confirmed'); return eli('PATCH', `/api/missions/${id}/work-items/${w.id}`, { status: 'done' }); };

  // ---------- 1. happy path ----------
  scenario = 'happy-path';
  let { id, d } = await open(maya, () => {}, () => {});
  rec('wrong department cannot approve the refund', await refused(decide(sofia, id, d, 'refund_duplicate', 'approved', 'x'), 403), 'Support lead → HTTP 403');
  d = await decide(nora, id, d, 'refund_duplicate', 'approved', 'Matches ledger duplicate ch_9921');
  d = await decide(nora, id, d, 'issue_sla_credit', 'approved', 'Per SLA-4.2 (10% of monthly fee)');
  d = await decide(sofia, id, d, 'send_customer_reply', 'approved', 'Wording approved');
  rec('customer reply blocked before its obligations are met', await refused(execute(sofia, id, d, 'send_customer_reply'), 409), 'HTTP 409 blocked_by_dependency');
  d = await execute(nora, id, d, 'refund_duplicate'); d = await execute(nora, id, d, 'issue_sla_credit');
  rec('refund and credit verified against the ledger read-back', cur(d, 'refund_duplicate').status === 'verified' && cur(d, 'issue_sla_credit').status === 'verified', 'both verified');
  await confirmFix(id); d = await sofia('GET', `/api/missions/${id}`);
  d = await execute(sofia, id, d, 'send_customer_reply');
  rec('reply sent (dry-run) and verified after dependencies', cur(d, 'send_customer_reply').status === 'verified', 'verified');
  d = await sofia('POST', `/api/missions/${id}/complete`); rec('mission completed', d.mission.state === 'completed', d.mission.state);
  let h = await roomHistory(d.room.external_id);
  rec('Switch room read back: handoffs to department agents, approvals, verification', h.status === 200 && ['ripple-billing', 'ripple-policy', 'ripple-comms'].every((n) => h.events.some((e) => e.body.startsWith(`@${n}`))) && h.events.some((e) => /\[approval_request\]/.test(e.body)) && h.events.filter((e) => /Verification for .*: verified/.test(e.body)).length >= 3, `${h.events.length} messages`);
  rooms[scenario] = { missionId: id, roomId: d.room.external_id, messages: h.events.length };

  // ---------- 2. rejection gate ----------
  scenario = 'rejection-gate';
  ({ id, d } = await open(maya, () => {}, (c) => { c.message.body += '\nWe also demand a $10,000 service credit for the outage.'; }));
  rec('over-cap credit flagged in the proposal', /exceeds SLA cap \$3,000/.test(cur(d, 'issue_sla_credit').title), cur(d, 'issue_sla_credit').title);
  d = await decide(nora, id, d, 'issue_sla_credit', 'rejected', 'REJECT: exceeds SLA cap (SLA-4.2, max $3,000)');
  rec('rejected credit can never execute', await refused(execute(nora, id, d, 'issue_sla_credit'), 409), 'HTTP 409');
  d = await decide(nora, id, d, 'refund_duplicate', 'approved', 'ledger ok'); d = await decide(sofia, id, d, 'send_customer_reply', 'approved', 'ok');
  await execute(nora, id, d, 'refund_duplicate'); await confirmFix(id);
  await execute(sofia, id, await sofia('GET', `/api/missions/${id}`), 'send_customer_reply');
  d = await sofia('POST', `/api/missions/${id}/complete`);
  rec('mission completed with the credit recorded as rejected', d.mission.state === 'completed' && cur(d, 'issue_sla_credit').status === 'rejected', `credit=${cur(d, 'issue_sla_credit').status}`);
  h = await roomHistory(d.room.external_id);
  rec('Switch room shows the human rejection', h.events.some((e) => /\[decision\].*REJECTED:.*exceeds SLA cap/.test(e.body)), 'decision message found');
  rooms[scenario] = { missionId: id, roomId: d.room.external_id, messages: h.events.length };

  // ---------- 3. timeout recovery ----------
  scenario = 'timeout-recovery';
  ({ id, d } = await open(maya, (p) => { p.scenarioFaults = [{ op: 'refund', kind: 'lost_response', label: 'The refund commits, the API response is lost, the status read fails once' }]; }, () => {}));
  d = await decide(nora, id, d, 'refund_duplicate', 'approved', 'ledger ok');
  d = await execute(nora, id, d, 'refund_duplicate');
  rec('lost response recorded as UNKNOWN, not success', cur(d, 'refund_duplicate').status === 'execution_unknown' && d.mission.state === 'recovery_required', `${cur(d, 'refund_duplicate').status}, mission ${d.mission.state}`);
  d = await execute(nora, id, d, 'refund_duplicate');
  rec('recovery reads back first and verifies without a second refund', cur(d, 'refund_duplicate').status === 'verified' && cur(d, 'refund_duplicate').result?.recoveredBy === 'read-back', `recoveredBy=${cur(d, 'refund_duplicate').result?.recoveredBy}`);
  h = await roomHistory(d.room.external_id);
  rec('Switch room shows UNKNOWN escalation and the read-back recovery', h.events.some((e) => /UNKNOWN/.test(e.body)) && h.events.some((e) => /Read-back found/.test(e.body)), 'both messages found');
  rooms[scenario] = { missionId: id, roomId: d.room.external_id, messages: h.events.length };
  return rooms;
}
main().then((rooms) => finish(true, rooms), (e) => { console.error(String((e as Error).message)); finish(false, {}); });
function finish(passed: boolean, rooms: Record<string, unknown>) {
  mkdirSync('docs/evidence', { recursive: true }); const f = `docs/evidence/e2e-billing-switch-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(f, JSON.stringify({ base: BASE, bridge: env.SWITCH_BRIDGE_URL, internalOnlyRooms: env.SWITCH_INTERNAL_ONLY === '1', data: 'synthetic sample (billing sandbox, dry-run email)', rooms, steps, passed }, null, 2));
  console.log(`\n${passed ? 'ALL 3 SCENARIOS PASSED' : 'E2E FAILED'} — evidence: ${f}`); process.exit(passed ? 0 : 1);
}
