import { serve } from '@hono/node-server';
import { Db } from './db/db.js';
import { Engine } from './engine/engine.js';
import { extendedRegistry } from './packs/registry.js';
import { LocalCollab } from './collab/local.js';
import { SwitchCollab, switchConfigFromEnv } from './collab/switch.js';
import { parseChatIdentities } from './collab/chat.js';
import { buildConnectors } from './connectors/index.js';
import { providerFromEnv } from './agents/provider.js';
import { createApp } from './api/app.js';
import { PackageGateService, watchMinutes } from './api/pkgguard.js';
import { seedWorkspace, syncDirectory } from './seed.js';
import { seedDemoActivity } from './demo/activity.js';
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const prod = process.env.NODE_ENV === 'production';
const pw = process.env.RIPPLE_SEED_PASSWORD;
if (prod && (!pw || pw === 'ripple-demo')) throw new Error('RIPPLE_SEED_PASSWORD must be set to a non-default value in production.');

const db = new Db(process.env.RIPPLE_DB_PATH ?? 'data/ripple.db');
const packs = extendedRegistry();
const sw = switchConfigFromEnv(process.env);
const collab = sw ? new SwitchCollab(sw) : new LocalCollab();
const engine = new Engine({ db, packs, collab, connectors: buildConnectors(process.env.RIPPLE_OUTBOX ?? 'data/outbox'), provider: providerFromEnv(process.env), chatIdentities: parseChatIdentities(process.env.SWITCH_CHAT_IDENTITIES) });
if (!db.get('SELECT 1 x FROM workspaces')) {
  const { workspaceId } = seedWorkspace(db, packs, { name: 'Harbor & Vine Catering', password: pw ?? 'ripple-demo' });
  console.log('Seeded development workspace "Harbor & Vine Catering".');
  // Session 20: a first boot also runs labelled demo activity through the engine so no page starts empty (RIPPLE_DEMO_ACTIVITY=0 skips it).
  if (process.env.RIPPLE_DEMO_ACTIVITY !== '0') {
    const logs = await seedDemoActivity(engine, workspaceId);
    console.log(`Demo activity: ${logs.length} labelled missions, ${logs.filter((l) => l.state === 'completed').length} completed through the engine.`);
  }
}
syncDirectory(db, packs);
// Restart recovery: work that was running when the previous process stopped is marked interrupted and the mission is
// blocked (resumable). Stale agent tasks are swept every 15 s so nothing hangs silently.
const recovered = engine.recoverInterrupted();
if (recovered) console.log(`Recovered ${recovered} interrupted agent task(s); affected missions are blocked and resumable.`);
setInterval(() => { try { engine.sweepStaleTasks(); engine.sweepExpiredApprovals(); } catch (e) { console.error('stale-task sweep failed', e); } }, 15_000).unref();
// Squat Watch (session 19): re-read every invented package name on npm/PyPI every PKGGUARD_WATCH_MINUTES (0 = off).
const packageGate = new PackageGateService(engine);
if (watchMinutes() > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return; running = true;
    try { for (const w of db.all('SELECT id FROM workspaces')) await packageGate.watch(w.id); }
    catch (e) { console.error('squat watch failed', e); } finally { running = false; }
  }, watchMinutes() * 60_000).unref();
}
const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: createApp(engine, { production: prod, packageGate }).fetch, port }, () => {
  console.log(`RIPPLE listening on http://localhost:${port}  collaboration=${collab.label}  provider=${engine.provider.name}`);
});
// A listen failure (e.g. the port is taken by another RIPPLE instance) is reported clearly instead of crashing with an unhandled 'error' event.
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or start with PORT=<free port>.` : `RIPPLE server error: ${err.message}`);
  db.raw.close();
  process.exit(1);
});
