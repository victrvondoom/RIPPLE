import { lazy, Suspense, useState } from 'react';
import { api, go, useApi } from '../api';
import { Loading, useAction } from '../components/ui';
import type { Me } from '../App';

const WorkflowStudio = lazy(() => import('./WorkflowStudio').then((m) => ({ default: m.WorkflowStudio })));

/**
 * Workflow Studio (session 20): a narrow, guided path through what RIPPLE actually does. Each step narrows the next:
 * area of work → the workflow that handles it → who will be asked (agents and named people, from the role directory) →
 * the change → launch. Everything shown comes from the server (capability systems, pack definitions, the people
 * directory). The original free-form builder is kept as "Advanced builder".
 */
export function StudioPage({ me, tab }: { me: Me; tab: string }) {
  return <>
    <div className="hub-tabs" role="tablist">
      <a role="tab" aria-selected={tab !== 'advanced'} className={tab !== 'advanced' ? 'on' : ''} href="#/studio">Guided</a>
      <a role="tab" aria-selected={tab === 'advanced'} className={tab === 'advanced' ? 'on' : ''} href="#/studio/advanced">Advanced builder</a>
    </div>
    {tab === 'advanced' ? <Suspense fallback={<Loading />}><WorkflowStudio me={me} /></Suspense> : <Guided me={me} />}
  </>;
}

function Guided({ me }: { me: Me }) {
  const { data: caps } = useApi<any>('/capabilities');
  const { data: people } = useApi<any>('/people');
  const [system, setSystem] = useState<string | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const { data: pack } = useApi<any>(packId ? `/packs/${packId}` : null);
  const [change, setChange] = useState<string>('');
  const [title, setTitle] = useState('');
  const { busy, run } = useAction();
  const canLaunch = me.user.role === 'manager' || me.user.role === 'owner';
  const systems = (caps?.systems ?? []).filter((s: any) => s.packs.length);
  const sys = systems.find((s: any) => s.id === system);
  const humans = (pack?.roles ?? []).filter((r: any) => r.kind === 'human').map((r: any) => ({ role: r, person: (people?.users ?? []).find((u: any) => u.roles.some((x: any) => x.pack === packId && x.key === r.key)) }));
  const agents = (pack?.roles ?? []).filter((r: any) => r.kind === 'agent');
  const step = !system ? 1 : !packId ? 2 : !pack ? 3 : 4;
  const launch = async () => {
    let parsed: unknown; try { parsed = JSON.parse(change || JSON.stringify(pack.sample.change)); } catch { return; }
    const r = await run('launch', async () => {
      const m = await api<any>('POST', '/missions', { packId, title: title || `${pack.sample.title} [demo]`, plan: pack.sample.plan, source: 'demo-studio' });
      await api('POST', `/missions/${m.mission.id}/baseline`, { note: 'Baseline from the guided studio (labelled sample plan)' });
      await api('POST', `/missions/${m.mission.id}/changes`, parsed);
      return m.mission.id as string;
    }, 'Mission launched and analysed');
    if (r) go(`#/mission/${r}`);
  };
  const reset = (to: number) => { if (to <= 1) setSystem(null); if (to <= 2) setPackId(null); setChange(''); setTitle(''); };
  if (!caps) return <Loading />;
  return <div>
    <h1 style={{ marginTop: 0 }}>Workflow Studio</h1>
    <p className="muted" style={{ marginTop: 0 }}>Turn one change into a coordinated, verified mission in four choices.</p>
    <ol className="gs-path">{['Area of work', 'Workflow', 'Who is involved', 'The change'].map((l, i) => <li key={l} className={step > i + 1 ? 'done' : step === i + 1 ? 'on' : ''}><button className="linkish" disabled={step <= i + 1} onClick={() => reset(i + 1)}>{i + 1}. {l}</button></li>)}</ol>

    {step === 1 && <div className="gs-grid">{systems.map((s: any) => <button key={s.id} className="card gs-card" onClick={() => setSystem(s.id)}>
      <strong>{s.name}</strong><span className="small muted">{s.promise}</span><span className="small">{s.packs.length} workflow(s) · {s.packs.reduce((n: number, p: any) => n + p.missions, 0)} mission(s) so far</span>
    </button>)}</div>}

    {step === 2 && sys && <div className="gs-grid">{sys.packs.map((p: any) => <button key={p.id} className="card gs-card" onClick={() => setPackId(p.id)}>
      <strong>{p.name}</strong><span className="small muted">{p.domain}</span><span className="small">{p.missions} mission(s) so far</span>
    </button>)}</div>}

    {step >= 3 && !pack && <Loading />}
    {step >= 4 && pack && <div className="grid g2">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{pack.name}</h2>
        <p className="small muted">{pack.description}</p>
        <h3>Agents that analyse the change</h3>
        <ul className="list small">{agents.map((r: any) => <li key={r.key}><strong>{r.name}</strong> — {r.responsibility}{r.scope === 'read' ? ' (read-only)' : ''}</li>)}</ul>
        <h3>People who decide</h3>
        <ul className="list small">{humans.length ? humans.map(({ role, person }: any) => <li key={role.key}><strong>{role.name}</strong>: {person ? `${person.name} (${person.title ?? person.role})` : <span className="badge b-warn">nobody mapped</span>} — {role.responsibility}</li>) : <li>No human decision role; a manager approves consequential actions.</li>}</ul>
        <h3>What it produces</h3>
        <ul className="list small">{pack.artifacts.map((a: any) => <li key={a.key}><strong>{a.label}</strong> — {a.description}</li>)}</ul>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{pack.labels.change}</h2>
        <p className="small muted">Starts from the labelled example for this workflow. Edit it if you like; the server validates it.</p>
        <label htmlFor="gs-title">Mission title</label><input id="gs-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${pack.sample.title} [demo]`} />
        <label htmlFor="gs-change">{pack.labels.change} (JSON)</label>
        <textarea id="gs-change" className="code" rows={14} value={change || JSON.stringify(pack.sample.change, null, 2)} onChange={(e) => setChange(e.target.value)} />
        {(() => { try { JSON.parse(change || '{}'); return null; } catch { return <p className="small" style={{ color: 'var(--bad)' }}>Not valid JSON yet.</p>; } })()}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={!canLaunch || busy === 'launch'} onClick={launch}>{busy === 'launch' ? 'Launching…' : `${pack.labels.changeVerb} and analyse`}</button>
          {!canLaunch && <span className="small muted">Only a manager or owner can launch a mission.</span>}
        </div>
      </div>
    </div>}
  </div>;
}
