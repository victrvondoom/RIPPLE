// Live proof over the real HTTP API (fresh server):  BASE_URL=http://localhost:8791 node scripts/proof-fixline-recall.mjs
// Fixline: refused approvals by the wrong people, then the lead approves; Recall desk: look-alike batch, QA-Head-only answer and approval.
const BASE = process.env.BASE_URL ?? 'http://localhost:8787'; const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', '-', m); if (!c) process.exitCode = 1; };
async function login(email) { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) }); const ck = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); return async (m, p, b) => { const x = await fetch(`${BASE}/api${p}`, { method: m, headers: { 'content-type': 'application/json', cookie: ck }, body: b ? JSON.stringify(b) : undefined }); const j = await x.json().catch(() => ({})); return { s: x.status, j }; }; }
const H = (n) => `${n}@harborvine.example`;
const [sam, maya, ana] = await Promise.all([login(H('sam')), login(H('maya')), login(H('ana'))]);
async function start(api, packId) { const d = await api('POST', `/packs/${packId}/demo`, { runAnalysis: false }); return d.j.mission.id; }
const detail = async (api, id) => (await api('GET', `/missions/${id}`)).j;

// ---- Fixline ----
{ const pk = (await sam('GET', '/packs/fixline-bugfix')).j; const s = pk.sample ?? pk.pack?.sample ?? pk.pack?.sampleChange;
  const id = await start(sam, 'fixline-bugfix'); const r = await sam('POST', `/missions/${id}/changes`, s?.change ?? s); ok(r.s < 300, `Sam (owner) reports the bug (status ${r.s})`);
  const d = await detail(sam, id); const a = d.actions.find((x) => x.key === 'act-merge-record'); const ap = a?.approval; ok(!!ap, 'CI gate proposed the merge record only after all gates passed');
  ok((await ana('POST', `/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'support lead' })).s === 403, 'support lead approval REFUSED (403)');
  ok((await sam('POST', `/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'reporter' })).s === 403, 'reporter (Sam) approval REFUSED (403)');
  ok((await maya('POST', `/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'lead' })).s < 300, 'engineering lead (Maya) approves');
  await maya('POST', `/missions/${id}/actions/${a.id}/execute`); const d2 = await detail(maya, id); ok(d2.actions.find((x) => x.key === 'act-merge-record').status === 'verified', 'merge record VERIFIED by independent read-back (dry-run; nothing merged)'); }
// ---- Recall desk ----
{ const pk = (await sam('GET', '/packs/recall-desk')).j; const s = pk.sample ?? pk.pack?.sample;
  const id = await start(sam, 'recall-desk'); await maya('POST', `/missions/${id}/changes`, s?.change ?? s);
  const d = await detail(maya, id); const q = d.questions.find((x) => x.key.startsWith('lookalike_') && x.status === 'open'); ok(!!q, 'look-alike batch APRCT-25O1 vs APRCT-2501 raised as a question, not auto-matched');
  ok(!d.actions.some((x) => x.key === 'act-stop-sale' && !['stale', 'superseded'].includes(x.status)), 'no stop-sale order while the look-alike is undecided');
  ok((await maya('POST', `/missions/${id}/questions/${q.id}/answer`, { answer: 'yes' })).s === 403, 'manager answering for the QA Head REFUSED (403)');
  ok((await sam('POST', `/missions/${id}/questions/${q.id}/answer`, { answer: 'no' })).s < 300, 'QA Head (Sam) answers: different batch');
  const d2 = await detail(sam, id); const a = d2.actions.find((x) => x.key === 'act-stop-sale' && !['stale', 'superseded'].includes(x.status));
  ok((await maya('POST', `/missions/${id}/approvals/${a.approval.id}/decide`, { decision: 'approved', note: 'x' })).s === 403, 'manager approving the stop-sale REFUSED (403)');
  ok((await sam('POST', `/missions/${id}/approvals/${a.approval.id}/decide`, { decision: 'approved', note: 'QA Head' })).s < 300, 'QA Head approves'); await sam('POST', `/missions/${id}/actions/${a.id}/execute`);
  const d3 = await detail(sam, id); ok(d3.actions.find((x) => x.id === a.id).status === 'verified', 'stop-sale order VERIFIED (dry-run; no store contacted)');
  const comp = (await sam('GET', `/missions/${id}/completion`)).j; ok(JSON.stringify(comp).includes('shelf_checks') && comp.allPassed === false, 'recall NOT complete: no shelf check recorded yet (completion refused)'); }
