// Real-browser journey for Cross-Domain Invariant Intelligence. Usage: node scripts/e2e-cdii.mjs [port]
// Requires a running server (e.g. PORT=8795 RIPPLE_DB_PATH=<scratch> npx tsx src/server/index.ts) and playwright-core
// (resolved from the local project or the global npm root). Screenshots go to docs/evidence/reality/cross-domain/.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2] ?? '8795';
const base = `http://localhost:${port}`;
const out = 'docs/evidence/reality/cross-domain';
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright-core'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright-core')); }

const log = []; const say = (m) => { log.push(`${new Date().toISOString()} ${m}`); console.log(m); };
const errors = [];
const browser = await pw.chromium.launch({ headless: true }).catch(() => pw.chromium.launch({ headless: true, channel: 'chrome' }));
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (name, opts = {}) => { await page.waitForTimeout(400); await page.screenshot({ path: join(out, name), ...opts }); say(`screenshot ${name}`); };
const btn = (name) => page.getByRole('button', { name, exact: true });
// Toasts replace each other in one slot: wait for a message that differs from the last one read, so a lingering earlier toast is never mistaken for the new one.
let lastToast = '';
const toast = async () => {
  for (let i = 0; i < 40; i++) { const t = (await page.locator('.toast').first().textContent({ timeout: 250 }).catch(() => '')) ?? ''; if (t && t !== lastToast) { lastToast = t; return t; } await page.waitForTimeout(200); }
  return '';
};
const surface = async (label) => { await page.locator('.rge-tabs a', { hasText: label }).last().click(); await page.waitForTimeout(800); };
const check = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); say(`ok: ${msg}`); };

