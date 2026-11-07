import { lazy, Suspense, type ComponentType } from 'react';
import { api, useApi } from '../api';
import { Loading, useAction } from '../components/ui';
import type { Me } from '../App';
import { MissionControl } from './dash/MissionControl';
import { Missions } from './Missions';

/**
 * Session 20: fewer pages. The Command Center holds what used to be five pages (Mission Control, Operations Workbench,
 * Trust & Evidence, Knowledge & Decisions, Agent Review) as tabs; Missions holds the mission list and the Control Center.
 * Every tab is the same component as before, so nothing was removed.
 */
const named = <K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, key: K) => lazy(() => load().then((m) => ({ default: m[key] })));
const Workbench = named(() => import('./dash/Workbench'), 'Workbench');
const TrustCenter = named(() => import('./dash/TrustCenter'), 'TrustCenter');
const KnowledgeCenter = named(() => import('./dash/KnowledgeCenter'), 'KnowledgeCenter');
const AgentReview = named(() => import('./FlipsidePage'), 'FlipsidePage');
const ControlCenter = named(() => import('./ControlCenter'), 'ControlCenter');

const HUB_TABS = [['overview', 'Overview'], ['operations', 'Operations'], ['trust', 'Trust & Evidence'], ['knowledge', 'Knowledge & Decisions'], ['review', 'Agent Review']] as const;
const MISSION_TABS = [['list', 'All missions'], ['control', 'Control Center']] as const;

function Tabs({ base, tabs, tab }: { base: string; tabs: readonly (readonly [string, string])[]; tab: string }) {
  return <div className="hub-tabs" role="tablist">{tabs.map(([k, label]) => <a key={k} role="tab" aria-selected={k === tab} className={k === tab ? 'on' : ''} href={`#/${base}/${k}`}>{label}</a>)}</div>;
}

/** Shown when the workspace has no missions yet: one click fills it with labelled demo activity run through the engine. */
export function EmptyWorkspace({ me, onLoaded }: { me: Me; onLoaded?: () => void }) {
  const { data } = useApi<any>('/overview');
  const { busy, run } = useAction();
  const empty = data && (data.counts?.total ?? data.missions?.length ?? 0) === 0;
  if (!empty) return null;
  const canLoad = me.user.role === 'manager' || me.user.role === 'owner';
  return <div className="banner info" role="status" style={{ marginBottom: 14 }}>
    <strong>This workspace has no missions yet.</strong>{' '}
    {canLoad ? <>Load labelled demo activity: every workflow is run through the real engine (questions answered by the right person, approvals decided, actions verified).{' '}
      <button className="sm primary" disabled={busy === 'demo'} onClick={async () => { const r = await run('demo', () => api('POST', '/demo/activity'), 'Demo activity loaded'); if (r) { onLoaded?.(); location.reload(); } }}>{busy === 'demo' ? 'Running every workflow…' : 'Load demo activity'}</button></>
      : 'Ask a manager or owner to start a mission or load demo activity.'}
  </div>;
}

export function CommandCenter({ me, tab }: { me: Me; tab: string }) {
  const t = HUB_TABS.some(([k]) => k === tab) ? tab : 'overview';
  return <>
    <EmptyWorkspace me={me} />
    <Tabs base="home" tabs={HUB_TABS} tab={t} />
    <Suspense fallback={<Loading />}>
      {t === 'overview' && <MissionControl me={me} />}
      {t === 'operations' && <Workbench />}
      {t === 'trust' && <TrustCenter me={me} />}
      {t === 'knowledge' && <KnowledgeCenter />}
      {t === 'review' && <AgentReview me={me} />}
    </Suspense>
  </>;
}

export function MissionsHub({ me, tab }: { me: Me; tab: string }) {
  const t = MISSION_TABS.some(([k]) => k === tab) ? tab : 'list';
  return <>
    <Tabs base="missions" tabs={MISSION_TABS} tab={t} />
    <Suspense fallback={<Loading />}>
      {t === 'list' && <Missions me={me} />}
      {t === 'control' && <ControlCenter me={me} />}
    </Suspense>
  </>;
}
