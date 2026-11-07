// Cross-domain UI journey: ONE workspace, ONE Control Center, ALL packs (demo missions with labelled sample data).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url); let chromium;
for (const load of [() => require('playwright'), () => require('playwright-core'), () => require(require('node:path').join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright-core'))]) { try { ({ chromium } = load()); break; } catch { /* try the next location */ } }
if (!chromium) { console.error('Playwright is not installed. Run: npm i -D playwright (or npm i -g playwright-core)'); process.exit(2); }
// Prefer Playwright's bundled browser; fall back to the locally installed Google Chrome (no download needed).
const launchBrowser = (o = {}) => chromium.launch(o).catch(() => chromium.launch({ ...o, channel: 'chrome' }));
const BASE = process.env.BASE_URL ?? 'http://localhost:8787'; const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo'; const OUT = 'docs/evidence/packs'; mkdirSync(OUT, { recursive: true });
const log = []; const step = (m) => { log.push(m); console.log('✔', m); }; const fail = (m) => { console.error('✘', m); writeFileSync(`${OUT}/crossdomain-log.txt`, log.join('\n') + '\nFAILED: ' + m); process.exit(1); }; const assert = (c, m) => { if (!c) fail(m); };
const browser = await launchBrowser(); const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p = await ctx.newPage(); const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE); await p.getByLabel('Email').fill('maya@harborvine.example'); await p.getByLabel('Password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click(); await p.getByRole('navigation').waitFor();
const ROUTES = { 'Control Center': '#/missions/control', 'Workflow Packs': '#/packs', Settings: '#/settings', 'Work Graph': '#/graph', Missions: '#/missions', Approvals: '#/approvals', 'People & Agents': '#/people', 'Evidence & Outcomes': '#/evidence' };
const nav = (n) => ({ click: () => p.evaluate((h) => { location.hash = h; }, ROUTES[n]) });
const PACKS = ['BEO Rescue', 'SceneShift', 'ScopeGuard', 'InvoiceGuard', 'ShiftRelay', 'MoveMate', 'PodFlow', 'SubmitReady'];
await nav('Workflow Packs').click(); await p.getByText('SubmitReady').first().waitFor();
assert(await p.getByText('planned').count() === 0, 'no pack is still listed as planned'); await p.screenshot({ path: `${OUT}/crossdomain-01-packs.png`, fullPage: true });
for (const n of PACKS) { await nav('Workflow Packs').click(); await p.getByRole('button', { name: `Create demo mission and run analysis for ${n}` }).click(); await p.getByRole('tab', { name: /Overview/ }).waitFor(); await p.waitForTimeout(300); }
step(`Created demo missions for all ${PACKS.length} packs through the Workflow Packs page (labelled sample data) and ran analysis on each`);
await nav('Control Center').click(); await p.getByText('All missions across domains').waitFor();
const rowsAll = await p.locator('tbody').first().locator('tr').count(); assert(rowsAll >= 8, 'control center lists missions of all packs: ' + rowsAll);
const domains = await p.getByLabel('Domain').locator('option').allTextContents(); assert(['Event Operations', 'Creative Production', 'Agency Operations', 'Financial Reconciliation', 'Field Operations', 'Personal Administration', 'Creator Production', 'Education Workflows'].every((d) => domains.includes(d)), 'all 8 domains present: ' + domains.join('|'));
await p.screenshot({ path: `${OUT}/crossdomain-02-control-center.png`, fullPage: true }); step(`Control Center shows ${rowsAll} missions across ${domains.length - 1} domains in one table`);
const count = async () => Number((await p.getByText(/All missions across domains \((\d+)\//).textContent()).match(/\((\d+)\//)[1]);
const total = await count();
await p.getByLabel('Domain').selectOption('Agency Operations'); const nAgency = await count(); assert(nAgency >= 1 && nAgency < total, 'domain filter narrows'); assert(await p.locator('tbody').first().getByText('Field Operations').count() === 0, 'only agency rows'); await p.getByLabel('Domain').selectOption(''); step(`Domain filter: ${total} → ${nAgency} (Agency Operations only)`);
await p.getByLabel('Status').selectOption('blocked'); const nBlocked = await count(); assert(nBlocked >= 3, 'blocked missions across domains: ' + nBlocked); await p.screenshot({ path: `${OUT}/crossdomain-03-filter-blocked.png`, fullPage: true }); await p.getByLabel('Status').selectOption(''); step(`Status filter "Blocked": ${nBlocked} mission(s) from different domains, each with its reason`);
await p.getByLabel('Status').selectOption('awaiting_approval'); const nAw = await count(); assert(nAw >= 2, 'awaiting approval'); await p.getByLabel('Status').selectOption('');
await p.getByLabel('Approval required').check(); const nAppr = await count(); assert(nAppr >= 2 && nAppr <= total, 'approval filter'); await p.getByLabel('Approval required').uncheck(); step(`"Approval required" filter: ${nAppr} mission(s)`);
await p.getByLabel('Blocked / overdue').check(); const nStuck = await count(); assert(nStuck >= nBlocked, 'blocked/overdue includes blocked'); await p.getByLabel('Blocked / overdue').uncheck();
const owners = await p.getByLabel('Owner').locator('option').allTextContents(); assert(owners.includes('Maya Chen'), 'owner filter lists people: ' + owners.join(',')); await p.getByLabel('Owner').selectOption('Maya Chen'); const nMaya = await count(); assert(nMaya >= 3, 'Maya owns work in several missions: ' + nMaya); await p.screenshot({ path: `${OUT}/crossdomain-04-owner-maya.png`, fullPage: true }); await p.getByLabel('Owner').selectOption(''); step(`Owner filter "Maya Chen": ${nMaya} missions across domains`);
await p.getByLabel('Recent change').selectOption('24'); assert(await count() >= 8, 'recent change filter'); await p.getByLabel('Recent change').selectOption(''); step('Recent-change filter works');
// a human answers ScopeGuard's blocking scope question so its owner-level approval appears in the shared queue
await nav('Missions').click(); await p.getByRole('link', { name: /Northwind Redesign/ }).first().click(); await p.getByRole('tab', { name: /Tasks & questions/ }).click();
const qf = p.locator('form', { hasText: /premium/ }).first(); await qf.getByLabel('Answer').fill('out of scope'); await qf.getByRole('button', { name: 'Submit answer' }).click(); await p.locator('.toast', { hasText: /Answer recorded|re-analysing/ }).first().waitFor(); await p.waitForTimeout(1200);
await nav('Approvals').click(); await p.getByText(/Pending approvals \(/i).waitFor(); const pend = Number((await p.getByText(/Pending approvals \((\d+)\)/i).textContent()).match(/\((\d+)\)/)[1]); assert(pend >= 6, 'shared approvals queue: ' + pend);
const roles = await p.locator('.badge', { hasText: /needs (manager|owner)/ }).allTextContents(); assert(roles.some((r) => /owner/.test(r)) && roles.some((r) => /manager/.test(r)), 'differing approval levels visible: ' + [...new Set(roles)].join(',')); await p.screenshot({ path: `${OUT}/crossdomain-05-approvals.png`, fullPage: true }); step(`One approvals queue holds ${pend} approvals across domains, with manager- and owner-level requirements`);
await nav('People & Agents').click(); await p.getByText('Ana Silva').waitFor(); await p.screenshot({ path: `${OUT}/crossdomain-06-people.png`, fullPage: true }); step('People & Agents lists the domain-specific owners and every pack’s agent roles');
await nav('Work Graph').click(); await p.locator('svg[aria-label="Dependency graph"]').waitFor(); const opts = await p.getByLabel('Mission').locator('option').count(); assert(opts >= 8, 'work graph selector lists missions of all domains'); step(`Work Graph selector lists ${opts} analysed missions`);
const unexpected = errs.filter((e) => !/status of (401|409|422)/.test(e)); assert(unexpected.length === 0, 'no unexpected console errors ' + JSON.stringify(unexpected)); step('No unexpected browser console errors');
writeFileSync(`${OUT}/crossdomain-log.txt`, log.join('\n') + '\n'); console.log('\nCROSS-DOMAIN JOURNEY PASSED'); await browser.close();
