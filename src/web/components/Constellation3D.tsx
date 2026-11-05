import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 3D constellation of the persisted Cross-Domain Reality Graph (perspective projection on a 2D canvas; no WebGL
 * dependency). Positions are a deterministic presentation layout; every node, edge, colour and status comes from the
 * server read model (/api/crossdomain/campaigns/:id/graph). Drag to orbit, wheel to zoom, click to select.
 */
export interface GNode { id: string; type: string; label: string; ref_id?: string | null; domain?: string | null; data: any }
export interface GEdge { id: string; from_node: string; to_node: string; rel: string; provenance: any; evidence_id?: string | null; causal_id: string }
type P3 = { x: number; y: number; z: number };

const LAYERS: [string, string][] = [['domain', 'Domains'], ['workflow', 'Workflows'], ['resource', 'Resources'], ['invariant', 'Invariants'], ['finding', 'Findings'], ['plan', 'Plans & approvals'], ['operation', 'Operations'], ['evidence', 'Evidence']];
const layerOf = (t: string) => (t === 'policy' ? 'invariant' : t === 'approval' || t === 'passport' ? 'plan' : t === 'effect' || t === 'agent' ? 'operation' : t);
const DOMAIN_HUE: Record<string, number> = { travel: 199, inventory: 160, payments: 45, release: 270, data: 320, finance: 25, scheduling: 95 };

function nodeColor(n: GNode): string {
  const d = n.data ?? {};
  if (n.type === 'workflow') return ['VERIFIED', 'RECOVERED'].includes(d.state) ? '#10b981' : d.state === 'REQUIRES_HUMAN' ? '#f43f5e' : d.state === 'CANCELLED' ? '#64748b' : '#38bdf8';
  if (n.type === 'finding') return d.status === 'resolved' ? '#10b981' : d.status === 'unknown' ? '#f59e0b' : d.blocks ? '#f43f5e' : '#fb923c';
  if (n.type === 'invariant' || n.type === 'policy') return d.result === 'satisfied' ? '#34d399' : d.result === 'violated' ? '#f43f5e' : d.result === 'unknown' ? '#f59e0b' : '#64748b';
  if (n.type === 'domain') return `hsl(${DOMAIN_HUE[n.domain ?? ''] ?? 210} 80% 62%)`;
  if (n.type === 'resource') return '#e2e8f0';
  if (n.type === 'operation') return d.status === 'verified' ? '#10b981' : ['failed', 'rejected', 'unknown'].includes(d.status) ? '#f43f5e' : d.status === 'cancelled' ? '#64748b' : '#93c5fd';
  if (n.type === 'plan') return '#a78bfa'; if (n.type === 'approval') return '#c4b5fd'; if (n.type === 'passport') return '#facc15';
  if (n.type === 'evidence') return '#7dd3fc';
  return '#94a3b8';
}
const SIZE: Record<string, number> = { domain: 15, workflow: 13, resource: 8, invariant: 7, policy: 8, finding: 8, plan: 9, approval: 6, passport: 9, operation: 5, evidence: 3.5, effect: 3.5, agent: 4 };
const EDGE_STYLE: Record<string, [string, number]> = { conflicts_with: ['#f43f5e', 0.9], shares_constraint_with: ['#f59e0b', 0.75], depends_on: ['#10b981', 0.85], invalidates: ['#fb7185', 0.8], governed_by: ['#64748b', 0.35], compensates_for: ['#a78bfa', 0.7], resolves: ['#a78bfa', 0.6], verified_by: ['#34d399', 0.5] };

