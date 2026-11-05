import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/api/app.js';
import { makeEnv } from './helpers.js';

const D = '@harborvine.example';
/** blocking answers per pack; "%" in a key means "the open blocking question whose key starts with this" */
const BLOCK: Record<string, [string, string] | null> = { 'beo-rescue': ['vegan_count', '18'], sceneshift: null, scopeguard: ['classify_', 'out of scope'], invoiceguard: null, shiftrelay: ['status_', 'open'], movemate: ['owner_', 'Leo'], podflow: ['clip_selection_', '1,4'], submitready: ['owner_', 'Ben'] };
const COMPLETES = new Set(['beo-rescue', 'sceneshift', 'scopeguard', 'invoiceguard', 'shiftrelay', 'podflow']);   // readiness packs need an evidence-backed follow-up update (covered in pack tests + UI journeys)

function http() {
  const env = makeEnv(); const app = createApp(env.engine, { webRoot: '/nonexistent' }); let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => { const r = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, json: (await r.json().catch(() => null)) as any }; };
  const as = async (user: string) => { cookie = ''; const r = await call('POST', '/api/auth/login', { email: user + D, password: 'pw-test-123' }); expect(r.status).toBe(200); };
  const emailOf = (userId: string) => (env.db.get('SELECT email FROM users WHERE id=?', userId) as any).email.split('@')[0] as string;
  return { env, call, as, emailOf };
}

