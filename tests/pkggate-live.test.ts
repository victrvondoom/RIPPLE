import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeEnv, row, rows } from './helpers.js';
import { LocalCollab } from '../src/server/collab/local.js';
import { extendedRegistry } from '../src/server/packs/registry.js';
import { PackageGateService, benchmarkSummary } from '../src/server/api/pkgguard.js';
import { createApp } from '../src/server/api/app.js';
import { approvalKey } from '../src/server/packs/pkggate/pack.js';

/** A fake registry: npm documents by name; anything absent is a 404. Mutable, so a name can "become registered". */
function fakeRegistry() {
  const now = Date.now(); const iso = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString();
  const docs: Record<string, any> = {
    express: { 'dist-tags': { latest: '5.1.0' }, versions: { '5.1.0': { dist: {}, repository: 'x' } }, time: { created: iso(5000), '4.0.0': iso(4000), '5.1.0': iso(100) } },
    expresss: { 'dist-tags': { latest: '1.0.2' }, versions: { '1.0.2': { dist: {}, scripts: { postinstall: 'node setup.js' } } }, time: { created: iso(1), '1.0.2': iso(1) } },
    'tiny-new-helper': { 'dist-tags': { latest: '0.1.0' }, versions: { '0.1.0': { dist: {} } }, time: { created: iso(3), '0.1.0': iso(3) } },
  };
  const fetcher = async (url: string) => {
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    return docs[name] ? { status: 200, json: docs[name] } : { status: 404 };
  };
  return { docs, fetcher, iso };
}
const setup = () => {
  const e = makeEnv(new LocalCollab(), extendedRegistry());
  const reg = fakeRegistry();
  return { e, reg, svc: new PackageGateService(e.engine, reg.fetcher), noor: e.actor('noor@harborvine.example') };
};
const LINE = 'please run: npm install express expresss tiny-new-helper ghost-pkg-zz';

