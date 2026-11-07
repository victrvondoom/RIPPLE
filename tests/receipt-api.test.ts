import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/api/app.js';
import { makeEnv } from './helpers.js';

/** Session 16: the signed-receipt routes are reachable over HTTP with the same roles as the seal routes (issue = manager/owner). */
function client() {
  const env = makeEnv();
  const app = createApp(env.engine, { webRoot: '/nonexistent' });
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const login = async (email: string) => { cookie = ''; return call('POST', '/api/auth/login', { email, password: 'pw-test-123' }); };
  return { env, call, login };
}

describe('signed ledger receipt routes', () => {
  it('lets a manager issue a receipt and verify it against the live ledger', async () => {
    const { call, login } = client();
    expect((await login('maya@harborvine.example')).status).toBe(200);
    const issued = await call('POST', '/api/dash/trust/receipt');
    expect(issued.status).toBe(200);
    expect(issued.json.format).toBe('ripple-ledger-receipt/1');
    expect(issued.json.signed).toBe(false); // no RIPPLE_RECEIPT_PRIVATE_KEY in the test environment
    const v = await call('POST', '/api/dash/trust/receipt/verify', { receipt: issued.json });
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ verdict: 'unsigned', prefixIntact: true, workspaceMatches: true });
  });

  it('refuses to issue a receipt to a viewer, and tolerates a verify request with no body', async () => {
    const { call, login } = client();
    expect((await login('vera@harborvine.example')).status).toBe(200);
    expect((await call('POST', '/api/dash/trust/receipt')).status).toBe(403);
    const v = await call('POST', '/api/dash/trust/receipt/verify');
    expect(v.status).toBe(200);
    expect(v.json.verdict).toBe('not-intact');
  });
});
