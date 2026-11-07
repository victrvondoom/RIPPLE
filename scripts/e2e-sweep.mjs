// Page sweep (session 19): opens EVERY page the navigation offers, as a manager and as a viewer, and fails on any browser
// console error, uncaught page error, or API response >= 400. The page list is read from the rendered navigation, so a
// new page is swept without editing this script. Usage: scripts/fresh-server.sh 8791 && BASE_URL=http://localhost:8791 node scripts/e2e-sweep.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); let chromium;
for (const load of [() => require('playwright'), () => require('playwright-core'), () => require(require('node:path').join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright-core'))]) { try { ({ chromium } = load()); break; } catch { /* try the next location */ } }
const BASE = process.env.BASE_URL ?? 'http://localhost:8787'; const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';

const browser = await chromium.launch();
const problems = [];
for (const email of ['maya@harborvine.example', 'vera@harborvine.example']) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage();
  let where = 'sign-in';
  p.on('console', (m) => { if (m.type() === 'error') problems.push(`${email} ${where}: console: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => problems.push(`${email} ${where}: pageerror: ${String(e).slice(0, 200)}`));
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) problems.push(`${email} ${where}: HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  await p.goto(BASE); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('navigation').waitFor();
  const pages = await p.getByRole('navigation').locator('a[href^="#/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
  if (email.startsWith('maya')) {
    // Give every page data: one analysed demo mission per pack the server lists (read from /api/packs, not hardcoded).
    where = 'seeding';
    const ids = await p.evaluate(async () => {
      const list = await (await fetch('/api/packs')).json(); const out = [];
      for (const pk of list.packs.filter((x) => x.status === 'implemented')) {
        const r = await fetch(`/api/packs/${pk.id}/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runAnalysis: true }) });
        out.push({ pack: pk.id, status: r.status, id: r.ok ? (await r.json()).mission.id : null });
      }
      return out;
    });
    for (const x of ids) { if (!x.id) { problems.push(`demo mission for ${x.pack}: HTTP ${x.status}`); continue; } pages.push(`#/mission/${x.id}`); }
    console.log(`created ${ids.filter((x) => x.id).length}/${ids.length} demo missions`);
  }
  for (const href of pages) {
    where = href; await p.goto(`${BASE}/${href}`); await p.waitForTimeout(1500);
    const banner = await p.locator('.error, [role="alert"].error').count();
    if (banner) problems.push(`${email} ${href}: error banner shown`);
  }
  console.log(`${email}: swept ${pages.length} pages`);
  await ctx.close();
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); console.log(`SWEEP FAILED: ${problems.length} problem(s)`); process.exit(1); }
console.log('SWEEP PASSED: no console errors, page errors or failed API calls');
