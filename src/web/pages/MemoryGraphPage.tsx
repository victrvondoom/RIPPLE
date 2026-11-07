import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api';
import { Empty, ErrorView, Loading } from '../components/ui';
import { WorkGraphPage } from './WorkGraphPage';

/**
 * Memory Graph (session 20). Renders /api/memory/graph: the workspace as one connected graph built from recorded rows.
 * Type what you are looking for and the graph moves there; click any node to walk to it. The trail of visited nodes is a
 * per-browser convenience (localStorage), not shared state.
 */
const COLORS: Record<string, string> = { workflow: '#1c1817', mission: '#e0603c', person: '#2f7d5b', agent: '#4c62c4', decision: '#b5701c', action: '#8a3a8a' };
const LABEL: Record<string, string> = { workflow: 'Workflow', mission: 'Mission', person: 'Person', agent: 'Agent', decision: 'Decision', action: 'Action' };
const TRAIL_KEY = 'ripple.memory.trail';
const readTrail = (): { id: string; label: string }[] => { try { return JSON.parse(localStorage.getItem(TRAIL_KEY) ?? '[]'); } catch { return []; } };

export function MemoryGraphPage({ tab }: { tab: string }) {
  return <>
    <div className="hub-tabs" role="tablist">
      <a role="tab" aria-selected={tab !== 'mission'} className={tab !== 'mission' ? 'on' : ''} href="#/graph">Memory graph</a>
      <a role="tab" aria-selected={tab === 'mission'} className={tab === 'mission' ? 'on' : ''} href="#/graph/mission">One mission's dependencies</a>
    </div>
    {tab === 'mission' ? <WorkGraphPage /> : <Memory />}
  </>;
}

