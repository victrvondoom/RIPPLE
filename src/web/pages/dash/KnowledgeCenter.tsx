import { useMemo, useState } from 'react';
import { fmtTime, useApi } from '../../api';
import { Empty, ErrorView, Loading, Status } from '../../components/ui';
import { Header, Kpi, SysTag } from './common';

const VAL: Record<string, string> = { valid: 'b-ok', applied: 'b-info', superseded: 'b-warn', unknown: '' };

/** Dashboard 4 — Knowledge & Decision Center: what was decided, why, by whom, on what evidence, and whether it still holds. */
export function KnowledgeCenter() {
  const { data, error, loading, reload } = useApi<any>('/dash/knowledge', 10000);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const history = useMemo(() => (data?.history ?? []).filter((h: any) => !q || `${h.title} ${h.rationale} ${h.by} ${h.mission}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (loading && !data) return <Loading />; if (error) return <ErrorView error={error} retry={reload} />; if (!data) return null;
  const h = data.health;
  const related = sel ? data.history.filter((x: any) => `u:${x.by_id}` === sel || `m:${x.mission_id}` === sel || `d:${x.id}` === sel) : [];
  const first = related[0];
  return <>
    <Header kicker="Dashboard 4 · Knowledge & Decisions" title="Organisational memory" sub="Decision continuity across every room: each decision with its rationale, its author, its evidence and whether it is still valid." />
    <div className="grid g4" style={{ margin: '14px 0' }}>
      <Kpi label="Decisions recorded" value={h.decisions} sub="approvals + answered questions" />
      <Kpi label="Still valid" value={h.valid} sub={`${h.superseded} superseded by later changes`} tone="ok" />
      <Kpi label="Open contradictions" value={h.contradictionsOpen} tone={h.contradictionsOpen ? 'bad' : undefined} />
      <Kpi label="Outdated items" value={h.outdated} sub="stale actions, earlier-revision drafts" tone={h.outdated ? 'warn' : undefined} />
    </div>

    <div className="grid dash-split">
      <div className="card" style={{ minWidth: 0 }}>
        <div className="row between"><h2>Decision graph</h2><span className="small muted">people → decisions → missions · select a node</span></div>
        {data.graph.nodes.length ? <DecisionGraph nodes={data.graph.nodes} edges={data.graph.edges} sel={sel} onSel={setSel} /> : <Empty>No decisions yet. Approvals and answered questions appear here as they are made.</Empty>}
      </div>
      <div className="card">
        <h2>{first ? 'Selected' : 'Briefing'}</h2>
        {first ? <>
          <div className="small muted">{sel?.startsWith('u:') ? 'Person' : sel?.startsWith('m:') ? 'Mission' : 'Decision'}</div>
          <h3 style={{ marginTop: 4 }}>{sel?.startsWith('u:') ? first.by : sel?.startsWith('m:') ? first.mission : first.title}</h3>
          <ul className="list">{related.map((r: any) => <li key={r.id}><div className="row between"><strong className="small">{r.title}</strong><span className={`badge ${VAL[r.validity]}`}>{r.validity}</span></div>
            <div className="small">“{r.rationale || 'no rationale recorded'}”</div><div className="small muted">{r.decision} by {r.by} · {fmtTime(r.at)} · evidence {r.evidencePassed}/{r.evidence}</div></li>)}</ul>
          <button className="sm" onClick={() => setSel(null)}>Clear selection</button>
        </> : <>
          <p className="small muted" style={{ marginTop: 0 }}>Generated {fmtTime(data.briefing.generatedAt)} · {data.briefing.generator}, from recorded state only.</p>
          <ul className="list">{data.briefing.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
        </>}
      </div>
    </div>

    <div className="card">
      <div className="row between"><h2>Decision & rationale history</h2><input aria-label="Search decisions" placeholder="Search decisions, rationale, people…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} /></div>
      {history.length ? <div className="table-wrap"><table><thead><tr><th>Decision</th><th>Rationale</th><th>By</th><th>Workspace</th><th>Evidence</th><th>Validity</th></tr></thead><tbody>
        {history.map((x: any) => <tr key={x.id}>
          <td><strong className="small">{x.title}</strong><div className="small muted"><Status s={x.decision} /> · <a href={`#/mission/${x.mission_id}`}>{x.mission}</a></div></td>
          <td className="small">{x.rationale || '—'}</td><td className="small">{x.by}<div className="muted">{fmtTime(x.at)}</div></td>
          <td><SysTag id={x.system} /></td><td className="small">{x.kind === 'approval' ? `${x.evidencePassed}/${x.evidence} passed` : '—'}</td>
          <td><span className={`badge ${VAL[x.validity]}`}>{x.validity}</span></td></tr>)}
      </tbody></table></div> : <Empty>{data.history.length ? 'No decision matches.' : 'No decision recorded yet.'}</Empty>}
    </div>

    <div className="grid g2">
      <div className="card">
        <h2>Cross-workspace contradictions</h2>
        {data.contradictions.length ? <ul className="list">{data.contradictions.map((c: any) => <li key={c.id}><div className="row between"><strong className="small">{c.title}</strong><span className={`badge ${c.severity === 'high' || c.severity === 'critical' ? 'b-bad' : 'b-warn'}`}>{c.severity}</span></div>
          <div className="small">{c.explanation}</div><div className="small muted">{c.source} · {(c.domains ?? []).filter(Boolean).join(', ')} · {c.status} · {fmtTime(c.detected_at)}</div>{c.recommendation && <div className="small">→ {c.recommendation}</div>}</li>)}</ul>
          : <Empty>No contradictions recorded. Cross-domain campaigns (Reality Gap Engine) and approved-but-unverified outcomes surface here.</Empty>}
      </div>
      <div className="card">
        <h2>Outdated information</h2>
        {data.outdated.length ? <ul className="list">{data.outdated.map((o: any) => <li key={`${o.kind}${o.id}`}><span className="badge b-warn">{o.kind}</span> <strong className="small">{o.title}</strong><div className="small muted">{o.reason} · <a href={`#/mission/${o.mission_id}`}>{o.mission}</a></div></li>)}</ul> : <Empty>Nothing is outdated.</Empty>}
      </div>
      <div className="card">
        <h2>Commitments to the outside</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Client and outbound messages. “Proven” means the effect was read back and verified (local/dry-run connectors).</p>
        {data.commitments.length ? <ul className="list">{data.commitments.map((c: any) => <li key={c.id}><div className="row between"><strong className="small">{c.title}</strong>{c.proven ? <span className="badge b-ok">proven</span> : <Status s={c.status} />}</div><div className="small muted">{c.connector} · {c.owner} · <a href={`#/mission/${c.mission_id}`}>{c.mission}</a></div></li>)}</ul> : <Empty>No outbound commitments yet.</Empty>}
      </div>
      <div className="card">
        <h2>Responsibility</h2>
        <div className="table-wrap"><table><thead><tr><th>Person</th><th>Open work</th><th>Overdue</th><th>Approvals waiting</th><th>Decisions</th></tr></thead><tbody>
          {data.responsibility.map((p: any) => <tr key={p.id}><td><strong className="small">{p.name}</strong><div className="small muted">{p.title}</div></td><td>{p.open}</td><td>{p.overdue ? <span className="badge b-bad">{p.overdue}</span> : 0}</td><td>{p.approvalsWaiting}</td><td>{p.decisions}</td></tr>)}
        </tbody></table></div>
      </div>
    </div>
  </>;
}

