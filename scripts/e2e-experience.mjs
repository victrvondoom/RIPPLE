// Session 20 journey: the things a first-time visitor does. Usage: scripts/fresh-server.sh 8791 && BASE_URL=http://localhost:8791 node scripts/e2e-experience.mjs
// Landing fits one screen (no scroll) -> create an account (own workspace, demo activity) -> Command Center shows numbers ->
// How it works: run one change live to the end -> Workflow Studio guided path launches a mission -> Memory Graph moves to
// what you type -> change password -> sign out lands on "/" and /dashboard sends you back to "/".
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url); let chromium;
for (const load of [() => require('playwright'), () => require('playwright-core'), () => require(require('node:path').join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright-core'))]) { try { ({ chromium } = load()); break; } catch { /* try the next location */ } }
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = 'docs/evidence/experience'; mkdirSync(OUT, { recursive: true });
const log = []; const step = (m) => { log.push(m); console.log(`✔ ${m}`); };
const fail = (m) => { console.error(`✘ ${m}`); writeFileSync(`${OUT}/experience-log.txt`, [...log, `FAILED: ${m}`].join('\n') + '\n'); process.exit(1); };
const assert = (c, m) => { if (!c) fail(m); };
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = []; p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); p.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => p.screenshot({ path: `${OUT}/${n}.png` });

await p.goto(BASE); await p.getByRole('tab', { name: 'Sign in' }).waitFor();
const [sh, ih] = await p.evaluate(() => [document.documentElement.scrollHeight, innerHeight]);
assert(sh <= ih + 1, `landing fits one screen (scrollHeight ${sh} vs ${ih})`);
assert(await p.locator('.poster-mascot .m3d').count() === 1, 'the 3D switch sits between the headline and the sign-in card');
step('Landing: one screen, no scroll, 3D switch in the middle'); await shot('01-landing');

await p.getByRole('tab', { name: 'Create account' }).click(); assert(p.url().endsWith('/signup'), 'Create account has its own address (/signup)');
const email = `visitor-${Date.now()}@example.com`;
await p.getByLabel('Your name').fill('Visitor Test'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password (8+ characters)').fill('visitor-pass-1'); await p.getByLabel('Workspace name (optional)').fill('Visitor Ops');
await shot('02-signup'); await p.getByRole('button', { name: 'Create account' }).click();
await p.waitForURL(/\/dashboard/, { timeout: 120000 }); await p.getByRole('navigation').waitFor();
step(`Signed up as ${email}: own workspace, landed on ${new URL(p.url()).pathname}`);
await p.getByText('Mission orchestration').waitFor();
const active = await p.locator('.stat, .card').filter({ hasText: 'Active missions' }).first().innerText();
assert(/\d+/.test(active) && !/^Active missions\s*0\b/.test(active.trim()), `Command Center shows numbers (${active.replace(/\s+/g, ' ')})`);
step('Command Center shows real numbers from demo activity'); await shot('03-command-center');

await p.goto(`${BASE}/dashboard#/how`); await p.getByRole('heading', { name: 'Run one change, live' }).waitFor();
await p.getByLabel('Workflow to run').selectOption('scopeguard'); await p.getByRole('button', { name: 'Start' }).click();
await p.getByRole('button', { name: 'Run to the end' }).waitFor(); await p.getByRole('button', { name: 'Run to the end' }).click();
await p.getByRole('button', { name: 'Nothing left to do' }).waitFor({ timeout: 60000 });
const live = await p.locator('.hw-live').innerText();
assert(/answered/.test(live) && /approved/.test(live) && /verified/.test(live), 'the live run answered, approved and verified');
assert(/Completed/.test(live), 'the live run completed the mission');
step('How it works: one change stepped live through answer, approval, verified execution and completion'); await shot('04-how-live');

await p.goto(`${BASE}/dashboard#/studio`); await p.locator('.gs-card', { hasText: 'Engineering Assurance & Release' }).click();
await p.locator('.gs-card', { hasText: 'Package Gate' }).click(); await p.getByRole('heading', { name: 'People who decide' }).waitFor();
await shot('05-studio'); await p.getByRole('button', { name: /and analyse$/ }).click();
await p.waitForURL(/#\/mission\//, { timeout: 60000 }); await p.waitForTimeout(1500);
assert(/Install|package/i.test(await p.locator('main').innerText()), 'the guided studio launched a Package Gate mission');
step('Workflow Studio: area → workflow → people → change launched an analysed mission');

await p.goto(`${BASE}/dashboard#/graph`); await p.getByLabel('Ask the graph').fill('Visitor'); await p.getByRole('button', { name: 'Go' }).click();
await p.waitForTimeout(1500); const g = await p.locator('main').innerText();
assert(/Visitor Test/.test(g) && /connected/i.test(g), 'typing a name moves the graph to that person');
step('Memory Graph: typing a name moved the graph to the person and their connections'); await shot('06-memory-graph');

await p.goto(`${BASE}/dashboard#/settings`); await p.getByRole('button', { name: 'Change password' }).click();
await p.getByLabel('Current password').fill('visitor-pass-1'); await p.getByLabel('New password').fill('visitor-pass-2'); await p.getByRole('button', { name: 'Save' }).click();
await p.getByText(/Password changed/).waitFor(); step('Changed the password from Settings');

await p.getByRole('button', { name: 'Sign out' }).click(); await p.waitForURL((u) => new URL(u).pathname === '/'); await p.getByRole('tab', { name: 'Sign in' }).waitFor();
await p.goto(`${BASE}/dashboard#/home`); await p.waitForURL((u) => new URL(u).pathname === '/');
step('Sign out returns to "/", and /dashboard without a session returns to "/"');
await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill('visitor-pass-2'); await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForURL(/\/dashboard/); step('Signed back in with the new password');
await b.close();
assert(errors.length === 0, `no browser console errors: ${JSON.stringify(errors.slice(0, 5))}`);
step('No browser console errors');
writeFileSync(`${OUT}/experience-log.txt`, log.join('\n') + '\n');
console.log('\nEXPERIENCE JOURNEY PASSED');
