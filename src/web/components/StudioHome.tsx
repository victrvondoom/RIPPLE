import { api, go, useApi } from '../api';

/** Right-hand home panel shown when nothing is selected. Live data: capability coverage and work in flight (GET /api/dash/mission-control). */
export function StudioHome({ name, doneCount, onAsk }: { name: string; doneCount: number; onAsk: (q: string) => void }) {
  const { data } = useApi<any>('/dash/mission-control', 10000);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const k = data?.kpis;
  const ask = async (q: string) => { try { await api('POST', '/console/say', { text: q }); } catch { /* the Switch room shows the error */ } onAsk(q); go('#/switch'); };
  const asks = !k ? [] : [k.awaitingApproval ? 'list approvals' : 'status', k.blocked || k.recovery ? 'what needs attention' : 'brief me'];
  return <div className="studio-home">
    <div className="home-banner" aria-hidden />
    <h3>{greet}, {name}</h3>
    <p className="muted small">{!k ? 'Loading…' : k.active ? `${k.active} active mission(s) · ${k.awaitingApproval} awaiting approval · ${k.blocked} blocked · ${k.recovery} in recovery.` : 'No active missions right now.'}</p>
    <div className="home-card">
      <div className="row between"><strong>Capability coverage</strong><span className="muted small">verified completion per system</span></div>
      {(data?.coverage ?? []).filter((c: any) => c.missions > 0).map((c: any) => <div key={c.id} className="budget">
        <div className="row between small"><span>{c.short}</span><span className="muted">{c.completed}/{c.missions} complete</span></div>
        <div className="bar"><i style={{ width: `${c.coverage}%`, background: c.coverage >= 50 ? '#22c55e' : '#f59e0b' }} /></div>
      </div>)}
      {data && !data.coverage.some((c: any) => c.missions > 0) && <p className="muted small">No missions yet. Simulate a workflow or start a demo pack.</p>}
    </div>
    <details className="home-card" open>
      <summary><strong>Running on its own</strong></summary>
      {(data?.pipeline ?? []).filter((p: any) => p.stage !== 'complete').map((p: any) => <div key={p.stage} className="row between small feed"><span>○ {p.stage}</span><span className="muted">{p.count} mission(s)</span></div>)}
      {data && <div className="row between small feed"><span>○ agent tasks</span><span className="muted">{Object.entries(data.agentTasks).map(([s, n]) => `${n} ${s}`).join(' · ') || 'none'}</span></div>}
    </details>
    <div className="home-card row between"><strong>Done</strong><span className="muted">{doneCount}</span></div>
    <div className="home-asks">
      {asks.map((q) => <button key={q} className="ask" onClick={() => void ask(q)}>{q} <span>↗</span></button>)}
    </div>
  </div>;
}
