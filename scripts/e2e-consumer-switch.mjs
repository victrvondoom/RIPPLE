#!/usr/bin/env node
/**
 * End-to-end: the Consumer Resolution mission driven through RIPPLE's HTTP API by three different signed-in people,
 * with RIPPLE connected to a REAL Switch server, then the mission's Switch room is read back independently.
 *
 *   (server)  SWITCH_INTERNAL_ONLY=1 RIPPLE_DB_PATH=<fresh.db> PORT=8795 npx tsx src/server/index.ts
 *   (driver)  node scripts/e2e-consumer-switch.mjs [--base http://localhost:8795]
 *
 * Maya opens the case; Asha (the consumer) confirms her refund preference, approves the exact messages and executes
 * them; Kai (case reviewer) acknowledges the record and completes the citation review; Asha completes the mission.
 * Evidence (no keys): docs/evidence/e2e-consumer-switch-<date>.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://localhost:8795');
const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const env = Object.fromEntries((existsSync('.env') ? readFileSync('.env', 'utf8') : '').split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const steps = []; const rec = (step, ok, detail) => { steps.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`); if (!ok) throw new Error(step); };

async function session(email) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error(`login ${email}: HTTP ${r.status}`);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const call = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} as ${email}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  };
  return { email, call };
}

async function main() {
  const startedAt = new Date().toISOString();
  const maya = await session('maya@harborvine.example'), asha = await session('asha@harborvine.example'), kai = await session('kai@harborvine.example');
  const { mission } = await maya.call('POST', '/api/packs/consumer-resolution/demo', { runAnalysis: true });
  let d = await asha.call('GET', `/api/missions/${mission.id}`);
  rec('mission opened and blocked on the consumer', d.mission.state === 'blocked', `${mission.id} state=${d.mission.state}`);
  rec('mission room is a real Switch room', d.room?.mode === 'switch' && !!d.room?.external_id, `room ${d.room?.external_id} (${d.room?.collab?.detail ?? ''})`);
  const q = d.questions.find((x) => x.key === 'refund_mode' && x.status === 'open');
  await maya.call('POST', `/api/missions/${mission.id}/questions/${q.id}/answer`, { answer: 'original payment method' }).then(() => rec('a manager cannot answer for the consumer', false, 'accepted'), (e) => rec('a manager cannot answer for the consumer', /403/.test(e.message), 'HTTP 403'));
  d = await asha.call('POST', `/api/missions/${mission.id}/questions/${q.id}/answer`, { answer: 'original payment method' });
  rec('consumer confirms refund preference', d.mission.state === 'awaiting_approval', `state=${d.mission.state}`);
  const pending = d.approvals.filter((a) => a.status === 'pending');
  await maya.call('POST', `/api/missions/${mission.id}/approvals/${pending[0].id}/decide`, { decision: 'approved', note: 'x' }).then(() => rec('only the consumer may approve', false, 'accepted'), (e) => rec('only the consumer may approve', /403/.test(e.message), 'HTTP 403 for Maya'));
  for (const ap of pending) d = await asha.call('POST', `/api/missions/${mission.id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'Approved exactly as drafted' });
  rec('consumer approves the exact content', d.approvals.filter((a) => a.status === 'approved').length === pending.length, `${pending.length} approval(s)`);
  for (const a of d.actions.filter((x) => x.status === 'approved' && x.current)) d = await asha.call('POST', `/api/missions/${mission.id}/actions/${a.id}/execute`);
  const current = d.actions.filter((a) => a.current);
  rec('every action independently verified', current.length === 3 && current.every((a) => a.status === 'verified'), current.map((a) => `${a.key}:${a.status}`).join(', '));
  for (const a of current.filter((x) => (x.acks ?? []).some((k) => k.status === 'pending'))) await kai.call('POST', `/api/missions/${mission.id}/actions/${a.id}/acknowledge`, { note: 'Record checked' });
  const reviews = (await kai.call('GET', `/api/missions/${mission.id}`)).workItems.filter((x) => x.current && x.kind === 'review' && x.status !== 'done');
  for (const w of reviews) await kai.call('PATCH', `/api/missions/${mission.id}/work-items/${w.id}`, { status: 'done' });
  d = await asha.call('POST', `/api/missions/${mission.id}/complete`);
  rec('mission completed through evaluateCompletion', d.mission.state === 'completed', `state=${d.mission.state}`);

  // Independent read-back of the Switch room (coordinator agent key from .env; never printed)
  const roomId = d.room.external_id; await new Promise((r) => setTimeout(r, 1500));
  const h = await fetch(`${env.SWITCH_BRIDGE_URL}/agents/${env.SWITCH_AGENT_ID}/rooms/${roomId}/history?limit=200`, { headers: { Authorization: `Bearer ${env.SWITCH_AGENT_API_KEY}` } });
  const events = h.ok ? (await h.json()).events : [];
  const kinds = {}; for (const e of events) { const k = /^(?:@\S+ )?\[(\w+)\]/.exec(e.body)?.[1]; if (k) kinds[k] = (kinds[k] ?? 0) + 1; }
  rec('Switch room history read back', h.status === 200 && events.length > 0, `HTTP ${h.status}; ${events.length} message(s); by kind ${JSON.stringify(kinds)}`);
  for (const k of ['handoff', 'finding', 'approval_request', 'decision', 'status']) rec(`room contains [${k}] messages`, (kinds[k] ?? 0) > 0, `${kinds[k] ?? 0}`);
  const targeted = [...new Set(events.map((e) => /^@(ripple-[a-z]+)/.exec(e.body)?.[1]).filter(Boolean))];
  rec('handoffs were addressed to the role agents in Switch', targeted.length > 0, targeted.join(', '));
  rec('verification results reached the room', events.some((e) => /Verification for .*: verified/.test(e.body)), 'status messages "Verification for …: verified"');
  return { startedAt, missionId: mission.id, roomId, kinds, targeted, sample: events.slice(0, 6).map((e) => ({ sender: e.sender_name, body: e.body.slice(0, 180) })) };
}
main().then((extra) => finish(true, extra), (e) => { console.error(String(e.message ?? e)); finish(false, {}); });
function finish(passed, extra) {
  mkdirSync('docs/evidence', { recursive: true }); const f = `docs/evidence/e2e-consumer-switch-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(f, JSON.stringify({ base: BASE, bridge: env.SWITCH_BRIDGE_URL, internalOnlyRoom: true, ...extra, steps, passed }, null, 2));
  console.log(`\n${passed ? 'E2E PASSED' : 'E2E FAILED'} — evidence: ${f}`); process.exit(passed ? 0 : 1);
}
