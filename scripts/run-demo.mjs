#!/usr/bin/env node
/**
 * One command for the Billing & SLA Dispute demo:   npm run demo
 *   1. checks the Switch bridge and registers RIPPLE's agents if needed (scripts/switch-register.mjs)
 *   2. boots RIPPLE on a fresh throw-away database (collaboration=SWITCH when .env is configured)
 *   3. runs the three must-pass scenarios end to end (scripts/e2e-billing-switch.ts) and stops the server
 * Leave the server running afterwards with:  node scripts/run-demo.mjs --keep
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.DEMO_PORT ?? '8797'; const keep = process.argv.includes('--keep');
const node = process.execPath; const tsx = join('node_modules', 'tsx', 'dist', 'cli.mjs');
const envFile = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
if (/^SWITCH_BRIDGE_URL=\S+/m.test(envFile)) { const r = spawnSync(node, ['scripts/switch-register.mjs'], { stdio: 'inherit' }); if (r.status) process.exit(r.status); }
else console.log('No SWITCH_* configuration in .env: the demo runs in LOCAL collaboration mode (labelled). Run node scripts/switch-register.mjs to use a real Switch server.');

const dir = mkdtempSync(join(tmpdir(), 'ripple-demo-'));
const server = spawn(node, [tsx, 'src/server/index.ts'], { env: { ...process.env, PORT, RIPPLE_DB_PATH: join(dir, 'ripple.db'), RIPPLE_OUTBOX: join(dir, 'outbox') }, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }
const run = spawnSync(node, [tsx, 'scripts/e2e-billing-switch.ts', '--base', base], { stdio: 'inherit' });
if (keep) console.log(`\nRIPPLE is running at ${base} (sign in as nora@ / eli@ / sofia@ / maya@harborvine.example, password ripple-demo). Ctrl+C to stop.`);
else { server.kill(); process.exit(run.status ?? 1); }
