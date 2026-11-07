/**
 * LIVE check of RIPPLE's Switch adapter against a REAL Switch server (not the mock in tests/switch.test.ts).
 *   npx tsx scripts/switch-live.ts
 * Needs the SWITCH_* variables in .env (scripts/switch-register.mjs) and data/switch-agents.local.json for the
 * second agent. Every step is checked independently (room history read back through the API), and the result is
 * written to docs/evidence/switch-live-<date>.json. API keys are never printed or written to the evidence file.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SwitchCollab, switchConfigFromEnv } from '../src/server/collab/switch.js';
import type { InboundMessage } from '../src/server/collab/port.js';

if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!; }
const cfg = switchConfigFromEnv(process.env);
if (!cfg) { console.error('SWITCH_* not configured. Run node scripts/switch-register.mjs first.'); process.exit(2); }
const agents = JSON.parse(readFileSync('data/switch-agents.local.json', 'utf8')) as Record<string, { id: string; apiKey: string }>;
const peer = agents['ripple-intake']!;
const steps: { step: string; ok: boolean; detail: string }[] = [];
const rec = (step: string, ok: boolean, detail: string) => { steps.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`); };
const base = cfg.bridgeUrl.replace(/\/$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function history(agentId: string, key: string, roomId: string) {
  const r = await fetch(`${base}/agents/${agentId}/rooms/${roomId}/history?limit=50`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, events: r.ok ? ((await r.json()) as { events: { sender_name: string; body: string }[] }).events : [] };
}

async function main() {
  const startedAt = new Date().toISOString(); const tag = randomUUID().slice(0, 8);
  const collab = new SwitchCollab(cfg!);
  rec('bridge health', await collab.health(), `${base}/health`);
  let room;
  try {
    room = await collab.openRoom({ missionId: `live-${tag}`, title: `Live adapter check ${tag}`, topic: 'RIPPLE adapter live check (consumer-resolution roles)', agentRoles: [{ key: 'cr_intake', name: 'Intake' }, { key: 'cr_commitments', name: 'Commitments' }, { key: 'cr_rights', name: 'Rights' }, { key: 'cr_drafting', name: 'Drafting' }] });
    rec('create_room + events stream + connect_to_room', !!room.externalId, `room ${room.externalId} "${room.name}"`);
  } catch (e) { rec('create_room + events stream + connect_to_room', false, String((e as Error).message)); return finish(startedAt, collab); }
  const inbound: InboundMessage[] = []; collab.subscribe(room, (m) => inbound.push(m));
  try { await collab.send(room, { kind: 'status', senderKey: 'ripple', senderName: 'RIPPLE', body: `live-check ${tag}: mission room opened` }); rec('post_message', true, 'broadcast sent'); }
  catch (e) { rec('post_message', false, String((e as Error).message)); }
  try { await collab.send(room, { kind: 'handoff', senderKey: 'ripple', senderName: 'RIPPLE', toKey: 'cr_intake', toName: 'Intake Agent (REDEEM)', body: `live-check ${tag}: please run intake for case ASHA-001` }); rec('send_targeted_message', true, 'handoff to ripple-intake sent'); }
  catch (e) { rec('send_targeted_message', false, String((e as Error).message)); }
  await sleep(1500);
  const h = await history(cfg!.agentId, cfg!.apiKey, room.externalId!);
  const mine = h.events.filter((e) => e.body.includes(`live-check ${tag}`));
  rec('independent read-back (room history, coordinator key)', h.status === 200 && mine.length >= 2, `HTTP ${h.status}; ${mine.length} of 2 RIPPLE messages found; senders: ${[...new Set(mine.map((e) => e.sender_name))].join(', ')}`);
  rec('targeted message carries @ripple-intake', mine.some((e) => /@ripple-intake/.test(e.body)), mine.find((e) => /handoff/.test(e.body))?.body.slice(0, 120) ?? 'not found');

  // Second, independent agent identity: ripple-intake connects with ITS OWN key and replies in the room.
  const peerCollab = new SwitchCollab({ bridgeUrl: base, agentId: peer.id, apiKey: peer.apiKey, roleAgents: {}, selfName: 'ripple-intake' });
  try {
    await (peerCollab as any).attach(room.externalId);
    await peerCollab.send(room, { kind: 'finding', senderKey: 'cr_intake', senderName: 'Intake Agent (REDEEM)', body: `live-check ${tag}: intake done, refund preference pending consumer confirmation` });
    rec('second agent (ripple-intake) joins with its own key and posts', true, 'reply posted');
  } catch (e) { rec('second agent (ripple-intake) joins with its own key and posts', false, String((e as Error).message)); }
  for (let i = 0; i < 20 && !inbound.some((m) => m.body.includes(`live-check ${tag}: intake done`)); i++) await sleep(250);
  const got = inbound.find((m) => m.body.includes(`live-check ${tag}: intake done`));
  rec('RIPPLE receives the other agent\'s reply over the SSE stream', !!got, got ? `from ${got.senderName}` : `${inbound.length} inbound message(s), none matched`);
  const hp = await history(peer.id, peer.apiKey, room.externalId!);
  rec('peer read-back (room history, ripple-intake key)', hp.status === 200 && hp.events.some((e) => e.body.includes(`live-check ${tag}: intake done`)), `HTTP ${hp.status}; ${hp.events.length} event(s)`);
  await peerCollab.close();
  return finish(startedAt, collab, room.externalId!);
}
async function finish(startedAt: string, collab: SwitchCollab, roomId?: string) {
  const d = collab.describe(); await collab.close();
  const out = { startedAt, finishedAt: new Date().toISOString(), bridge: base, switchCore: '0.31.0 (Switch Console native runtime)', roomId: roomId ?? null, adapterState: d.detail, steps, passed: steps.every((s) => s.ok) };
  mkdirSync('docs/evidence', { recursive: true }); const f = `docs/evidence/switch-live-${startedAt.slice(0, 10)}.json`; writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\n${out.passed ? 'ALL STEPS PASSED' : 'SOME STEPS FAILED'} — evidence: ${f}`); process.exit(out.passed ? 0 : 1);
}
void main();