/** Deterministic 3D layout: domain ring, workflows above their domain, shared resources in the core, invariants in an upper halo, findings in a lower halo. */
function layout(nodes: GNode[], edges: GEdge[]): Map<string, P3> {
  const pos = new Map<string, P3>(); const hash = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; };
  const doms = nodes.filter((n) => n.type === 'domain'); const R = 300;
  doms.forEach((d, i) => { const a = (i / Math.max(doms.length, 1)) * Math.PI * 2; pos.set(d.id, { x: Math.cos(a) * R, y: -10, z: Math.sin(a) * R }); });
  const wfs = nodes.filter((n) => n.type === 'workflow');
  const byDom = new Map<string, GNode[]>(); for (const w of wfs) { const k = w.domain ?? ''; if (!byDom.has(k)) byDom.set(k, []); byDom.get(k)!.push(w); }
  for (const [dom, list] of byDom) { const dp = pos.get(`dom:${dom}`) ?? { x: 0, y: 0, z: 0 }; list.forEach((w, i) => { const a = Math.atan2(dp.z, dp.x) + (i - (list.length - 1) / 2) * 0.42; pos.set(w.id, { x: Math.cos(a) * R * 0.78, y: 70 + i * 18, z: Math.sin(a) * R * 0.78 }); }); }
  const nbrs = (id: string) => edges.filter((e) => e.from_node === id || e.to_node === id).map((e) => (e.from_node === id ? e.to_node : e.from_node));
  const avg = (ids: string[], fb: P3): P3 => { const ps = ids.map((x) => pos.get(x)).filter(Boolean) as P3[]; if (!ps.length) return fb; return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length, z: ps.reduce((s, p) => s + p.z, 0) / ps.length }; };
  for (const n of nodes.filter((x) => x.type === 'operation')) { const wf = `wf:${n.id.split(':')[1]}`; const w = pos.get(wf) ?? { x: 0, y: 0, z: 0 }; const a = hash(n.id) * Math.PI * 2; pos.set(n.id, { x: w.x + Math.cos(a) * 46, y: w.y + 40 + hash(n.id + 'y') * 30, z: w.z + Math.sin(a) * 46 }); }
  // Each layer is an orbital ring; nodes are ordered by the angle of what they connect to, so related nodes sit together.
  const ring = (list: GNode[], centre: (n: GNode) => P3, radius: number, y: (n: GNode) => number) => {
    const ang = (n: GNode) => { const c = centre(n); return Math.hypot(c.x, c.z) < 1 ? hash(n.id) * Math.PI * 2 : Math.atan2(c.z, c.x); };
    const sorted = [...list].sort((a, b) => ang(a) - ang(b) || a.id.localeCompare(b.id));
    sorted.forEach((n, i) => { const a = (i / Math.max(sorted.length, 1)) * Math.PI * 2 + 0.25; const r = radius * (0.9 + hash(n.id + 'rad') * 0.2); pos.set(n.id, { x: Math.cos(a) * r, y: y(n), z: Math.sin(a) * r }); });
  };
  const touchWfs = (id: string) => [...new Set(nbrs(id).filter((x) => x.startsWith('op:')).map((x) => `wf:${x.split(':')[1]}`))];
  const res = nodes.filter((x) => x.type === 'resource');
  ring(res.filter((n) => touchWfs(n.id).length > 1), (n) => avg(touchWfs(n.id), { x: 0, y: 0, z: 0 }), 95, (n) => -40 - hash(n.id + 'r') * 30); // shared core
  ring(res.filter((n) => touchWfs(n.id).length <= 1), (n) => avg(touchWfs(n.id), { x: 0, y: 0, z: 0 }), 200, (n) => -70 - hash(n.id + 'r') * 30);
  ring(nodes.filter((x) => x.type === 'invariant' || x.type === 'policy'), (n) => avg(nbrs(n.id).filter((x) => x.startsWith('res:') || x.startsWith('wf:')), { x: 0, y: 0, z: 0 }), 360, (n) => 170 + hash(n.id + 'i') * 50);
  ring(nodes.filter((x) => x.type === 'finding'), (n) => avg(nbrs(n.id).filter((x) => x.startsWith('wf:')), { x: 0, y: 0, z: 0 }), 260, (n) => -200 - hash(n.id + 'f') * 40);
  for (const n of nodes.filter((x) => !pos.has(x.id))) { const c = avg(nbrs(n.id), { x: 0, y: 0, z: 0 }); const a = hash(n.id) * Math.PI * 2; pos.set(n.id, { x: c.x + Math.cos(a) * 40, y: c.y + (n.type === 'plan' || n.type === 'passport' ? -120 : -30) + hash(n.id + 'e') * 40, z: c.z + Math.sin(a) * 40 }); }
  return pos;
}