describe('Package Gate, live service', () => {
  it('reads every package from the registry and opens a mission on that data; the security lead comes from the role mapping', async () => {
    const { e, svc } = setup();
    const r = await svc.check(e.maya, { message: LINE, room: '#web', requestedBy: { name: 'coding-agent', kind: 'agent' } });
    expect(r.observations.map((o) => `${o.name}:${o.existence}`)).toEqual(['express:exists', 'expresss:exists', 'tiny-new-helper:exists', 'ghost-pkg-zz:not-found']);
    expect(r.mission.state).toBe('blocked');
    const plan = JSON.parse(row(e, 'SELECT plan FROM baselines WHERE mission_id=?', r.mission.id).plan);
    expect(plan.securityLead).toBe('noor@harborvine.example');
    expect(row(e, "SELECT * FROM questions WHERE mission_id=? AND key=?", r.mission.id, approvalKey('npm', 'tiny-new-helper', '0.1.0'))).toBeDefined();
  });

  it('refuses viewers, messages with no install command, and messages with only non-registry specs', async () => {
    const { e, svc } = setup();
    await expect(svc.check(e.vera, { message: LINE, room: '#web', requestedBy: { name: 'v', kind: 'human' } })).rejects.toThrow(/manager or owner/);
    await expect(svc.check(e.maya, { message: 'hello there', room: '#web', requestedBy: { name: 'm', kind: 'human' } })).rejects.toThrow(/No npm/);
    await expect(svc.check(e.maya, { message: 'npm install ./local.tgz', room: '#web', requestedBy: { name: 'm', kind: 'human' } })).rejects.toThrow(/names no registry package/);
  });

  it('derives the room memory from recorded decisions: the approver is named, the approved version is not asked again, invented names are counted', async () => {
    const { e, svc, noor } = setup();
    const first = await svc.check(e.maya, { message: LINE, room: '#web', requestedBy: { name: 'coding-agent', kind: 'agent' } });
    const q = row(e, 'SELECT * FROM questions WHERE mission_id=? AND key=?', first.mission.id, approvalKey('npm', 'tiny-new-helper', '0.1.0'));
    await e.engine.answerQuestion(noor, first.mission.id, q.id, 'approve');
    const mem = svc.roomMemory(e.maya.workspaceId, '#web');
    expect(mem.ledger).toEqual([expect.objectContaining({ name: 'tiny-new-helper', version: '0.1.0', approvedBy: 'Noor Haddad' })]);
    expect(mem.invented).toEqual([expect.objectContaining({ name: 'ghost-pkg-zz', count: 1 })]);
    expect(mem.review).toMatchObject({ asked: 1, approved: 1 });
    const second = await svc.check(e.maya, { message: LINE, room: '#web', requestedBy: { name: 'coding-agent', kind: 'agent' } });
    expect(row(e, 'SELECT * FROM questions WHERE mission_id=? AND key=?', second.mission.id, approvalKey('npm', 'tiny-new-helper', '0.1.0'))).toBeUndefined();
    expect(svc.roomMemory(e.maya.workspaceId, '#web').invented[0].count).toBe(2);
    // another room keeps its own memory
    expect(svc.roomMemory(e.maya.workspaceId, '#other').ledger).toEqual([]);
  });

  it('Squat Watch records the moment an invented name gets registered, once, with an audit event and a room message', async () => {
    const { e, svc, reg } = setup();
    const r = await svc.check(e.maya, { message: LINE, room: '#web', requestedBy: { name: 'coding-agent', kind: 'agent' } });
    expect((await svc.watch(e.maya.workspaceId))).toEqual([expect.objectContaining({ name: 'ghost-pkg-zz', status: 'not-found', newlyRegistered: false })]);
    reg.docs['ghost-pkg-zz'] = { 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': { dist: {} } }, time: { created: reg.iso(0), '9.9.9': reg.iso(0) } };
    expect((await svc.watch(e.maya.workspaceId))[0]).toMatchObject({ status: 'exists', newlyRegistered: true });
    expect((await svc.watch(e.maya.workspaceId))[0]).toMatchObject({ status: 'exists', newlyRegistered: false });
    expect(rows(e, "SELECT * FROM audit_events WHERE type='invented_name_registered'")).toHaveLength(1);
    expect(rows(e, "SELECT * FROM messages WHERE mission_id=? AND sender_key='pg_squat_watch' AND kind='escalation' AND body LIKE '%now registered%'", r.mission.id)).toHaveLength(1);
    expect(svc.watchRows(e.maya.workspaceId)[0]).toMatchObject({ name: 'ghost-pkg-zz', observed_version: '9.9.9' });
  });

  it('serves the benchmark numbers from the metrics file, and null when the file is absent', () => {
    const b = benchmarkSummary()!;
    const M = JSON.parse(readFileSync('bench/pkgguard/results/metrics-heldout.json', 'utf8'));
    expect(b.npm.metadataAtPublish?.recall).toBe(M.E2_npm_metadata.confusion.atPublish_vs_allControls.recall);
    expect(b.pypi.code?.recall).toBe(M.E3_code.pypi.atReview.vsAllBenign.recall);
    expect(benchmarkSummary('/nonexistent/metrics.json')).toBeNull();
  });

  it('works over HTTP: a manager checks, a member reads the overview but cannot open a check or run the watch', async () => {
    const { e, reg } = setup();
    const app = createApp(e.engine, { webRoot: '/nonexistent', packageGate: new PackageGateService(e.engine, reg.fetcher) });
    const login = async (email: string) => (await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ email, password: 'pw-test-123' }) })).headers.get('set-cookie')!.split(';')[0];
    const dan = await login('dan@harborvine.example'); const maya = await login('maya@harborvine.example');
    const body = JSON.stringify({ message: LINE, room: '#api' });
    expect((await app.request('/api/pkgguard/check', { method: 'POST', headers: { cookie: dan, host: 'localhost', 'content-type': 'application/json' }, body })).status).toBe(403);
    const post = await app.request('/api/pkgguard/check', { method: 'POST', headers: { cookie: maya, host: 'localhost', 'content-type': 'application/json' }, body });
    expect(post.status).toBe(201);
    const ov = await (await app.request('/api/pkgguard/overview', { headers: { cookie: dan, host: 'localhost' } })).json() as any;
    expect(ov.rooms.map((r: any) => r.room)).toEqual(['#api']);
    expect(ov.securityLead.name).toBe('Noor Haddad');
    expect((await app.request('/api/pkgguard/watch/run', { method: 'POST', headers: { cookie: dan, host: 'localhost', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });
});
