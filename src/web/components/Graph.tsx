import { useMemo, useState } from 'react';

export interface GNode { id: string; kind: string; key: string; label: string; status: string; data?: any }
export interface GEdge { id: string; from_node: string; to_node: string; relation: string }
const COLOR: Record<string, string> = { change: '#d9480f', artifact: '#2455d6', department: '#7048e8', owner: '#868e96', decision: '#c2255c', task: '#0b7285', action: '#2b8a3e', evidence: '#12805c' };
const W = 176, H = 40, GX = 70, GY = 14;

/** Longest-path layering of the dependency DAG (change → artifact → … → evidence), barycentre ordering within layers. */
function layout(nodes: GNode[], edges: GEdge[]) {
  const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) { let changed = false; for (const e of edges) { const a = layer.get(e.from_node), b = layer.get(e.to_node); if (a !== undefined && b !== undefined && b < a + 1) { layer.set(e.to_node, a + 1); changed = true; } } if (!changed) break; }
  const cols: GNode[][] = [];
  for (const n of nodes) (cols[layer.get(n.id)!] ??= []).push(n);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => {
    if (!col) return;
    if (ci > 0) col.sort((a, b) => bary(a) - bary(b));
    else col.sort((a, b) => a.label.localeCompare(b.label));
    col.forEach((n, i) => pos.set(n.id, { x: ci * (W + GX) + 10, y: i * (H + GY) + 10 }));
  });
  function bary(n: GNode) { const ps = edges.filter((e) => e.to_node === n.id).map((e) => pos.get(e.from_node)?.y).filter((y): y is number => y !== undefined); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 1e6; }
  const cw = cols.length * (W + GX), ch = Math.max(...cols.map((c) => (c?.length ?? 0))) * (H + GY) + 20;
  return { pos, width: cw, height: ch };
}
function downstream(edges: GEdge[], start: string) { const out = new Set([start]); const q = [start]; while (q.length) { const c = q.shift()!; for (const e of edges) if (e.from_node === c && !out.has(e.to_node)) { out.add(e.to_node); q.push(e.to_node); } } return out; }
const upstream = (edges: GEdge[], start: string) => downstream(edges.map((e) => ({ ...e, from_node: e.to_node, to_node: e.from_node })), start);

export function Graph({ nodes, edges, kinds }: { nodes: GNode[]; edges: GEdge[]; kinds?: string[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [hide, setHide] = useState<Set<string>>(new Set());
  const vis = useMemo(() => nodes.filter((n) => !hide.has(n.kind)), [nodes, hide]);
  const ve = useMemo(() => { const ids = new Set(vis.map((n) => n.id)); return edges.filter((e) => ids.has(e.from_node) && ids.has(e.to_node)); }, [vis, edges]);
  const { pos, width, height } = useMemo(() => layout(vis, ve), [vis, ve]);
  const hl = useMemo(() => (sel ? new Set([...downstream(ve, sel), ...upstream(ve, sel)]) : null), [sel, ve]);
  const selNode = nodes.find((n) => n.id === sel);
  const present = [...new Set(nodes.map((n) => n.kind))];
  return <div>
    <div className="legend" aria-label="Legend">{present.map((k) => <label key={k} className="inline" style={{ margin: 0 }}><input type="checkbox" checked={!hide.has(k)} onChange={() => setHide((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; })} /><span className="dot" style={{ background: COLOR[k] }} />{k}</label>)}<span className="muted">Click a node to highlight everything upstream and downstream of it.</span></div>
    <div className="graph-wrap"><svg width={Math.max(width, 300)} height={Math.max(height, 100)} role="img" aria-label="Dependency graph">
      <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8a94a8" /></marker></defs>
      {ve.map((e) => { const a = pos.get(e.from_node), b = pos.get(e.to_node); if (!a || !b) return null; const on = !hl || (hl.has(e.from_node) && hl.has(e.to_node)); const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2; return <path key={e.id} d={`M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`} fill="none" stroke="#8a94a8" strokeWidth={on ? 1.4 : 0.6} opacity={on ? 0.85 : 0.15} markerEnd="url(#arr)"><title>{e.relation}</title></path>; })}
      {vis.map((n) => { const p = pos.get(n.id)!; const on = !hl || hl.has(n.id); const c = COLOR[n.kind] ?? '#888'; return <g key={n.id} className="gnode" transform={`translate(${p.x},${p.y})`} opacity={on ? 1 : 0.25} onClick={() => setSel(sel === n.id ? null : n.id)} tabIndex={0} role="button" aria-label={`${n.kind}: ${n.label}`} onKeyDown={(e) => e.key === 'Enter' && setSel(sel === n.id ? null : n.id)}>
        <rect width={W} height={H} rx={5} fill="var(--surface)" stroke={sel === n.id ? 'var(--ink)' : c} strokeWidth={sel === n.id ? 2.5 : 1.5} /><rect width={5} height={H} rx={2} fill={c} />
        <text x={12} y={16}>{trunc(n.label, 27)}</text><text x={12} y={31} style={{ fill: 'var(--muted)', fontSize: 10 }}>{n.kind}{n.status && n.status !== 'open' ? ` · ${n.status}` : ''}</text><title>{n.label}</title></g>; })}
    </svg></div>
    {selNode && <div className="card" style={{ marginTop: 10 }}><div className="row between"><strong>{selNode.label}</strong><span className="badge">{selNode.kind}</span></div>
      <p className="small muted">{[...downstream(ve, selNode.id)].length - 1} downstream and {[...upstream(ve, selNode.id)].length - 1} upstream node(s) highlighted. Incoming: {ve.filter((e) => e.to_node === selNode.id).map((e) => `${nodes.find((n) => n.id === e.from_node)?.label} (${e.relation})`).join('; ') || 'none'}.{selNode.data?.description ? ` ${selNode.data.description}` : ''}</p></div>}
    {kinds && null}
  </div>;
}
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
