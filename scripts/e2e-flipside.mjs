// Real-browser journey for the Flipside review page against a live server:  BASE_URL=http://localhost:8791 node scripts/e2e-flipside.mjs
// Signs in as the PR author, starts the labelled sample review, answers Q1, approves the one-step disclosure, delivers (dry-run) and
// checks the server-recomputed verdicts shown in the UI: OK for the real step, PROOF_FAIL for the edited copy, 1 of 10 steps shared.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL ?? 'http://localhost:8787'; const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const must = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
// Session 20: the landing page is one screen without the scroll walkthrough (component kept in components/FlipsideShowcase.tsx).
await p.goto(BASE);
await p.evaluate(async (pw) => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'noor@harborvine.example', password: pw }) }); }, PW);
await p.goto(`${BASE}/#/flipside`); await p.reload(); await p.waitForSelector('.fs-hero');
await p.getByRole('button', { name: 'Start a sample review' }).click(); await p.waitForSelector('.mt-svg');
must(await p.locator('.fs-act textarea').count() === 1, 'Q1 is waiting for the author; no step proposed yet');
await p.locator('.fs-act textarea').fill('The scheduled-report worker has no cookie, so I allowed its signed token on one route only.');
await p.getByRole('button', { name: 'Send answer' }).click(); await p.getByRole('button', { name: '1. Approve' }).waitFor();
await p.getByRole('button', { name: '1. Approve' }).click(); await p.getByRole('button', { name: /Deliver the one step/ }).click(); await p.waitForSelector('.fs-ok');
must((await p.locator('.fs-ok').first().innerText()) === 'OK', 'delivered step re-verified against the seal: OK');
must((await p.locator('.fs-bad').first().innerText()) === 'PROOF_FAIL', 'edited copy: PROOF_FAIL');
must(/1 \/ 10/.test(await p.locator('.fs-facts').innerText()), '1 of 10 steps shared');
must(errs.length === 0, 'no page errors'); await b.close(); console.log('FLIPSIDE JOURNEY PASSED');
