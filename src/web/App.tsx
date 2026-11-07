import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { api, useApi } from './api';
import { Loading, ToastProvider, useToast } from './components/ui';
import { Landing } from './components/Landing';
import { Auth } from './components/Auth';
import { CommandCenter, MissionsHub } from './pages/Hubs';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { SwitchRoom } from './components/SwitchRoom';

// Larger pages load on demand so the first paint ships a small bundle (one code-split chunk per page).
const named = <K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, key: K) => lazy(() => load().then((m) => ({ default: m[key] })));
const StudioPage = named(() => import('./pages/GuidedStudio'), 'StudioPage');
const MissionWorkspace = named(() => import('./pages/MissionWorkspace'), 'MissionWorkspace');
const MemoryGraphPage = named(() => import('./pages/MemoryGraphPage'), 'MemoryGraphPage');
const PeopleAgents = named(() => import('./pages/PeopleAgents'), 'PeopleAgents');
const EvidencePage = named(() => import('./pages/EvidencePage'), 'EvidencePage');
const PacksPage = named(() => import('./pages/PacksPage'), 'PacksPage');
const SettingsPage = named(() => import('./pages/SettingsPage'), 'SettingsPage');
const CaseReview = named(() => import('./pages/CaseReview'), 'CaseReview');
const HowItWorks = named(() => import('./pages/HowItWorks'), 'HowItWorks');
const RealityPage = named(() => import('./pages/RealityPage'), 'RealityPage');
const PackageGatePage = named(() => import('./pages/PackageGatePage'), 'PackageGatePage');

/** Session 20: a short main menu. Old page links still work (LEGACY maps them to their new home). */
const NAV = [['home', 'Command Center'], ['missions', 'Missions'], ['approvals', 'Approvals'], ['evidence', 'Evidence & Outcomes'], ['package-gate', 'Package Gate'], ['switch', 'Switch Room'], ['graph', 'Memory Graph'], ['people', 'People & Agents'], ['studio', 'Workflow Studio']] as const;
const MORE = [['how', 'How it works'], ['reality', 'Reality Gap Engine'], ['case', 'Case Review'], ['packs', 'Workflow Packs'], ['settings', 'Settings']] as const;
const LEGACY: Record<string, [string, string?]> = {
  'mission-control': ['home', 'overview'], workbench: ['home', 'operations'], trust: ['home', 'trust'], knowledge: ['home', 'knowledge'],
  flipside: ['home', 'review'], review: ['home', 'review'], control: ['missions', 'control'],
};
export type Me = { user: any; workspace: any; collab: any; provider: any };
const useRoute = () => {
  const [h, setH] = useState(location.hash || '#/home');
  useEffect(() => { const f = () => setH(location.hash || '#/home'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const parts = h.replace(/^#\//, '').split('/');
  const legacy = LEGACY[parts[0]];
  return legacy ? [legacy[0], legacy[1] ?? '', ...parts.slice(1)] : parts;
};

function Shell({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const route = useRoute(); const toast = useToast();
  const { data: ov } = useApi<any>('/overview', 6000);
  const badge = (k: string) => k === 'approvals' ? ov?.pendingApprovals?.length : k === 'home' ? (ov?.blocked?.length ?? 0) + (ov?.recovery?.length ?? 0) : 0;
  const page = route[0] || 'home';
  const logout = async () => { try { await api('POST', '/auth/logout'); location.assign('/'); } catch (e) { toast.err(e); } };
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
      <details className="nav-more" open={MORE.some(([k]) => k === page)}><summary>More</summary>
        {MORE.map(([k, label]) => <a key={k} href={`#/${k}`} className={page === k ? 'active' : ''}>{label}</a>)}
      </details>
      <div className="spacer" />
      <div className="who"><strong style={{ color: '#fff' }}>{me.user.name}</strong><br />{me.user.title} · {me.user.role}<br />{me.workspace.name}<br /><button className="sm" style={{ marginTop: 8 }} onClick={logout}>Sign out</button></div>
    </nav>
    <main>
      <Suspense fallback={<Loading />}>
      {page === 'home' && <CommandCenter me={me} tab={route[1] || 'overview'} />}
      {page === 'package-gate' && <PackageGatePage me={me} />}
      {page === 'switch' && <SwitchRoomPage me={me} />}
      {page === 'studio' && <StudioPage me={me} tab={route[1] ?? ''} />}
      {page === 'case' && <CaseReview />}
      {page === 'how' && <HowItWorks />}
      {page === 'reality' && <RealityPage me={me} />}
      {page === 'missions' && <MissionsHub me={me} tab={route[1] || 'list'} />}
      {page === 'mission' && route[1] && <MissionWorkspace id={route[1]} me={me} />}
      {page === 'graph' && <MemoryGraphPage tab={route[1] ?? ''} />}
      {page === 'people' && <PeopleAgents />}
      {page === 'approvals' && <ApprovalsPage me={me} />}
      {page === 'evidence' && <EvidencePage />}
      {page === 'packs' && <PacksPage />}
      {page === 'settings' && <SettingsPage me={me} onWorkspaceDeleted={reloadMe} />}
      {![...NAV, ...MORE].some(([k]) => k === page) && page !== 'mission' && <div className="card"><h1>Page not found</h1><p className="muted">There is no page at “{route.join('/')}”.</p><a className="btn" href="#/home">Go to the Command Center</a></div>}
      </Suspense>
    </main>
    {page !== 'switch' && <SwitchRoom me={me} />}
  </div>;
}

const SwitchRoomPage = named(() => import('./pages/SwitchRoomPage'), 'SwitchRoomPage');

/**
 * Session 20: two addresses. "/" (also /landing, /signup) is the public landing page; "/dashboard" is the signed-in app,
 * whose pages are the part after "#/". Signed out at /dashboard goes to "/"; signed in at "/" goes to /dashboard
 * (an old "/#/page" link keeps its page).
 */
export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = async () => { try { const s = await api<Me | { user: null }>('GET', '/auth/session'); setMe(s.user ? (s as Me) : null); } catch { setMe(null); } };
  useEffect(() => { load(); }, []);
  const inDashboard = location.pathname.startsWith('/dashboard');
  useEffect(() => {
    if (me === undefined) return;
    if (me && !inDashboard) location.replace(`/dashboard${location.hash && location.hash.startsWith('#/') ? location.hash : '#/home'}`);
    if (!me && inDashboard) location.replace('/');
  }, [me, inDashboard]);
  if (me === undefined || (me && !inDashboard) || (!me && inDashboard)) return <Loading />;
  return <ToastProvider><ErrorBoundary>{me ? <Shell me={me} reloadMe={load} /> : <Landing><Auth initial={location.pathname.startsWith('/signup') ? 'signup' : 'signin'} /></Landing>}</ErrorBoundary></ToastProvider>;
}

/** Any render error shows a recoverable message instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="card" style={{ margin: 24 }}><h1>Something went wrong on this page</h1><p className="muted">{this.state.error.message}</p><button onClick={() => { this.setState({ error: null }); location.reload(); }}>Reload</button> <a className="btn" href="/dashboard#/home">Command Center</a></div>;
  }
}
