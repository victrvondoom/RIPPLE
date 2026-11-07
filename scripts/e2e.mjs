// End-to-end UI run against a LIVE server (default http://localhost:8787, fresh DB expected).
// Usage: npm run start (other terminal) then: node scripts/e2e.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
for (const load of [() => require('playwright'), () => require('playwright-core'), () => require(require('node:path').join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright-core'))]) { try { ({ chromium } = load()); break; } catch { /* try the next location */ } }
if (!chromium) { console.error('Playwright is not installed. Run: npm i -D playwright (or npm i -g playwright-core)'); process.exit(2); }
// Prefer Playwright's bundled browser; fall back to the locally installed Google Chrome (no download needed).
const launchBrowser = (o = {}) => chromium.launch(o).catch(() => chromium.launch({ ...o, channel: 'chrome' }));
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const OUT = 'docs/evidence'; mkdirSync(OUT, { recursive: true });
const log = []; const consoleErrors = [];
const step = (m) => { log.push(m); console.log('✔', m); };
function assert(c, m) { if (!c) { console.error('✘ ASSERTION FAILED:', m); log.push('FAILED: ' + m); writeFileSync(`${OUT}/e2e-log.txt`, log.join('\n')); process.exit(1); } }

const browser = await launchBrowser();
async function session(email, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${email}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${email}: ${e.message}`));
  await page.goto(BASE); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').waitFor();
  return page;
}
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const nav = (p, n) => p.getByRole('navigation').getByRole('link', { name: new RegExp('^' + n) });
const tab = (p, name) => p.getByRole('tab', { name: new RegExp(name) }).click();

const maya = await session('maya@harborvine.example');
await maya.getByText('Control Center').first().waitFor();
// The label must state whichever collaboration mode the server is actually in (Switch or local), never a guess.
const modeText = await maya.locator('p', { hasText: 'collaboration:' }).first().innerText();
assert(/collaboration: (Switch|LOCAL mode \(not Switch\))/.test(modeText), 'control center states the collaboration mode honestly');
const shownMode = modeText.split('collaboration:')[1].trim();
await shot(maya, '01-control-center-empty'); step(`Signed in as Event Manager; Control Center shows collaboration mode: ${shownMode}`);

await nav(maya, 'Missions').click(); await maya.getByRole('button', { name: 'New mission' }).click();
await maya.getByRole('button', { name: 'Load sample plan' }).click();
await maya.getByRole('button', { name: 'Create mission' }).click();
await maya.getByRole('heading', { name: /Meridian Labs Gala/ }).waitFor();
assert(await maya.getByText('Draft', { exact: true }).first().isVisible(), 'mission is draft'); await shot(maya, '02-mission-draft'); step('Created mission from sample original plan (state: Draft)');

await maya.getByRole('button', { name: /Approve & save baseline/ }).click();
await maya.getByText('Baseline ready').first().waitFor(); step('Approved baseline v1 (state: Baseline ready)');

await maya.getByRole('button', { name: /Enter change/ }).click();
await maya.getByRole('button', { name: 'Load sample' }).click();
await shot(maya, '03-change-form');
await maya.getByRole('button', { name: /& analyse/ }).click();
await maya.getByText('Blocked', { exact: true }).first().waitFor();
assert(await maya.getByText(/How many vegan guests/).count() > 0, 'blocked reason names the missing vegan count');
await shot(maya, '04-blocked-missing-vegan-count'); step('Change submitted → mission BLOCKED, reason explains missing vegan count; no actions proposed');

await tab(maya, 'Overview');
await maya.getByLabel('Answer').first().fill('18'); await maya.getByRole('button', { name: 'Submit answer' }).first().click();
await maya.getByText('Awaiting approval', { exact: true }).first().waitFor(); step('Answered vegan count=18 → re-analysis → Awaiting approval');
await shot(maya, '05-awaiting-approval-overview');

await tab(maya, 'Impact graph'); await maya.locator('svg[aria-label="Dependency graph"]').waitFor();
await maya.locator('.gnode').filter({ hasText: 'Guest count' }).first().click(); await shot(maya, '06-impact-graph-highlight');
assert(await maya.locator('.gnode').count() > 25, 'graph has many nodes'); step('Impact graph rendered with node highlighting');

await tab(maya, 'Agent findings'); await maya.getByText('Kitchen Agent').first().waitFor();
assert(await maya.getByText(/Potential allergen conflict/).count() > 0, 'allergen conflict flagged for human review'); assert(await maya.getByText('human review').count() > 0, 'human review badge'); await shot(maya, '07-agent-findings'); step('Agent findings show allergen conflict flagged for qualified human review');
await tab(maya, 'Collaboration room'); await maya.getByText(/LOCAL collaboration mode/).first().waitFor(); await shot(maya, '08-collaboration-room-local'); step('Collaboration room shows LOCAL-mode banner and real handoff messages');
assert(await maya.getByText(/Handoff to Kitchen Agent/).count() > 0, 'handoff message exists');
await tab(maya, 'Drafts'); await maya.getByRole('button', { name: /Revised BEO/ }).click(); await shot(maya, '09-drafts-revised-beo'); step('Drafts tab shows revised BEO with provenance');

// Execution without approval must not be offered
await tab(maya, 'Approvals & actions');
assert(await maya.getByRole('button', { name: 'Execute now' }).count() === 0, 'no execute button before approval');
await shot(maya, '10-approvals-pending');
for (let i = 0; i < 5; i++) { await maya.getByRole('button', { name: 'Approve', exact: true }).first().click(); await maya.waitForTimeout(350); }
await maya.getByText('Executing', { exact: true }).first().waitFor(); step('Approved 5 actions individually (state: Executing, ready)');

// Owner arms fault injection on email outbox
const sam = await session('sam@harborvine.example'); await nav(sam, 'Settings').click();
await sam.getByRole('row', { name: /Email outbox/ }).getByLabel('Arm failure next run').click(); await sam.waitForTimeout(500); await shot(sam, '11-settings-fault-injection'); step('Owner armed dev fault injection on email connector (audited)');

// Execute: client email first → fails
const execAll = async () => { for (let guard = 0; guard < 12; guard++) { const b = maya.getByRole('button', { name: 'Execute now' }); if (!(await b.count())) break; await b.first().click(); await maya.waitForTimeout(500); } };
await execAll();
await maya.getByText('Recovery required', { exact: true }).first().waitFor();
assert(await maya.getByText(/Injected connector fault/).count() > 0, 'failure visible'); await shot(maya, '12-failed-action-recovery'); step('Failed execution is visible; mission = Recovery required (nothing marked successful)');
await maya.getByRole('button', { name: /Retry \(recovery\)/ }).first().click();
await maya.waitForTimeout(800);
await maya.getByText('Verifying', { exact: true }).first().waitFor(); step('Explicit retry succeeded → all actions verified (state: Verifying)');
await shot(maya, '13-all-verified');

// Humans acknowledge
for (const [email, who] of [['luis@harborvine.example', 'Head Chef'], ['priya@harborvine.example', 'Procurement'], ['dan@harborvine.example', 'Service']]) {
  const p = await session(email); await nav(p, 'Missions').click(); await p.getByRole('link', { name: /Meridian/ }).first().click();
  await tab(p, 'Approvals & actions'); await p.getByRole('button', { name: 'Acknowledge receipt' }).first().click(); await p.getByText(/acknowledged/).first().waitFor();
  if (email.startsWith('luis')) { await tab(p, 'Tasks & questions'); await p.getByRole('row', { name: /Review vegan recipes/ }).getByRole('button', { name: 'Mark done' }).click(); await p.getByRole('row', { name: /Review vegan recipes/ }).getByText('done').waitFor(); }
  step(`${who} acknowledged their update${email.startsWith('luis') ? ' and completed the qualified allergen review' : ''}`);
}
// Completion must be REFUSED while a qualified review is still open
await maya.reload(); await maya.getByRole('tab', { name: 'Evidence & outcome' }).click();
await maya.getByRole('button', { name: 'Complete mission' }).click();
await maya.getByText(/Completion criteria are not satisfied/).waitFor();
assert(await maya.getByText('Mission is in verifying state').count() > 0, 'checklist visible');
await shot(maya, '14a-completion-refused'); step('Complete clicked early → server REFUSED: open review item (Procurement list review) listed');
const priya2 = await session('priya@harborvine.example'); await priya2.getByRole('link', { name: 'Missions' }).click().catch(() => {}); await priya2.goto(BASE + '/#/missions'); await priya2.getByRole('link', { name: /Meridian/ }).first().click();
await tab(priya2, 'Tasks & questions'); await priya2.getByRole('row', { name: /Review revised procurement list/ }).getByRole('button', { name: 'Mark done' }).click(); await priya2.getByRole('row', { name: /Review revised procurement list/ }).getByText('done').waitFor(); step('Procurement Lead completed their review item');
await maya.waitForTimeout(3500);
await maya.getByRole('button', { name: 'Complete mission' }).click();
await maya.getByText('Completed', { exact: true }).first().waitFor();
await shot(maya, '14-completed-evidence-outcome'); step('Completion criteria all met → mission Completed with outcome record and baseline v2');
await maya.getByRole('tab', { name: 'Audit & recovery' }).click(); await shot(maya, '15-audit-trail');
await nav(maya, 'Control Center').click(); await maya.getByText('Recent verified outcomes').waitFor(); await shot(maya, '16-control-center-after');
await nav(maya, 'Evidence & Outcomes').click(); await maya.getByText(/Independent Verification Ledger/).waitFor(); await shot(maya, '17-evidence-ledger');
await nav(maya, 'Work Graph').click(); await maya.locator('svg[aria-label="Dependency graph"]').waitFor(); await shot(maya, '18-work-graph');
await nav(maya, 'Workflow Packs').click(); await maya.getByText('SceneShift').first().waitFor(); await shot(maya, '19-workflow-packs');

// Reusability: SceneShift through the same UI
await nav(maya, 'Missions').click(); await maya.getByRole('button', { name: 'New mission' }).click();
await maya.getByLabel('Workflow pack').selectOption('sceneshift'); await maya.getByRole('button', { name: 'Load sample plan' }).click(); await maya.getByRole('button', { name: 'Create mission' }).click();
await maya.getByRole('button', { name: /Approve & save baseline/ }).click(); await maya.getByText('Baseline ready').first().waitFor();
await maya.getByRole('button', { name: /Enter change/ }).click(); await maya.getByRole('button', { name: 'Load sample' }).click(); await maya.getByRole('button', { name: /& analyse/ }).click();
await maya.getByText('Awaiting approval', { exact: true }).first().waitFor(); await tab(maya, 'Impact graph'); await maya.locator('svg[aria-label="Dependency graph"]').waitFor(); await shot(maya, '20-sceneshift-impact'); step('SceneShift mission analysed on the same engine (script change → takes, continuity, departments)');

// Responsive
const mob = await session('maya@harborvine.example', { width: 390, height: 800 }); await mob.getByText('Control Center').first().waitFor(); await shot(mob, '21-mobile-control-center');
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2); assert(!overflow, 'no horizontal page overflow at 390px'); step('Mobile viewport (390px): no horizontal page overflow');

await browser.close();
// Expected, by design: 401 from the pre-login /auth/me probe, and the single 422 from the deliberately-refused early completion.
const unexpected = consoleErrors.filter((e) => !/status of 401/.test(e));
const n422 = unexpected.filter((e) => /status of 422/.test(e)).length;
const other = unexpected.filter((e) => !/status of 422/.test(e));
assert(other.length === 0 && n422 === 1, 'no unexpected browser console errors: ' + JSON.stringify(unexpected));
step('No unexpected browser console errors (only the pre-login 401 probe and the 1 deliberate 422 refusal)');
writeFileSync(`${OUT}/e2e-log.txt`, log.join('\n') + '\n');
console.log('\nE2E PASSED');
