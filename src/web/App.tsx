import { useEffect, useState } from 'react';
import { api, go, useApi } from './api';
import { Loading, ToastProvider, useToast } from './components/ui';
import { Landing } from './components/Landing';
import { ControlCenter } from './pages/ControlCenter';
import { WorkflowStudio } from './pages/WorkflowStudio';
import { Missions } from './pages/Missions';
import { MissionWorkspace } from './pages/MissionWorkspace';
import { WorkGraphPage } from './pages/WorkGraphPage';
import { PeopleAgents } from './pages/PeopleAgents';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { EvidencePage } from './pages/EvidencePage';
import { PacksPage } from './pages/PacksPage';
import { SettingsPage } from './pages/SettingsPage';
import { CaseReview } from './pages/CaseReview';
import { HowItWorks } from './pages/HowItWorks';
import { RealityPage } from './pages/RealityPage';

const NAV = [['studio', 'Workflow Studio ✨'], ['case', 'Case Review'], ['how', 'How it works'],['control', 'Control Center'], ['reality', 'Reality Gap Engine'], ['missions', 'Missions'], ['graph', 'Work Graph'], ['people', 'People & Agents'], ['approvals', 'Approvals'], ['evidence', 'Evidence & Outcomes'], ['packs', 'Workflow Packs'], ['settings', 'Settings']] as const;
export type Me = { user: any; workspace: any; collab: any; provider: any };
const useRoute = () => { const [h, setH] = useState(location.hash || '#/control'); useEffect(() => { const f = () => setH(location.hash || '#/control'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []); return h.replace(/^#\//, '').split('/'); };

const DEMO_USERS = [
  { label: '👔 Maya — Manager',    email: 'maya@harborvine.example' },
  { label: '🍳 Luis — Chef',       email: 'luis@harborvine.example' },
  { label: '📦 Priya — Procurement', email: 'priya@harborvine.example' },
  { label: '🛎 Dan — Service',     email: 'dan@harborvine.example' },
  { label: '🏢 Sam — Owner',       email: 'sam@harborvine.example' },
  { label: '👁 Vera — Viewer',     email: 'vera@harborvine.example' },
] as const;

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [loading, setLoading] = useState('');
  const doLogin = async (e: string, p: string) => {
    setErr(''); setLoading(e);
    try { await api('POST', '/auth/login', { email: e, password: p }); onDone(); }
    catch (x) { setErr((x as Error).message); }
    finally { setLoading(''); }
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); doLogin(email, pw); };
  return <div className="login-wrap">
    <form className="card login" onSubmit={submit}>
      <h1>
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="brand-glow">
          <circle cx="16" cy="16" r="4" fill="#10b981" />
          <circle cx="16" cy="16" r="9" fill="none" stroke="#10b981" strokeWidth="2.5" />
          <circle cx="16" cy="16" r="14" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="3 3" opacity=".7" />
        </svg>
        RIPPLE
      </h1>
      <p className="muted tagline">One change. Every consequence identified. Every responsible person coordinated. Every approved action verified.</p>

      <label htmlFor="em">Email</label><input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@harborvine.example" />
      <label htmlFor="pw">Password</label><input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
      <div className="row" style={{ marginTop: 14 }}><button className="primary" type="submit">Sign in</button></div>
      {err && <p className="login-err" role="alert">{err}</p>}

      <div className="divider">Demo — enter instantly</div>
      <div className="login-users">
        {DEMO_USERS.map(u => (
          <button key={u.email} type="button" className="login-user" disabled={!!loading}
            onClick={() => doLogin(u.email, 'ripple-demo')}>
            {loading === u.email ? 'Signing in…' : u.label}
          </button>
        ))}
      </div>
      <p className="muted small login-hint">Demo users share the password <span className="mono">ripple-demo</span> (set <span className="mono">RIPPLE_SEED_PASSWORD</span> to change it).</p>
    </form>
  </div>;
}

function Shell({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const route = useRoute(); const toast = useToast();
  const { data: ov } = useApi<any>('/overview', 6000);
  const badge = (k: string) => k === 'approvals' ? ov?.pendingApprovals?.length : k === 'control' ? (ov?.blocked?.length ?? 0) + (ov?.recovery?.length ?? 0) : 0;
  const page = route[0] ?? 'control';
  const logout = async () => { try { await api('POST', '/auth/logout'); reloadMe(); } catch (e) { toast.err(e); } };
  return <div className="shell">
    <nav className="nav" aria-label="Main">
      <div className="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden className="brand-glow">
          <circle cx="16" cy="16" r="4" fill="#10b981" />
          <circle cx="16" cy="16" r="9" fill="none" stroke="#10b981" strokeWidth="2.5" />
          <circle cx="16" cy="16" r="14" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="3 3" opacity=".7" />
        </svg>
        <span>RIPPLE</span>
        <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(16,185,129,0.2)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)', fontWeight: 700 }}>WORKFLOWS</span>
      </div>
      {NAV.map(([k, label]) => <a key={k} href={`#/${k}`} className={page === k || (k === 'missions' && page === 'mission') ? 'active' : ''}>{label}{badge(k) ? <span className="count">{badge(k)}</span> : null}</a>)}
      <div className="spacer" />
      <div className="who"><strong style={{ color: '#fff' }}>{me.user.name}</strong><br />{me.user.title} · {me.user.role}<br />{me.workspace.name}<br /><button className="sm" style={{ marginTop: 8 }} onClick={logout}>Sign out</button></div>
    </nav>
    <main>
      {page === 'studio' && <WorkflowStudio me={me} />}
      {page === 'case' && <CaseReview />}
      {page === 'how' && <HowItWorks />}
      {page === 'control' && <ControlCenter me={me} />}
      {page === 'reality' && <RealityPage me={me} />}
      {page === 'missions' && <Missions me={me} />}
      {page === 'mission' && route[1] && <MissionWorkspace id={route[1]} me={me} />}
      {page === 'graph' && <WorkGraphPage />}
      {page === 'people' && <PeopleAgents />}
      {page === 'approvals' && <ApprovalsPage me={me} />}
      {page === 'evidence' && <EvidencePage />}
      {page === 'packs' && <PacksPage />}
      {page === 'settings' && <SettingsPage me={me} onWorkspaceDeleted={reloadMe} />}
      {!NAV.some(([k]) => k === page) && page !== 'mission' && <p>Page not found. <a href="#/control">Go to the Control Center</a></p>}
    </main>
  </div>;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = async () => { try { setMe(await api<Me>('GET', '/auth/me')); } catch { setMe(null); } };
  useEffect(() => { load(); }, []);
  if (me === undefined) return <Loading />;
  return <ToastProvider>{me ? <Shell me={me} reloadMe={load} /> : <Landing><Login onDone={() => { go('#/control'); load(); }} /></Landing>}</ToastProvider>;
}
