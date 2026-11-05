// End-to-end journey for the five packs inherited from competitor projects, over the REAL HTTP API (no mocks).
// Usage: scripts/fresh-server.sh 8791 && BASE=http://localhost:8791 node scripts/e2e-inherited.mjs
// For each pack: the WRONG person is refused, the RIGHT person approves, the action executes, and the verifier's evidence must pass.
const BASE = process.env.BASE ?? 'http://localhost:8787';
const PW = process.env.RIPPLE_SEED_PASSWORD ?? 'ripple-demo';
const D = '@harborvine.example';
let failures = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  [${extra}]` : ''}`); if (!cond) failures++; };

async function login(user) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${user}${D}`, password: PW }) });
  if (!r.ok) throw new Error(`login ${user}: ${r.status} ${await r.text()}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function api(cookie, method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

const JOURNEYS = [
  { pack: 'offerroom', right: 'mia', wrong: 'maya', evidence: ['truth guard re-run on the stored document', 'resume payload present in read-back', 'does not claim an application was submitted'] },
  { pack: 'incident-sentinel', right: 'maya', wrong: 'sam', evidence: ['rollback target equals the independently re-computed target', 'rollback target is not the culprit release', 'states that no cluster was called'] },
  { pack: 'schemacourt', right: 'maya', wrong: 'sam', evidence: ['stored patch re-run on LEGACY fixture: zero variance', 'stored patch re-run on DRIFTED fixture: zero variance', 'COALESCE null-guard present'] },
  { pack: 'clearsend', right: 'sam', wrong: 'maya', evidence: ['release preconditions still hold at verification time', 'exact payout amount present', 'states that no funds moved'] },
  { pack: 'crewpilot', right: 'maya', wrong: 'sam', evidence: ['severity matches an independent re-triage', 'approver recorded is the reporter', 'states that no code was changed or merged'] },
];

const maya = await login('maya');
const packs = (await api(maya, 'GET', '/api/packs')).json.packs;
ok(JOURNEYS.every((j) => packs.find((p) => p.id === j.pack)?.status === 'implemented'), 'all five inherited packs are listed as implemented', packs.filter((p) => p.status === 'planned').map((p) => p.id).join(',') || 'none planned');

for (const j of JOURNEYS) {
  console.log(`\n--- ${j.pack} ---`);
  const created = await api(maya, 'POST', `/api/packs/${j.pack}/demo`, { runAnalysis: true });
  const id = created.json.mission?.id ?? created.json.id;
  ok(created.status < 300 && !!id, 'demo mission created and analysed', `HTTP ${created.status}`);
  let d = (await api(maya, 'GET', `/api/missions/${id}`)).json;
  ok(d.mission?.state === 'awaiting_approval', 'mission is awaiting approval', d.mission?.state);
  const action = d.actions.find((a) => a.current && a.status === 'proposed');
  const ap = d.approvals.find((a) => a.subject_id === action?.id && a.status === 'pending');
  ok(!!action && !!ap, 'one proposed action with a pending approval', action?.key);
  ok(!!ap?.approver_label, 'approval is bound to a named person', ap?.approver_label);
  const wrong = await api(await login(j.wrong), 'POST', `/api/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'should be refused' });
  ok(wrong.status === 403, `${j.wrong} is refused`, `HTTP ${wrong.status}: ${(wrong.json.error?.message ?? wrong.json.error ?? '').toString().slice(0, 90)}`);
  const right = await api(await login(j.right), 'POST', `/api/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'approved in e2e' });
  ok(right.status < 300, `${j.right} approves`, `HTTP ${right.status}`);
  const exec = await api(maya, 'POST', `/api/missions/${id}/actions/${action.id}/execute`);
  ok(exec.status < 300, 'action executes through the connector', `HTTP ${exec.status}`);
  d = (await api(maya, 'GET', `/api/missions/${id}`)).json;
  const done = d.actions.find((a) => a.id === action.id);
  ok(done?.status === 'verified', 'verifier independently re-read the effect: action is VERIFIED', done?.status);
  for (const name of j.evidence) { const e = d.evidence.find((x) => x.action_id === action.id && x.check_name === name); ok(e?.passed === true, `evidence: ${name}`, e ? e.detail.slice(0, 70) : 'missing'); }
  const comp = d.completion;
  console.log(`      completion now: ${comp.allPassed ? 'ALL CRITERIA MET' : `NOT complete (${comp.checks.filter((c) => !c.passed).map((c) => c.key).join(', ')})`}`);
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
