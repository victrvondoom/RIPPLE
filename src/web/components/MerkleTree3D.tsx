import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

/**
 * 3D Merkle seal view. Hashes, path and verdict markers come from the server read model (/api/flipside/:id); this component only
 * lays the tree out and tilts it in space. Leaves = session steps (hash commitments only), the gold path = the proof for the one
 * disclosed step, red = an edited copy that failed (PROOF_FAIL). Pointer movement tilts the whole tree smoothly.
 */
export interface TreeModel { levels: string[][]; disclosedIndex: number | null; shared: boolean; pathIndexes: number[]; forgedIndex: number | null }
const W = 640, H = 300, PAD = 34;

export function MerkleTree3D({ tree, label = 'Sealed session', onPick }: { tree: TreeModel; label?: string; onPick?: (i: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null); const [hover, setHover] = useState<{ l: number; i: number } | null>(null);
  const pos = useMemo(() => {
    const L = tree.levels.length; const n = tree.levels[0].length;
    const xs: number[][] = [tree.levels[0].map((_, i) => PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i * (W - 2 * PAD)) / (n - 1)))];
    for (let l = 1; l < L; l++) xs.push(tree.levels[l].map((_, i) => { const a = xs[l - 1][2 * i], b = xs[l - 1][2 * i + 1] ?? a; return (a + b) / 2; }));
    const y = (l: number) => H - 44 - (l * (H - 90)) / Math.max(L - 1, 1);
    return { xs, y, L };
  }, [tree]);
  useEffect(() => {
    const el = wrap.current; if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
    const onMove = (e: PointerEvent) => { const r = el.getBoundingClientRect(); tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / innerWidth)); ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / innerHeight)); };
    const loop = () => { x += (tx - x) * 0.07; y += (ty - y) * 0.07; el.style.setProperty('--tx', `${(18 - y * 8).toFixed(2)}deg`); el.style.setProperty('--ty', `${(x * 14).toFixed(2)}deg`); raf = requestAnimationFrame(loop); };
    addEventListener('pointermove', onMove, { passive: true }); raf = requestAnimationFrame(loop);
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); };
  }, []);
  const onPath = (l: number, i: number) => tree.pathIndexes[l] === i && tree.pathIndexes.length > 0;
  const nodes: ReactElement[] = []; const edges: ReactElement[] = [];
  for (let l = 0; l < pos.L; l++) for (let i = 0; i < tree.levels[l].length; i++) {
    const cx = pos.xs[l][i], cy = pos.y(l); const hot = onPath(l, i); const leaf = l === 0;
    const forged = leaf && tree.forgedIndex === i; const disclosed = leaf && tree.disclosedIndex === i;
    if (l > 0) for (const ci of [2 * i, 2 * i + 1]) { if (ci >= tree.levels[l - 1].length) continue; const edgeHot = hot && onPath(l - 1, ci); edges.push(<line key={`e${l}-${i}-${ci}`} x1={pos.xs[l - 1][ci]} y1={pos.y(l - 1)} x2={cx} y2={cy} pathLength={1} className={edgeHot ? 'mt-edge hot' : 'mt-edge'} style={edgeHot ? { animationDelay: `${(l - 1) * 0.18}s` } : undefined} />); }
    nodes.push(<g key={`n${l}-${i}`} className={`mt-node${hot ? ' hot' : ''}${forged ? ' forged' : ''}${leaf ? ' leaf' : ''}`} transform={`translate(${cx} ${cy})`} onMouseEnter={() => setHover({ l, i })} onMouseLeave={() => setHover(null)} onClick={() => leaf && onPick?.(i)} style={{ cursor: leaf && onPick ? 'pointer' : 'default' }}>
      {leaf ? <rect x={-11} y={-11} width={22} height={22} rx={6} /> : <circle r={l === pos.L - 1 ? 12 : 7} />}
      {leaf && <text y={26} textAnchor="middle" className="mt-idx">{i}</text>}
      {disclosed && <text y={4} textAnchor="middle" className="mt-mark">{tree.shared ? '✓' : '?'}</text>}
      {forged && <text y={disclosed ? -16 : 4} textAnchor="middle" className="mt-mark bad" style={disclosed ? { fill: '#fb7185' } : undefined}>✕</text>}
    </g>);
  }
  const hv = hover ? tree.levels[hover.l][hover.i] : null;
  return <div className="mt-wrap" ref={wrap}>
    <div className="mt-head"><b>{label}</b><span className="mono">{tree.levels[0].length} steps · root {tree.levels.at(-1)![0].slice(0, 8)}</span></div>
    <div className="mt-stage"><svg viewBox={`0 0 ${W} ${H}`} className="mt-svg" role="img" aria-label="Merkle tree of the sealed session">{edges}{nodes}</svg></div>
    <div className="mt-foot mono">{hv ? `${hover!.l === 0 ? `step ${hover!.i}` : `node L${hover!.l}.${hover!.i}`} · ${hv.slice(0, 24)}…` : 'Hover a node for its hash. Only hashes are public; step text is never in this tree.'}</div>
  </div>;
}