try {
  await page.goto(base);
  await page.getByRole('button', { name: /Maya — Manager/ }).click();
  await page.waitForSelector('nav.nav');
  await page.goto(`${base}/#/reality/crossdomain`);
  await page.waitForSelector('.cd-hero');

  // ---------------- Scenario 1: Booking × Payment × Inventory ----------------
  await page.locator('.cd-start select').selectOption('cd-booking-payment-inventory');
  await btn('Start live scenario').click();
  await page.waitForSelector('.cd-wf');
  const locals = await page.locator('.cd-validity span:first-child').allTextContents();
  check(locals.length === 3 && locals.every((t) => t.includes('locally valid')), 'all three workflows are locally valid on their own evidence');
  await page.locator('.cd-wf', { hasText: 'Wedding party booking' }).getByRole('button', { name: 'Execute through gate' }).click();
  const refusal = (await page.locator('.toast', { hasText: /globally blocked/ }).first().textContent({ timeout: 8000 }).catch(() => null)) ?? await toast();
  check(/locally valid but globally blocked/.test(refusal), `gate refused the wedding: "${refusal.slice(0, 90)}…"`);
  await page.locator('.cd-camp').scrollIntoViewIfNeeded();
  await shot('01-gate-refuses-locally-valid-workflow.png');
  await page.waitForTimeout(4500);
  await btn('Run intersection analysis').click();
  await page.waitForFunction(() => document.querySelectorAll('.cd-validity span:last-child').length === 3 && [...document.querySelectorAll('.cd-validity span:last-child')].every((s) => s.textContent.includes('globally blocked')));
  say('all three workflows: locally valid, globally blocked');
  await page.locator('.cd-3d-card').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await btn('Pause orbit').click();
  await shot('02-constellation-3d-locally-valid-globally-blocked.png');
  // select a workflow node in the 3D view: sweep the canvas until the hover tip names a workflow, then click it
  const box = await page.locator('.cd-const canvas').boundingBox();
  let picked = false;
  for (let y = 0.25; y < 0.75 && !picked; y += 0.04) for (let x = 0.2; x < 0.8 && !picked; x += 0.03) { await page.mouse.move(box.x + box.width * x, box.y + box.height * y); const tip = await page.locator('.cd-tip').textContent({ timeout: 50 }).catch(() => ''); if (tip && tip.startsWith('workflow')) { await page.mouse.down(); await page.mouse.up(); picked = true; } }
  say(`3D node picked: ${picked}`);
  await page.waitForTimeout(600);
  await shot('03-constellation-node-provenance.png');

  await surface('Intersection inbox');
  await page.locator('.cd-find', { hasText: 'A captured wedding deposit references a suite' }).click();
  await btn('Trace evidence chain').click();
  await page.waitForSelector('.cd-chain-row');
  await page.evaluate(() => { const s = document.querySelector('.cd-side'); const c = document.querySelector('.cd-chain'); if (s && c) s.scrollTop = c.offsetTop - 260; });
  await shot('04-intersection-inbox-evidence-chain.png');
  const patterns = await page.locator('.cd-pat').allTextContents();
  say(`inbox patterns: ${[...new Set(patterns)].join(' | ')}`);

  await surface('Invariant inspector');
  await page.locator('.cd-inv', { hasText: 'Grand hall seats' }).click();
  await shot('05-invariant-inspector-capacity.png');

  await surface('Impact explorer');
  await page.locator('.card', { hasText: 'If this changes' }).locator('select').first().selectOption('res:inventory/suite-301');
  await page.waitForSelector('.cd-impact');
  await shot('06-impact-explorer-suite-301.png');

  await btn('Arbitrate').click();
  await page.waitForSelector('.cd-matrix');
  const statuses = await page.locator('.cd-matrix tbody tr').evaluateAll((rows) => rows.map((r) => r.textContent));
  check(statuses.some((t) => t.includes('Proceed as planned') && t.includes('rejected')), 'proceed-as-planned is rejected by hard constraints');
  await shot('07-plan-collision-matrix.png');
  await page.locator('.cd-matrix tr.rec').getByRole('button', { name: 'Choose' }).click();
  await page.waitForSelector('.cd-stepper');
  await btn('Approve (bound to plan hash)').click();
  await page.waitForTimeout(800);
  await btn('Execute guarded resolution').click();
  await page.waitForSelector('text=Outcome: verified', { timeout: 20000 });
  check(true, 'resolution executed and verified (Outcome: verified)');
  await shot('08-resolution-verified.png');
  await page.locator('.table-wrap', { hasText: 'Guarded execution' }).scrollIntoViewIfNeeded();
  await shot('09-guarded-execution-readback.png');

  await surface('Consistency passport');
  await btn('Verify integrity (recompute sha256)').click();
  await page.waitForSelector('text=Body intact');
  check((await page.locator('.cd-verdict').textContent()) === 'CONSISTENT', 'passport verdict CONSISTENT and body hash intact');
  await shot('10-consistency-passport-verified.png');

  // ---------------- Scenario 4: recovery × concurrent workflow (stale approval) ----------------
  await page.goto(`${base}/#/reality/crossdomain`);
  await page.reload(); // a hash-only goto keeps the SPA state of the previous scenario; start clean
  await page.locator('.cd-start select').selectOption('cd-recovery-concurrent');
  await btn('Start live scenario').click();
  await page.waitForSelector('.cd-wf');
  await page.waitForTimeout(4500);
  await btn('Run intersection analysis').click();
  await page.waitForTimeout(1200);
  await btn('Arbitrate').click();
  await page.waitForSelector('.cd-matrix');
  await page.locator('.cd-matrix tr.rec').getByRole('button', { name: 'Choose' }).click();
  await page.waitForSelector('.cd-stepper');
  await btn('Approve (bound to plan hash)').click();
  await page.waitForTimeout(800);
  await btn('Execute guarded resolution').click();
  const outcome4 = await page.locator('.banner strong', { hasText: /^Outcome: / }).first().textContent({ timeout: 20000 }).catch(() => 'no outcome banner');
  check(outcome4 === 'Outcome: replanned', `concurrent change detected after approval: stale approval rejected, plan re-made (saw "${outcome4}"; toast: "${(await page.locator('.toast').first().textContent({ timeout: 500 }).catch(() => ''))?.slice(0, 160)}")`);
  await shot('11-stale-approval-rejected-replanned.png');
  await surface('Plan collision');
  await shot('12-replanned-collateral-rejected.png');
  await page.locator('.cd-matrix tr.rec').getByRole('button', { name: 'Choose' }).click();
  await page.waitForSelector('.cd-stepper');
  await btn('Approve (bound to plan hash)').click();
  await page.waitForTimeout(800);
  await btn('Execute guarded resolution').click();
  await page.waitForSelector('text=Outcome: verified', { timeout: 20000 });
  check(true, 'second plan executed and both workflows verified');
  await shot('13-concurrent-recovery-verified.png');
  await surface('Intersection inbox');
  await shot('14-inbox-after-recovery.png');

  // ---------------- Cross-domain RIGOR from the UI ----------------
  await page.goto(`${base}/#/reality/crossdomain/-/bench`);
  await page.waitForSelector('text=RIGOR · Cross-domain reliability benchmark');
  await page.locator('input').first().fill('cd-browser-1');
  await page.getByRole('button', { name: /^Run \d+ cases$/ }).click();
  await page.waitForFunction(() => /completed/.test(document.body.innerText) && document.querySelectorAll('.cd-bench tbody tr').length > 10, null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  await shot('15-rigor-crossdomain-metrics.png', { fullPage: true });

  // ---------------- phone width ----------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#/reality/crossdomain`);
  await page.waitForSelector('.cd-hero');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  say(`phone width horizontal overflow: ${overflow}px`);
  await shot('16-mobile-command-center.png');
  say(`console errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  say(`FAILED: ${e.message}`);
  await page.screenshot({ path: join(out, 'zz-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'browser-run-log.txt'), log.join('\n') + '\n');
  await browser.close();
}