describe('HTTP API journey for every workflow pack (role-based, validated, audited)', () => {
  for (const packId of ['beo-rescue', 'sceneshift', 'scopeguard', 'invoiceguard', 'shiftrelay', 'movemate', 'podflow', 'submitready']) {
    it(`${packId}: create → baseline → request → answers → approvals by required role → execute → verify${COMPLETES.has(packId) ? ' → complete' : ' → readiness gate refuses completion'}`, async () => {
      const { call, as, emailOf } = http(); await as('maya');
      const info = await call('GET', `/api/packs/${packId}`); expect(info.status).toBe(200); const s = info.json.sample;
      // validation: bad plan / unknown pack
      expect((await call('POST', '/api/missions', { packId, title: 'bad', plan: { nope: true } })).status).toBe(422);
      expect((await call('POST', '/api/missions', { packId: 'nonexistent', title: 'x', plan: {} })).status).toBe(404);
      const created = await call('POST', '/api/missions', { packId, title: s.title, plan: s.plan }); expect(created.status).toBe(201); const id = created.json.mission.id;
      expect((await call('POST', `/api/missions/${id}/changes`, s.change)).status).toBe(409);                      // no baseline yet
      expect((await call('POST', `/api/missions/${id}/baseline`, { note: 't' })).json.mission.state).toBe('baseline_ready');
      expect((await call('POST', `/api/missions/${id}/changes`, { ...s.change, receivedOn: 'not-a-date' })).status).toBe(422);
      let d = (await call('POST', `/api/missions/${id}/changes`, s.change)).json;
      const blk = BLOCK[packId];
      if (blk) { expect(d.mission.state).toBe('blocked'); expect(d.mission.state_reason.length).toBeGreaterThan(20); expect(d.actions.filter((a: any) => a.status === 'proposed')).toHaveLength(0);
        const q = d.questions.find((x: any) => x.status === 'open' && x.blocking && x.key.startsWith(blk[0])); expect(q, `${packId} blocking question`).toBeTruthy();
        d = (await call('POST', `/api/missions/${id}/questions/${q.id}/answer`, { answer: blk[1] })).json; }
      expect(d.mission.state).toBe('awaiting_approval'); expect(d.graph.nodes.length).toBeGreaterThan(8); expect(d.graph.edges.length).toBeGreaterThan(8);
      expect(d.agents.length).toBeGreaterThanOrEqual(4); expect(d.workItems.filter((w: any) => w.current).length).toBeGreaterThan(0); expect(d.messages.some((m: any) => m.kind === 'handoff')).toBe(true);
      // approvals: wrong role is refused, correct role succeeds
      const pending = d.approvals.filter((a: any) => a.status === 'pending'); expect(pending.length).toBeGreaterThanOrEqual(2);
      await as('luis'); expect((await call('POST', `/api/missions/${id}/approvals/${pending[0].id}/decide`, { decision: 'approved' })).status).toBe(403);
      await as('vera'); expect((await call('POST', `/api/missions/${id}/actions/${d.actions[0].id}/execute`, {})).status).toBe(403);
      for (const ap of pending) { await as(ap.required_role === 'owner' ? 'sam' : 'maya'); expect((await call('POST', `/api/missions/${id}/approvals/${ap.id}/decide`, { decision: 'approved', note: 'ok' })).status).toBe(200); }
      await as('maya'); d = (await call('GET', `/api/missions/${id}`)).json; expect(d.mission.state).toBe('executing');
      for (const a of d.actions.filter((x: any) => x.status === 'approved')) { const r = await call('POST', `/api/missions/${id}/actions/${a.id}/execute`, {}); expect(r.status).toBe(200); }
      d = (await call('GET', `/api/missions/${id}`)).json; expect(d.mission.state).toBe('verifying');
      const cur = d.actions.filter((a: any) => a.current); expect(cur.every((a: any) => a.status === 'verified'), `${packId} all verified`).toBe(true);
      expect(d.evidence.filter((e: any) => e.kind === 'verification').length).toBeGreaterThan(cur.length * 3); expect(d.evidence.every((e: any) => e.passed)).toBe(true);
      expect(d.actions.every((a: any) => ['stale', 'superseded'].includes(a.status) || !a.current || a.connector_mode)).toBe(true);
      // early completion refused with an explanatory checklist
      const early = await call('POST', `/api/missions/${id}/complete`, {}); expect(early.status).toBe(422); expect(early.json.error.code).toBe('criteria_unmet');
      // acknowledgements by each responsible person, then review items
      for (const a of cur) for (const k of a.acks.filter((x: any) => x.status === 'pending')) { await as(emailOf(k.user_id)); expect((await call('POST', `/api/missions/${id}/actions/${a.id}/acknowledge`, { note: '' })).status).toBe(200); }
      await as('maya');
      for (let pass = 0; pass < 6; pass++) { d = (await call('GET', `/api/missions/${id}`)).json; for (const w of d.workItems.filter((x: any) => x.current && x.kind === 'review' && x.status !== 'done')) await call('PATCH', `/api/missions/${id}/work-items/${w.id}`, { status: 'done' }); }
      d = (await call('GET', `/api/missions/${id}`)).json;
      if (COMPLETES.has(packId)) {
        const done = await call('POST', `/api/missions/${id}/complete`, {}); expect(done.status, JSON.stringify(done.json?.error)).toBe(200); expect(done.json.mission).toMatchObject({ state: 'completed', current_baseline_version: 2 });
        expect(done.json.outcomes[0].completed.length).toBeGreaterThan(2); expect(done.json.audit.some((e: any) => e.type === 'mission_completed')).toBe(true);
      } else {
        const refused = await call('POST', `/api/missions/${id}/complete`, {}); expect(refused.status).toBe(422); expect(refused.json.error.message).toMatch(/evidence|obligation|requirement/i);
        expect((await call('GET', `/api/missions/${id}`)).json.mission.state).toBe('verifying');
      }
      expect(d.audit.filter((e: any) => e.type === 'state_change').length).toBeGreaterThanOrEqual(5);
    });
  }

  it('demo missions can be created for every pack from the API (labelled sample data), managers only', async () => {
    const { env, call, as } = http(); await as('vera'); expect((await call('POST', '/api/packs/scopeguard/demo', { runAnalysis: false })).status).toBe(403);
    await as('maya'); expect((await call('POST', '/api/packs/nope/demo', {})).status).toBe(404);
    for (const p of env.packs.all()) {
      const plain = await call('POST', `/api/packs/${p.id}/demo`, { runAnalysis: false }); expect(plain.status).toBe(201); expect(plain.json.mission).toMatchObject({ state: 'baseline_ready', plan_source: 'demo-sample' }); expect(plain.json.mission.title).toMatch(/\[demo\]$/);
      const run = await call('POST', `/api/packs/${p.id}/demo`, { runAnalysis: true }); expect(run.status).toBe(201); expect(['blocked', 'awaiting_approval']).toContain(run.json.mission.state);
    }
    const ov = (await call('GET', '/api/overview')).json; expect(ov.missions).toHaveLength(16);
    expect(new Set(ov.missions.map((m: any) => m.domain)).size).toBe(8);
  });
});