/** Three-column layered graph (people | decisions | missions). Deterministic layout; no physics, so it never jitters. */
function DecisionGraph({ nodes, edges, sel, onSel }: { nodes: any[]; edges: any[]; sel: string | null; onSel: (id: string) => void }) {
  const cols: Record<string, any[]> = { person: [], decision: [], mission: [] };
  for (const n of nodes) (cols[n.type] ??= []).push(n);
  const rowH = 34; const H = Math.max(...Object.values(cols).map((c) => c.length), 1) * rowH + 20; const W = 760;
  const X: Record<string, number> = { person: 90, decision: 380, mission: 670 };
  const pos = new Map<string, { x: number; y: number }>();
  for (const [t, list] of Object.entries(cols)) { const off = (H - list.length * rowH) / 2; list.forEach((n, i) => pos.set(n.id, { x: X[t], y: off + i * rowH + rowH / 2 })); }
  const linked = (id: string) => !sel || id === sel || edges.some((e) => (e.from === sel && e.to === id) || (e.to === sel && e.from === id));
  return <div className="dash-graph-wrap"><svg viewBox={`0 0 ${W} ${H}`} className="dash-graph" role="img" aria-label="Decision graph">
    {edges.map((e, i) => { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null; const on = !sel || e.from === sel || e.to === sel;
      return <path key={i} d={`M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`} className={`dash-edge ${on ? 'on' : ''}`} />; })}
    {nodes.map((n) => { const p = pos.get(n.id)!; const r = n.type === 'decision' ? 6 : 9;
      return <g key={n.id} className={`dash-node dash-node-${n.type} ${n.tone ? `tone-${n.tone}` : ''} ${linked(n.id) ? '' : 'dim'} ${sel === n.id ? 'sel' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => onSel(n.id)} role="button" tabIndex={0} aria-label={`${n.type}: ${n.label}`} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') onSel(n.id); }}>
        <circle r={r} /><text x={n.type === 'mission' ? -14 : 14} y={4} textAnchor={n.type === 'mission' ? 'end' : 'start'}>{n.label}</text></g>; })}
  </svg></div>;
}
