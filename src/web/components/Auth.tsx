import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Sign in / create account (session 20). Both end on the dashboard at /dashboard. Sign-up creates the person's OWN
 * workspace (owner of every role) and, unless unticked, fills it with labelled demo activity run through the engine.
 */
const DEMO_USERS = [
  { label: '👔 Maya — Manager', email: 'maya@harborvine.example' },
  { label: '🍳 Luis — Chef', email: 'luis@harborvine.example' },
  { label: '📦 Priya — Procurement', email: 'priya@harborvine.example' },
  { label: '🛎 Dan — Service', email: 'dan@harborvine.example' },
  { label: '🏢 Sam — Owner', email: 'sam@harborvine.example' },
  { label: '👁 Vera — Viewer', email: 'vera@harborvine.example' },
] as const;

export const toDashboard = () => {
  const legacy = location.hash && location.hash.startsWith('#/') ? location.hash : '#/home';
  location.assign(`/dashboard${legacy}`);
};

export function Auth({ initial }: { initial: 'signin' | 'signup' }) {
  const [tab, setTab] = useState(initial);
  useEffect(() => { history.replaceState(null, '', tab === 'signup' ? `/signup${location.hash}` : `/${location.hash}`); }, [tab]);
  return <div className="login-wrap">
    <div className="card login">
      <h1>
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="brand-glow"><circle cx="16" cy="16" r="4" fill="#10b981" /><circle cx="16" cy="16" r="9" fill="none" stroke="#10b981" strokeWidth="2.5" /><circle cx="16" cy="16" r="14" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="3 3" opacity=".7" /></svg>
        RIPPLE
      </h1>
      <div className="auth-tabs" role="tablist">
        <button role="tab" type="button" aria-selected={tab === 'signin'} className={tab === 'signin' ? 'on' : ''} onClick={() => setTab('signin')}>Sign in</button>
        <button role="tab" type="button" aria-selected={tab === 'signup'} className={tab === 'signup' ? 'on' : ''} onClick={() => setTab('signup')}>Create account</button>
      </div>
      {tab === 'signin' ? <SignIn /> : <SignUp />}
    </div>
  </div>;
}

function SignIn() {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [loading, setLoading] = useState('');
  const doLogin = async (e: string, p: string) => {
    setErr(''); setLoading(e);
    try { await api('POST', '/auth/login', { email: e, password: p }); toDashboard(); }
    catch (x) { setErr((x as Error).message); setLoading(''); }
  };
  return <form onSubmit={(e) => { e.preventDefault(); doLogin(email, pw); }}>
    <label htmlFor="em">Email</label><input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@company.com" />
    <label htmlFor="pw">Password</label><input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
    <div className="row" style={{ marginTop: 12 }}><button className="primary" type="submit" disabled={!!loading}>Sign in</button></div>
    {err && <p className="login-err" role="alert">{err}</p>}
    <div className="divider">Demo — enter instantly</div>
    <div className="login-users">
      {DEMO_USERS.map((u) => <button key={u.email} type="button" className="login-user" disabled={!!loading} onClick={() => doLogin(u.email, 'ripple-demo')}>{loading === u.email ? 'Signing in…' : u.label}</button>)}
    </div>
    <p className="muted small login-hint">Demo users share the password <span className="mono">ripple-demo</span>.</p>
  </form>;
}

function SignUp() {
  const [f, setF] = useState({ name: '', email: '', password: '', workspace: '', demoData: true });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === 'demoData' ? e.target.checked : e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('POST', '/auth/signup', { name: f.name, email: f.email, password: f.password, workspace: f.workspace || undefined, demoData: f.demoData }); toDashboard(); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return <form onSubmit={submit}>
    <label htmlFor="su-name">Your name</label><input id="su-name" value={f.name} onChange={set('name')} autoComplete="name" required minLength={2} />
    <label htmlFor="su-email">Email</label><input id="su-email" type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
    <label htmlFor="su-pw">Password (8+ characters)</label><input id="su-pw" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required minLength={8} />
    <label htmlFor="su-ws">Workspace name (optional)</label><input id="su-ws" value={f.workspace} onChange={set('workspace')} placeholder="Acme Operations" />
    <label className="inline" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}><input type="checkbox" checked={f.demoData} onChange={set('demoData')} style={{ width: 'auto' }} /> Start with demo activity (labelled)</label>
    <div className="row" style={{ marginTop: 12 }}><button className="primary" type="submit" disabled={busy}>{busy ? 'Creating your workspace…' : 'Create account'}</button></div>
    {err && <p className="login-err" role="alert">{err}</p>}
    <p className="muted small login-hint">You get your own workspace. You own every role in it, so you can run any workflow end to end.</p>
  </form>;
}
