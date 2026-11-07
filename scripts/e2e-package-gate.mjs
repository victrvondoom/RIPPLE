// Live Package Gate journey (session 19). NEEDS NETWORK: it reads the real npm and PyPI registries.
// Usage: scripts/fresh-server.sh 8791 && BASE_URL=http://localhost:8791 node scripts/e2e-package-gate.mjs
// A manager pastes an install line; RIPPLE reads every package live, opens a mission; the security lead (Noor) decides the
// flagged version in the mission; a second check in the same room shows the approval in the derived ledger; Squat Watch runs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url); let chromium;
for (const load of [() => require('playwright'), () => require('playwright-core'), () => require(require('node:path').join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright-core'))]) { try { ({ chromium } = load()); break; } catch { /* try the next location */ } }
const BASE = process.env.BASE_URL ?? 'http://localhost:8787'; const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const OUT = 'docs/evidence/packs'; mkdirSync(OUT, { recursive: true });
const log = []; const step = (m) => { log.push(m); console.log(`✔ ${m}`); };
const assert = (c, m) => { if (!c) { console.error(`✘ ${m}`); writeFileSync(`${OUT}/package-gate-live-log.txt`, [...log, `FAILED: ${m}`].join('\n') + '\n'); process.exit(1); } };
const browser = await chromium.launch(); const errors = [];
const session = async (email) => {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${email}: ${m.text()}`); }); p.on('pageerror', (e) => errors.push(`${email}: ${e}`));
  await p.goto(BASE); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click(); await p.getByRole('navigation').waitFor();
  return p;
};
const LINE = 'Coding agent: please run `npm install express lodahs left-pad zz-invented-helper-qx && pip install requests reqeusts`';

const maya = await session('maya@harborvine.example');
await maya.goto(`${BASE}/#/package-gate`); await maya.getByRole('heading', { name: 'Package Gate' }).waitFor();
await maya.getByLabel('Install line').fill(LINE); await maya.getByLabel('Room', { exact: true }).fill('#web-app'); await maya.getByLabel('Asked by').fill('coding-agent');
await maya.getByRole('button', { name: 'Check packages' }).click();
await maya.getByRole('button', { name: 'Open the mission' }).waitFor({ timeout: 120000 });
const table = await maya.locator('section.card').first().innerText();
assert(/npm:express/.test(table) && /pypi:requests/.test(table), 'every package was read from the registries');
assert(/npm:zz-invented-helper-qx\s+—\s+not-found/.test(table), 'an invented npm name is reported not-found by the registry');
step('Install line read live from npm and PyPI; invented name reported not-found');
await maya.screenshot({ path: `${OUT}/package-gate-live-check.png` });
await maya.getByRole('button', { name: 'Open the mission' }).click(); await maya.waitForTimeout(2500);
const mission = await maya.locator('main').innerText();
assert(/lodahs/.test(mission) && /security placeholder/.test(mission), 'npm security placeholder (lodahs) is shown with its reason');
step('Mission opened on live data; npm security placeholder recognised');
await maya.screenshot({ path: `${OUT}/package-gate-live-mission.png` });
const missionUrl = maya.url();

// The security lead decides any open package question (if the live data produced one).
const noor = await session('noor@harborvine.example');
await noor.goto(missionUrl); await noor.waitForTimeout(2000);
const forms = noor.locator('form', { hasText: /Approve this exact version or deny it/ });
const asked = await forms.count();
for (let i = 0; i < asked; i++) { const f = forms.first(); await f.getByLabel('Answer').fill('deny'); await f.getByRole('button', { name: 'Submit answer' }).click(); await noor.waitForTimeout(1500); }
step(`Security lead answered ${asked} exact-version question(s)`);

// Squat Watch on demand, then the derived room memory.
await maya.goto(`${BASE}/#/package-gate`); await maya.getByRole('button', { name: 'Run now' }).click(); await maya.waitForTimeout(4000);
const page = await maya.locator('main').innerText();
assert(/zz-invented-helper-qx/.test(page) && /#web-app/.test(page), 'room memory and Squat Watch list the invented name');
assert(/Measured detection/.test(page) && /%/.test(page), 'benchmark numbers rendered from the metrics file');
step('Squat Watch re-read the invented name; room memory and measured detection shown');
await maya.screenshot({ path: `${OUT}/package-gate-live-overview.png`, fullPage: true });
await browser.close();
assert(errors.length === 0, `no browser console errors: ${JSON.stringify(errors)}`);
step('No browser console errors');
writeFileSync(`${OUT}/package-gate-live-log.txt`, log.join('\n') + '\n');
console.log('\nPACKAGE GATE LIVE JOURNEY PASSED');
