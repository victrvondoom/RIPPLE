#!/usr/bin/env node
/**
 * Registers RIPPLE's agents on a LOCAL Switch server (switch-core 0.31.x, started by Switch Console) and writes the
 * SWITCH_* variables RIPPLE reads into .env. Keys are written to disk only (.env and data/switch-agents.local.json,
 * both gitignored) and are NEVER printed.
 *
 *   node scripts/switch-register.mjs [--bridge http://127.0.0.1:52042] [--overwrite]
 *
 * Registration token: $SWITCH_REGISTRATION_TOKEN, else AGENT_REGISTRATION_TOKEN from Switch Console's
 * %APPDATA%/switchdash/local-switch-server/native/run/switch-core.env. Endpoint: POST {bridge}/agents (switch-core
 * bridges/agent/api/handlers.py register_agent_endpoint). --overwrite re-registers existing names (rotates their keys).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const bridge = (arg('--bridge', process.env.SWITCH_BRIDGE_URL || 'http://127.0.0.1:52042')).replace(/\/$/, '');
const overwrite = process.argv.includes('--overwrite');

function registrationToken() {
  if (process.env.SWITCH_REGISTRATION_TOKEN) return process.env.SWITCH_REGISTRATION_TOKEN;
  const f = join(process.env.APPDATA ?? '', 'switchdash', 'local-switch-server', 'native', 'run', 'switch-core.env');
  if (!existsSync(f)) throw new Error(`No SWITCH_REGISTRATION_TOKEN and no Switch Console env file at ${f}`);
  const m = /^AGENT_REGISTRATION_TOKEN=(.*)$/m.exec(readFileSync(f, 'utf8'));
  if (!m) throw new Error('AGENT_REGISTRATION_TOKEN not found in the Switch Console env file');
  return m[1].trim();
}

// RIPPLE itself (the coordinator that owns missions) + one Switch agent per consumer-resolution role.
const AGENTS = [
  { name: 'ripple', display: 'RIPPLE Coordinator', role: null, description: 'RIPPLE mission coordinator: opens one room per mission, posts handoffs, findings, approval requests and verification results. Authority stays in RIPPLE; room replies are advisory.' },
  { name: 'ripple-intake', display: 'Intake Agent (REDEEM)', role: 'cr_intake', description: 'Consumer intake: safety checks, proposed case facts, confirmed preferences.' },
  { name: 'ripple-commitments', display: 'Commitment Agent (RESOLVE)', role: 'cr_commitments', description: 'Commitment ledger: who promised what, by when, quoted from the exact sentence.' },
  { name: 'ripple-rights', display: 'Rights & Evidence Agent (RECLAIM)', role: 'cr_rights', description: 'Reference retrieval with provenance, citation grounding, evidence coverage.' },
  { name: 'ripple-drafting', display: 'Resolution Drafting Agent', role: 'cr_drafting', description: 'Drafts organisation letters, the case file and the consumer update for approval.' },
  // billing-dispute pack: one company, internal departments
  { name: 'ripple-support', display: 'Support Intake Agent (RESOLVE)', role: 'bd_intake', description: 'Support: reads the customer email, extracts requests and deadlines.' },
  { name: 'ripple-ops', display: 'Incident Agent (Engineering)', role: 'bd_ops', description: 'Engineering/Ops: confirms the outage window and root cause.' },
  { name: 'ripple-billing', display: 'Billing Agent (Finance)', role: 'bd_finance', description: 'Finance: checks the ledger and shares only the verified claim.' },
  { name: 'ripple-policy', display: 'Policy Agent (RECLAIM)', role: 'bd_policy', description: 'Legal & Policy: applies SLA and billing clauses; computes credit and cap.' },
  { name: 'ripple-comms', display: 'Customer Comms Agent (RESOLVE)', role: 'bd_comms', description: 'Support: obligation graph and the customer reply.' },
  // Switch-native workflow (ripple_switch/, Python protocol agents; role=null: they are not RIPPLE-engine role agents)
  { name: 'ripple-coordinator', display: 'RIPPLE Coordinator', role: null, description: 'Opens #ripple-intake cases, provisions linked #ops-verification and #finance-approvals rooms, relays only verified claims and digests.' },
  { name: 'reclaim-investigator', display: 'RECLAIM Investigator', role: null, description: 'Engineering room: reads incident logs, computes outage window and 5-minute error rates, writes the Evidence Manifest room document.' },
  { name: 'resolve-comms', display: 'RESOLVE Comms', role: null, description: 'Intake: reads the customer email, extracts commitments and deadlines, sends the customer reply only after the refund is verified.' },
  { name: 'ripple-arbiter', display: 'RIPPLE Arbiter (deterministic, zero-LLM)', role: null, description: 'Finance room: ledger check, SLA/refund maths, hash-bound human approval, dispatch, read-back verification, receipt.' },
];
const profile = { connection_model: 'always_on', message_exchange: true, pre_invocation_mediation: [], post_invocation_mediation: [], event_reporting: [] };

async function main() {
  const health = await fetch(`${bridge}/health`).then((r) => r.status).catch((e) => `unreachable (${e.message})`);
  console.log(`Switch bridge ${bridge}/health -> ${health}`);
  if (health !== 200) process.exit(2);
  const token = registrationToken();
  const store = 'data/switch-agents.local.json';
  const saved = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {};
  for (const a of AGENTS) {
    if (saved[a.name] && !overwrite) { console.log(`= ${a.name}: already registered (id ${saved[a.name].id}); use --overwrite to rotate`); continue; }
    const res = await fetch(`${bridge}/agents`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: a.name, display_name: a.display, description: a.description, connector_type: 'ripple', integration_profile: profile, metadata: { ripple_role: a.role }, overwrite }) });
    const text = await res.text();
    if (!res.ok) { console.log(`✗ ${a.name}: HTTP ${res.status} ${text.slice(0, 200)}`); if (res.status === 409) console.log('  (name exists in Switch; re-run with --overwrite to rotate its key)'); continue; }
    const j = JSON.parse(text); saved[a.name] = { id: j.id, apiKey: j.api_key, role: a.role };
    console.log(`✓ ${a.name}: registered, id ${j.id}`);
  }
  mkdirSync('data', { recursive: true }); writeFileSync(store, JSON.stringify(saved, null, 2));
  const self = saved.ripple; if (!self) { console.log('Coordinator not registered; .env not changed.'); process.exit(1); }
  const vars = {
    SWITCH_BRIDGE_URL: bridge, SWITCH_AGENT_ID: self.id, SWITCH_AGENT_API_KEY: self.apiKey, SWITCH_SELF_NAME: 'ripple',
    SWITCH_ROLE_AGENTS: AGENTS.filter((a) => a.role && saved[a.name]).map((a) => `${a.role}=${a.name}`).join(','),
  };
  let env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  for (const [k, v] of Object.entries(vars)) env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env}${env && !env.endsWith('\n') ? '\n' : ''}${k}=${v}\n`;
  writeFileSync('.env', env);
  console.log(`.env updated: SWITCH_BRIDGE_URL, SWITCH_AGENT_ID, SWITCH_AGENT_API_KEY (hidden), SWITCH_SELF_NAME, SWITCH_ROLE_AGENTS=${vars.SWITCH_ROLE_AGENTS}`);
}
main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