export function Constellation3D({ nodes, edges, selected, onSelect, height = 520 }: { nodes: GNode[]; edges: GEdge[]; selected?: string | null; onSelect: (n: GNode | null) => void; height?: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null); const wrap = useRef<HTMLDivElement | null>(null);
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [layers, setLayers] = useState<Record<string, boolean>>({ domain: true, workflow: true, resource: true, invariant: true, finding: true, plan: true, operation: false, evidence: false });
  const [spin, setSpin] = useState(!reduce); const [hover, setHover] = useState<GNode | null>(null);
  const cam = useRef({ yaw: 0.6, pitch: 0.38, dist: 980, dragging: false, lx: 0, ly: 0, moved: 0 });
  const shown = useMemo(() => nodes.filter((n) => layers[layerOf(n.type)]), [nodes, layers]);
  const shownIds = useMemo(() => new Set(shown.map((n) => n.id)), [shown]);
  const shownEdges = useMemo(() => edges.filter((e) => shownIds.has(e.from_node) && shownIds.has(e.to_node) && e.from_node !== e.to_node), [edges, shownIds]);
  const pos = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const proj = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  const sel = useRef(selected); sel.current = selected;
  const hov = useRef<string | null>(null); hov.current = hover?.id ?? null;
  const neighbourhood = useMemo(() => { const s = new Set<string>(); const focus = selected ?? hover?.id; if (!focus) return s; s.add(focus); for (const e of edges) { if (e.from_node === focus) s.add(e.to_node); if (e.to_node === focus) s.add(e.from_node); } return s; }, [selected, hover, edges]);

  // The render loop reads everything through refs, so a data poll never tears the canvas down (no blank frames).
  const live = useRef({ shown, shownEdges, pos, neighbourhood, spin, reduce });
  live.current = { shown, shownEdges, pos, neighbourhood, spin, reduce };
  useEffect(() => {
    const cv = canvas.current; if (!cv) return; const ctx = cv.getContext('2d'); if (!ctx) return; let raf = 0; let t0 = performance.now();
    const dprNow = () => Math.min(devicePixelRatio || 1, 2);
    const fit = () => { const w = wrap.current?.clientWidth ?? 800; const dpr = dprNow(); if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(height * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(height * dpr); cv.style.width = `${w}px`; cv.style.height = `${height}px`; } ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    fit(); const ro = new ResizeObserver(fit); if (wrap.current) ro.observe(wrap.current);
    const draw = (now: number) => {
      const { shown, shownEdges, pos, neighbourhood, spin, reduce } = live.current;
      const dt = Math.min(now - t0, 50); t0 = now; const c = cam.current;
      if (spin && !c.dragging) c.yaw += dt * 0.00012;
      const W = cv.width / dprNow(); const H = height;
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch); const f = 760;
      const P = (p: P3) => { const x1 = p.x * cy - p.z * sy; const z1 = p.x * sy + p.z * cy; const y2 = p.y * cp - z1 * sp; const z2 = p.y * sp + z1 * cp; const zc = z2 + c.dist; const s = f / Math.max(zc, 60); return { x: W / 2 + x1 * s, y: H / 2 - y2 * s, s, z: zc }; };
      const bg = ctx.createRadialGradient(W / 2, H * 0.45, 40, W / 2, H / 2, Math.max(W, H) * 0.75); bg.addColorStop(0, '#111c31'); bg.addColorStop(1, '#070b13'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i++) for (const axis of [0, 1]) { const a = P(axis ? { x: i * 80, y: -330, z: -480 } : { x: -480, y: -330, z: i * 80 }); const b = P(axis ? { x: i * 80, y: -330, z: 480 } : { x: 480, y: -330, z: i * 80 }); ctx.strokeStyle = 'rgba(56,189,248,0.07)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      ctx.beginPath(); for (let k = 0; k <= 72; k++) { const a = (k / 72) * Math.PI * 2; const q = P({ x: Math.cos(a) * 300, y: -10, z: Math.sin(a) * 300 }); if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); } ctx.strokeStyle = 'rgba(16,185,129,0.18)'; ctx.setLineDash([4, 6]); ctx.stroke(); ctx.setLineDash([]);
      const focusSet = neighbourhood; const hasFocus = focusSet.size > 0;
      const es = shownEdges.map((e) => { const a = P(pos.get(e.from_node)!); const b = P(pos.get(e.to_node)!); return { e, a, b, z: (a.z + b.z) / 2 }; }).sort((x, y) => y.z - x.z);
      for (const { e, a, b, z } of es) {
        const [col, al] = EDGE_STYLE[e.rel] ?? ['#94a3b8', 0.22]; const fog = Math.max(0.15, Math.min(1, 1.6 - z / 1400));
        const inFocus = !hasFocus || (focusSet.has(e.from_node) && focusSet.has(e.to_node));
        ctx.globalAlpha = al * fog * (inFocus ? 1 : 0.12); ctx.strokeStyle = col; ctx.lineWidth = e.rel === 'conflicts_with' ? 1.8 : 1;
        if (e.rel === 'conflicts_with' || e.rel === 'invalidates') { ctx.setLineDash([6, 5]); ctx.lineDashOffset = reduce ? 0 : -(now / 60) % 22; }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 14 * Math.min(a.s, b.s); ctx.quadraticCurveTo(mx, my, b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      const ns = shown.map((n) => ({ n, p: P(pos.get(n.id)!) })).sort((x, y) => y.p.z - x.p.z);
      const out: { id: string; x: number; y: number; r: number }[] = [];
      for (const { n, p } of ns) {
        const r = Math.max(2, (SIZE[n.type] ?? 5) * p.s * 1.15); const col = nodeColor(n); const fog = Math.max(0.25, Math.min(1, 1.7 - p.z / 1400));
        const dim = hasFocus && !focusSet.has(n.id) ? 0.18 : 1; ctx.globalAlpha = fog * dim;
        const isSel = sel.current === n.id; const isHov = hov.current === n.id;
        if (n.type === 'finding' && n.data?.blocks && n.data?.status !== 'resolved' && !reduce) { const pulse = 1 + 0.35 * Math.sin(now / 280 + r); ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.9 * pulse, 0, Math.PI * 2); ctx.fillStyle = 'rgba(244,63,94,0.14)'; ctx.fill(); }
        const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.15, p.x, p.y, r); g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, col); g.addColorStop(1, shade(col));
        ctx.beginPath(); if (n.type === 'invariant' || n.type === 'policy') { ctx.moveTo(p.x, p.y - r * 1.15); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r * 1.15); ctx.lineTo(p.x - r, p.y); ctx.closePath(); } else if (n.type === 'resource') { ctx.rect(p.x - r * 0.8, p.y - r * 0.8, r * 1.6, r * 1.6); } else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = g; ctx.shadowColor = col; ctx.shadowBlur = isSel || isHov ? 22 : n.type === 'workflow' || n.type === 'domain' ? 12 : 4; ctx.fill(); ctx.shadowBlur = 0;
        if (isSel || isHov) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        if (['domain', 'workflow'].includes(n.type) || isSel || isHov || (hasFocus && focusSet.has(n.id) && n.type !== 'evidence')) { ctx.font = `${n.type === 'domain' ? 600 : 500} ${Math.max(10, Math.min(13, 11 * p.s + 2))}px Inter, system-ui, sans-serif`; ctx.fillStyle = n.type === 'domain' ? col : '#e7edf5'; ctx.textAlign = 'center'; ctx.fillText(trim(n.label, 34), p.x, p.y - r - 6); }
        out.push({ id: n.id, x: p.x, y: p.y, r: Math.max(r, 6) });
      }
      ctx.globalAlpha = 1; proj.current = out;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [height]);

  const pick = (ev: React.MouseEvent) => { const r = canvas.current!.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top; let best: { id: string; d: number } | null = null; for (const p of proj.current) { const d = Math.hypot(p.x - x, p.y - y); if (d <= p.r + 4 && (!best || d < best.d)) best = { id: p.id, d }; } return best ? nodes.find((n) => n.id === best!.id) ?? null : null; };
  return <div className="cd-const" ref={wrap}>
    <canvas ref={canvas} role="img" aria-label={`3D constellation: ${shown.length} nodes and ${shownEdges.length} edges from the persisted cross-domain graph`} tabIndex={0}
      onMouseDown={(e) => { const c = cam.current; c.dragging = true; c.lx = e.clientX; c.ly = e.clientY; c.moved = 0; }}
      onMouseMove={(e) => { const c = cam.current; if (c.dragging) { c.yaw += (e.clientX - c.lx) * 0.006; c.pitch = Math.max(-1.2, Math.min(1.2, c.pitch + (e.clientY - c.ly) * 0.005)); c.moved += Math.abs(e.clientX - c.lx) + Math.abs(e.clientY - c.ly); c.lx = e.clientX; c.ly = e.clientY; } else setHover(pick(e)); }}
      onMouseUp={(e) => { const c = cam.current; c.dragging = false; if (c.moved < 5) onSelect(pick(e)); }}
      onMouseLeave={() => { cam.current.dragging = false; setHover(null); }}
      onWheel={(e) => { cam.current.dist = Math.max(420, Math.min(2200, cam.current.dist + e.deltaY * 0.8)); }}
      onKeyDown={(e) => { const c = cam.current; if (e.key === 'ArrowLeft') c.yaw -= 0.15; if (e.key === 'ArrowRight') c.yaw += 0.15; if (e.key === 'ArrowUp') c.pitch = Math.min(1.2, c.pitch + 0.1); if (e.key === 'ArrowDown') c.pitch = Math.max(-1.2, c.pitch - 0.1); if (e.key === 'Escape') onSelect(null); }} />
    <div className="cd-const-hud">
      <div className="cd-layers">{LAYERS.map(([k, l]) => <label key={k} className={layers[k] ? 'on' : ''}><input type="checkbox" checked={!!layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{l}</label>)}</div>
      <div className="cd-const-tools"><button className="sm" onClick={() => setSpin(!spin)}>{spin ? 'Pause orbit' : 'Auto-orbit'}</button><button className="sm" onClick={() => { cam.current.yaw = 0.6; cam.current.pitch = 0.38; cam.current.dist = 980; }}>Reset view</button></div>
      {hover && <div className="cd-tip"><b>{hover.type}</b> · {hover.label}{hover.data?.state ? ` · ${hover.data.state}` : ''}{hover.data?.result ? ` · ${hover.data.result}` : ''}{hover.data?.status ? ` · ${hover.data.status}` : ''}</div>}
      <div className="cd-legend"><span><i style={{ background: '#f43f5e' }} />conflicts_with</span><span><i style={{ background: '#f59e0b' }} />shares_constraint_with</span><span><i style={{ background: '#10b981' }} />depends_on</span><span><i style={{ background: '#fb7185' }} />invalidates</span><span className="muted">◆ invariant · ■ resource · ● workflow / finding</span></div>
    </div>
  </div>;
}
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
function shade(c: string) { if (c.startsWith('hsl')) return c.replace(/(\d+)%\)$/, '28%)'); const n = parseInt(c.slice(1), 16); const r = Math.round(((n >> 16) & 255) * 0.35), g = Math.round(((n >> 8) & 255) * 0.35), b = Math.round((n & 255) * 0.35); return `rgb(${r},${g},${b})`; }