function Memory() {
  const [focus, setFocus] = useState<string | null>(null);
  const [ask, setAsk] = useState(''); const [q, setQ] = useState('');
  const [trail, setTrail] = useState(readTrail);
  const path = `/memory/graph?${new URLSearchParams({ ...(focus ? { focus } : {}), ...(q ? { q } : {}) }).toString()}`;
  const { data, error, loading } = useApi<any>(path);
  useEffect(() => {
    if (!data?.focus) return; const n = data.nodes.find((x: any) => x.id === data.focus); if (!n) return;
    setTrail((t) => { const next = [...t.filter((x) => x.id !== n.id), { id: n.id, label: n.label }].slice(-8); try { localStorage.setItem(TRAIL_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ } return next; });
  }, [data?.focus]); // the trail follows the focus only
  const go = (id: string) => { setQ(''); setFocus(id); };
  const layout = useMemo(() => {
    if (!data?.nodes?.length) return null;
    const W = 900, H = 620, cx = W / 2, cy = H / 2;
    const r1 = data.nodes.filter((n: any) => n.depth === 1); const r2 = data.nodes.filter((n: any) => n.depth === 2);
    const pos = new Map<string, { x: number; y: number }>([[data.focus, { x: cx, y: cy }]]);
    r1.forEach((n: any, i: number) => { const a = (i / Math.max(1, r1.length)) * Math.PI * 2 - Math.PI / 2; const rr = r1.length > 14 && i % 2 ? 1.25 : 1; pos.set(n.id, { x: cx + Math.cos(a) * 165 * rr, y: cy + Math.sin(a) * 140 * rr }); });
    r2.forEach((n: any, i: number) => { const a = (i / Math.max(1, r2.length)) * Math.PI * 2 - Math.PI / 2 + 0.2; pos.set(n.id, { x: cx + Math.cos(a) * 380, y: cy + Math.sin(a) * 265 }); });
    return { W, H, pos };
  }, [data]);
  if (error) return <ErrorView error={error} />;
  const centre = data?.nodes?.find((n: any) => n.id === data.focus);
  return <>
    <h1 style={{ marginTop: 0 }}>Memory Graph</h1>
    <p className="muted" style={{ marginTop: 0 }}>Everything this workspace remembers, connected: workflows, missions, people, agents, decisions and actions. Say what you are looking for, then click to walk the graph.{data?.totals ? ` ${data.totals.nodes} things, ${data.totals.edges} links.` : ''}</p>
    <form className="row" style={{ gap: 8, marginBottom: 10 }} onSubmit={(e) => { e.preventDefault(); setFocus(null); setQ(ask.trim()); }}>
      <input aria-label="Ask the graph" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Noor, rollback, package, refund, Maya" style={{ flex: 1 }} />
      <button className="primary" type="submit">Go</button>
    </form>
    {data?.matches?.length > 0 && <div className="mg-matches">{data.matches.map((m: any) => <button key={m.id} className="chip" onClick={() => go(m.id)}><i style={{ background: COLORS[m.type] }} />{LABEL[m.type]}: {m.label}</button>)}</div>}
    {q && data && !data.matches.length && <p className="small muted">Nothing matched “{q}”. Showing the most connected person instead.</p>}
    {trail.length > 1 && <div className="mg-trail small"><span className="muted">Your trail:</span>{trail.map((t, i) => <button key={t.id} className="linkish" onClick={() => go(t.id)}>{i ? ' → ' : ' '}{t.label.slice(0, 32)}</button>)}</div>}
    {loading && !data ? <Loading /> : !layout ? <Empty>Nothing recorded yet. Start a mission or load demo activity from the Command Center.</Empty> :
      <div className="grid mg-grid">
        <div className="card mg-canvas">
          <svg viewBox={`0 0 ${layout.W} ${layout.H}`} role="img" aria-label={`Graph around ${centre?.label ?? ''}`}>
            {data.edges.map((e: any, i: number) => { const a = layout.pos.get(e.from), b = layout.pos.get(e.to); if (!a || !b) return null; const hot = e.from === data.focus || e.to === data.focus; const few = data.nodes.filter((x: any) => x.depth === 1).length <= 10; return <g key={i}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`mg-edge${hot ? ' hot' : ''}`} />{hot && few && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} className="mg-elabel">{e.label}</text>}</g>; })}
            {data.nodes.map((n: any) => { const p = layout.pos.get(n.id); if (!p) return null; const r = n.depth === 0 ? 26 : n.depth === 1 ? 13 : 8; return <g key={n.id} className="mg-node" transform={`translate(${p.x},${p.y})`} onClick={() => go(n.id)} role="button" tabIndex={0} aria-label={`${LABEL[n.type]}: ${n.label}`} onKeyDown={(e) => { if (e.key === 'Enter') go(n.id); }}>
              <circle r={r} fill={COLORS[n.type]} opacity={n.depth === 2 ? 0.55 : 1} />
              {(n.depth === 0 || (n.depth === 1 && data.nodes.filter((x: any) => x.depth === 1).length <= 14)) && <text y={r + 13} className={`mg-label${n.depth === 0 ? ' big' : ''}`}>{n.label.length > 30 ? `${n.label.slice(0, 28)}…` : n.label}</text>}
              <title>{`${LABEL[n.type]}: ${n.label} (${n.sub})`}</title>
            </g>; })}
          </svg>
          <div className="mg-legend small">{Object.entries(LABEL).map(([k, l]) => <span key={k}><i style={{ background: COLORS[k] }} />{l}</span>)}</div>
        </div>
        <div className="card">
          {centre && <>
            <div className="small muted">{LABEL[centre.type]}</div>
            <h2 style={{ marginTop: 2 }}>{centre.label}</h2>
            <p className="small muted" style={{ marginTop: 0 }}>{centre.sub}</p>
            <table className="small"><tbody>{centre.facts.map(([k, v]: [string, string]) => <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>)}</tbody></table>
            {centre.type === 'mission' && <a className="btn" style={{ marginTop: 10 }} href={`#/mission/${centre.id.slice('mission:'.length)}`}>Open mission</a>}
            <h3 style={{ marginTop: 14 }}>Connected ({data.nodes.filter((n: any) => n.depth === 1).length}{data.hiddenNeighbours ? ` shown, ${data.hiddenNeighbours} more` : ''})</h3>
            <ul className="list small mg-list">{data.edges.filter((e: any) => e.from === data.focus || e.to === data.focus).slice(0, 40).map((e: any, i: number) => { const other = data.nodes.find((n: any) => n.id === (e.from === data.focus ? e.to : e.from)); return other ? <li key={i}><button className="linkish" onClick={() => go(other.id)}><i className="mg-dot" style={{ background: COLORS[other.type] }} />{e.from === data.focus ? e.label : `${e.label} ←`} {other.label}</button></li> : null; })}</ul>
          </>}
        </div>
      </div>}
  </>;
}
