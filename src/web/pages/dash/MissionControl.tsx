import { useState } from 'react';
import { fmtTime, useApi } from '../../api';
import { Empty, ErrorView, Loading } from '../../components/ui';
import type { Me } from '../../App';
import { Header, Kpi, Meter, Pipeline, Pri, SysTag, Trend, since } from './common';

/** Dashboard 1 — Mission Control: every active mission, what needs a human, and how far each capability system has got. */
export function MissionControl({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<any>('/dash/mission-control', 6000);
  const { data: caps } = useApi<any>('/capabilities');
  const { data: brief } = useApi<any>('/dash/briefing', 30000);
  const [openSys, setOpenSys] = useState<string | null>(null);
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} retry={reload} />; if (!data) return null;
  const k = data.kpis;
  return <>
    <Header kicker="Dashboard 1 · Mission Control" title="Mission orchestration" sub={<>One view of every mission, decision and delivery in {me.workspace.name}. Updated {fmtTime(data.generatedAt)}.</>}
      right={<div className="row"><a className="btn" href="#/workbench">Operations Workbench</a><a className="btn primary" href="#/missions">New mission</a></div>} />

    <div className="card dash-hero">
      <div className="dash-hero-main">
        <div className="dash-kicker">Verified outcome rate</div>
        <div className="dash-hero-num">{k.verifiedRate === null ? '—' : `${k.verifiedRate}%`}</div>
        <div className="small">{k.verifiedRate === null ? 'No action has been executed yet.' : `${k.verified} of ${k.finished} executed actions independently re-read and verified.`}</div>
      </div>
      <div className="dash-hero-chart"><div className="small dash-hero-cap">Independent checks passed · last 14 days</div><Trend points={data.trend} /></div>
    </div>

    <div className="grid g4" style={{ margin: '14px 0' }}>
      <Kpi label="Active missions" value={k.active} sub={`${k.total} in total`} />
      <Kpi label="Checks passed (30 days)" value={k.checksPassedRate === null ? '—' : `${k.checksPassedRate}%`} sub={`${k.checks30d} independent check(s)`} tone={k.checksPassedRate !== null && k.checksPassedRate < 90 ? 'warn' : undefined} />
      <Kpi label="Decisions awaiting approval" value={k.awaitingApproval} sub={<a href="#/approvals">Open the approval queue</a>} tone={k.awaitingApproval ? 'warn' : undefined} />
      <Kpi label="Blocked · recovery" value={`${k.blocked} · ${k.recovery}`} sub="Blocked on missing info · needs recovery" tone={k.recovery ? 'bad' : k.blocked ? 'warn' : undefined} />
    </div>

    <div className="grid dash-split">
      <div className="card">
        <div className="row between"><h2>Needs attention <span className="badge b-bad">{data.attention.filter((a: any) => a.priority === 'critical').length}</span></h2><a className="small" href="#/control">Control Center</a></div>
        {data.attention.length ? <div className="table-wrap"><table><thead><tr><th>Priority</th><th>Item</th><th>Owner</th><th>Waiting</th><th></th></tr></thead><tbody>
          {data.attention.slice(0, 10).map((a: any, i: number) => <tr key={i}>
            <td><Pri p={a.priority} /></td>
            <td><strong>{a.title}</strong><div className="small muted">{a.detail}</div><SysTag id={a.system} /></td>
            <td className="small">{a.owner}</td><td className="small mono">{since(a.since)}</td>
            <td><a className="btn sm" href={a.href}>{a.action}</a></td></tr>)}
        </tbody></table></div> : <Empty>Nothing needs a human right now.</Empty>}
      </div>
      <div className="card">
        <h2>Lifecycle coverage</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Missions per capability system and the share that reached verified completion.</p>
        <ul className="list dash-cov">{data.coverage.map((c: any) => <li key={c.id}>
          <div className="row between"><span><span className="mono small muted">{c.no}</span> <strong>{c.short}</strong></span><span className="small">{c.completed}/{c.missions} complete · {c.active} active</span></div>
          <Meter value={c.coverage} label={`${c.short} completion`} />
          <div className="small muted">{c.packs.length ? `Packs: ${c.packs.join(', ')}` : 'No pack yet; capability is catalogued'} · {c.sources} source project(s)</div>
        </li>)}</ul>
      </div>
    </div>

    <div className="card">
      <div className="row between"><h2>Live orchestration</h2><span className="small muted">Agent tasks: {Object.entries(data.agentTasks).map(([s, n]) => `${n} ${s}`).join(' · ') || 'none yet'}</span></div>
      <Pipeline stages={data.pipeline} />
    </div>

    <div className="grid g2">
      <div className="card">
        <h2>Agent handoffs</h2>
        {data.handoffs.length ? <ul className="list">{data.handoffs.map((h: any) => <li key={h.id}>
          <div className="row between"><span><strong>{h.sender_name}</strong>{h.to_key ? <> → <span className="mono small">{h.to_key}</span></> : null} <span className="badge">{h.kind}</span></span><span className="small muted">{fmtTime(h.created_at)}</span></div>
          <div className="small">{h.body}</div><div className="small muted"><a href={`#/mission/${h.mission_id}`}>{h.mission_title}</a></div></li>)}</ul> : <Empty>No handoffs yet. Start a mission and its role agents coordinate here.</Empty>}
      </div>
      <div className="card">
        <div className="row between"><h2>Scheduled intelligence</h2><span className="badge">{brief?.generator ?? '…'}</span></div>
        <p className="small muted" style={{ marginTop: 0 }}>Operational briefing assembled only from recorded state. Ask for it any time in the Switch room: “brief me”.</p>
        {brief ? <ul className="list">{brief.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul> : <Loading />}
      </div>
    </div>

    {caps && <div className="card">
      <div className="row between"><h2>Capability systems</h2><span className="small muted">{caps.totals.projects} source projects → {caps.totals.systems} systems → {caps.totals.dashboards} dashboards → 1 engine · {caps.totals.packs} implemented packs</span></div>
      <p className="small muted" style={{ marginTop: 0 }}>“Pack-backed” means an implemented pack already exercises the capability. “Catalogued” means the idea is recorded but not yet ported. Nothing here is claimed as integrated beyond that.</p>
      <div className="dash-systems">{caps.systems.map((s: any) => <div key={s.id} className={`dash-system ${openSys === s.id ? 'open' : ''}`}>
        <button className="linkish dash-system-head" aria-expanded={openSys === s.id} onClick={() => setOpenSys(openSys === s.id ? null : s.id)}>
          <span className="mono small muted">{s.no}</span><strong>{s.name}</strong><span className="badge">{s.projects.length}</span>
        </button>
        <div className="small muted">{s.promise}</div>
        <div className="small" style={{ marginTop: 4 }}>{s.packs.length ? s.packs.map((p: any) => <span key={p.id} className="badge b-ok" style={{ marginRight: 4 }}>{p.name} · {p.missions}</span>) : <span className="badge">no pack yet</span>}</div>
        {openSys === s.id && <ul className="list" style={{ marginTop: 8 }}>{s.projects.map((p: any) => <li key={p.id}>
          <div className="row between"><strong>{p.name}</strong><span className={`badge ${p.integration === 'pack-backed' ? 'b-ok' : p.integration === 'pending' ? 'b-warn' : ''}`}>{p.integration}</span></div>
          <div className="small">{p.contributes.join(' · ') || 'Capability not yet identified'}</div>
          <div className="small muted">{p.folder ? <>Source: <span className="mono">{p.folder}/</span></> : 'Brief only (no source in this repo)'}{p.note ? ` · ${p.note}` : ''}</div></li>)}</ul>}
      </div>)}</div>
    </div>}

    {caps && <div className="card">
      <h2>Cross-system scenarios</h2>
      <div className="grid g2">{caps.scenarios.map((s: any) => <div key={s.id} className="dash-scn">
        <div className="row between"><strong><span className="dash-scn-id">{s.id}</span> {s.title}</strong><span className="small muted">{s.live.length} mission(s)</span></div>
        <ol className="dash-steps">{s.steps.map((st: any, i: number) => <li key={i} className={s.live.some((m: any) => m.stage === st.stage && m.state !== 'completed') ? 'live' : ''}>{st.label}</li>)}</ol>
        <div className="small muted">{s.packs.length ? `Runs today through: ${s.packs.join(', ')}` : 'No pack runs this scenario yet; decision memory is served by the Knowledge Center.'}</div>
      </div>)}</div>
    </div>}
  </>;
}
