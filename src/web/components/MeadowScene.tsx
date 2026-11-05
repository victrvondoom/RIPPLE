import { useEffect, useRef, useState } from 'react';
import { PixelAvatar } from './PixelAvatars';

/*
 * Front-door meadow scene, inherited from the moa project (Cal Hacks "mixture of
 * accountant agents", pixel-meadow landing). Ported to RIPPLE's plain-CSS stack:
 * a soft pixel meadow on a 320x180 grid (scaled up with crisp edges, anchored to
 * the bottom), with a wandering, grabbable crew rendered with RIPPLE avatars.
 * Decorative only — nothing here represents engine state.
 */

const W = 320;
const H = 180;
/** Where the meadow meets the hills, in grid rows. */
const FIELD_TOP = 108;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A stepped silhouette: column heights from a few sine waves, in blocks of `step` pixels. */
function ridge(base: number, amp: number, seed: number, step = 4) {
  const cols: { x: number; y: number }[] = [];
  for (let x = 0; x < W; x += step) {
    const t = x / W;
    const y = base - amp * (0.55 * Math.sin(t * 6.1 + seed) + 0.3 * Math.sin(t * 13.7 + seed * 2) + 0.15 * Math.sin(t * 29 + seed * 3));
    cols.push({ x, y: Math.round(y) });
  }
  return cols;
}

/** Rows of a two-colour checkerboard: the dithered band between two tones. */
function Dither({ y, h, a, b }: { y: number; h: number; a: string; b: string }) {
  const id = 'd' + y + a.slice(1) + b.slice(1);
  return (
    <>
      <defs>
        <pattern id={id} width={2} height={2} patternUnits="userSpaceOnUse">
          <rect width={2} height={2} fill={a} />
          <rect width={1} height={1} fill={b} />
          <rect x={1} y={1} width={1} height={1} fill={b} />
        </pattern>
      </defs>
      <rect x={0} y={y} width={W} height={h} fill={`url(#${id})`} />
    </>
  );
}

/** A soft cumulus: stacked runs, widest at the base, with a shaded underside. */
function Cloud({ x, y, w, className }: { x: number; y: number; w: number; className?: string }) {
  const rows = [0.35, 0.6, 0.8, 0.92, 1, 1, 1];
  return (
    <g className={className}>
      {rows.map((f, i) => {
        const rw = Math.round(w * f);
        return <rect key={i} x={x + Math.round((w - rw) / 2) + (i < 3 ? Math.round(w * 0.12) : 0)} y={y + i * 2} width={rw} height={2} fill={i === rows.length - 1 ? '#d6effa' : '#f4fbff'} />;
      })}
    </g>
  );
}

/** A round pixel tree clump. */
function Tree({ x, y, r }: { x: number; y: number; r: number }) {
  const rows = [];
  for (let dy = -r; dy <= 0; dy++) {
    const half = Math.round(Math.sqrt(r * r - dy * dy));
    rows.push(<rect key={dy} x={x - half} y={y + dy} width={half * 2} height={1} fill={dy < -r / 2 ? '#4f9f3c' : '#3f8b31'} />);
  }
  return <g>{rows}</g>;
}

/** A wheat stalk with its leaves, swaying from the base. */
function Wheat({ x, h, delay = 0 }: { x: number; h: number; delay?: number }) {
  const base = H;
  const top = base - h;
  const grains = [];
  for (let i = 0; i < 6; i++) {
    const gy = top + i * 3;
    grains.push(<rect key={'l' + i} x={x - 2} y={gy + 1} width={2} height={2} fill={i % 2 ? '#e5a83f' : '#f0c55c'} />);
    grains.push(<rect key={'r' + i} x={x + 1} y={gy} width={2} height={2} fill={i % 2 ? '#f0c55c' : '#e5a83f'} />);
  }
  return (
    <g className="pxl-wheat" style={{ animationDelay: delay + 's' }}>
      <rect x={x} y={top + 2} width={1} height={h - 2} fill="#c99a45" />
      {grains}
      <rect x={x} y={top - 1} width={1} height={2} fill="#f0c55c" />
    </g>
  );
}

const FAR = ridge(92, 9, 1.3);
const MID = ridge(100, 6, 4.1);

const R = rng(11);
const SPECKS = Array.from({ length: 900 }, () => {
  const y = FIELD_TOP + 2 + Math.floor(R() * (H - FIELD_TOP - 2));
  return { x: Math.floor(R() * W), y, c: R() < 0.5 ? '#b1e163' : '#6cb53a', tall: y > 150 && R() < 0.6 };
});
const BLOOMS = Array.from({ length: 46 }, () => ({
  x: Math.floor(R() * W),
  y: FIELD_TOP + 6 + Math.floor(R() * (H - FIELD_TOP - 10)),
  c: ['#fffaf0', '#ffd95c', '#ff9fbd', '#c3aeff'][Math.floor(R() * 4)],
}));
const TREES = [
  { x: 20, y: 110, r: 9 },
  { x: 33, y: 110, r: 6 },
  { x: 236, y: 109, r: 7 },
  { x: 288, y: 110, r: 10 },
  { x: 302, y: 110, r: 7 },
];

export function MeadowScene() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges" className="meadow-svg" aria-hidden>
      {/* sky: bands from deep to pale, dithered where they meet */}
      <rect x={0} y={0} width={W} height={H} fill="#45b4ee" />
      <Dither y={22} h={6} a="#45b4ee" b="#5fc1f1" />
      <rect x={0} y={28} width={W} height={34} fill="#5fc1f1" />
      <Dither y={62} h={6} a="#5fc1f1" b="#7fcdf3" />
      <rect x={0} y={68} width={W} height={20} fill="#7fcdf3" />
      <Dither y={88} h={4} a="#7fcdf3" b="#a3dbf6" />
      <rect x={0} y={92} width={W} height={20} fill="#a3dbf6" />

      <Cloud x={-14} y={64} w={62} className="pxl-cloud-a" />
      <Cloud x={232} y={58} w={84} className="pxl-cloud-b" />
      <Cloud x={168} y={4} w={28} className="pxl-cloud-a" />
      <Cloud x={34} y={16} w={36} className="pxl-cloud-b" />

      {/* birds crossing the sky */}
      <g className="pxl-birds">
        <g className="pxl-flap">
          <rect x={60} y={40} width={1} height={1} fill="#3d5a6c" />
          <rect x={61} y={41} width={1} height={1} fill="#3d5a6c" />
          <rect x={62} y={40} width={1} height={1} fill="#3d5a6c" />
        </g>
        <g className="pxl-flap" style={{ animationDelay: '0.2s' }}>
          <rect x={68} y={44} width={1} height={1} fill="#3d5a6c" />
          <rect x={69} y={45} width={1} height={1} fill="#3d5a6c" />
          <rect x={70} y={44} width={1} height={1} fill="#3d5a6c" />
        </g>
      </g>

      {/* far mountains, then nearer hills */}
      {FAR.map((c) => (
        <rect key={'f' + c.x} x={c.x} y={c.y} width={4} height={H - c.y} fill="#76c0aa" />
      ))}
      {MID.map((c) => (
        <rect key={'m' + c.x} x={c.x} y={c.y} width={4} height={H - c.y} fill="#5fb377" />
      ))}
      <rect x={0} y={104} width={W} height={6} fill="#78c24c" />
      {TREES.map((t) => (
        <Tree key={t.x} {...t} />
      ))}

      {/* the meadow, light at the back and richer toward you */}
      <rect x={0} y={FIELD_TOP} width={W} height={H - FIELD_TOP} fill="#9bd551" />
      <Dither y={FIELD_TOP + 14} h={4} a="#9bd551" b="#8acb43" />
      <rect x={0} y={FIELD_TOP + 18} width={W} height={H} fill="#8acb43" />
      <Dither y={FIELD_TOP + 38} h={4} a="#8acb43" b="#7bbf38" />
      <rect x={0} y={FIELD_TOP + 42} width={W} height={H} fill="#7bbf38" />
      {SPECKS.map((s, i) => (
        <rect key={i} x={s.x} y={s.tall ? s.y - 1 : s.y} width={1} height={s.tall ? 2 : 1} fill={s.c} />
      ))}
      {BLOOMS.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={1} height={1} fill={b.c} />
      ))}
      {/* nearer flowers get petals */}
      {BLOOMS.filter((b) => b.y > 146).map((b, i) => (
        <g key={'n' + i}>
          <rect x={b.x - 1} y={b.y} width={3} height={1} fill={b.c} />
          <rect x={b.x} y={b.y - 1} width={1} height={3} fill={b.c} />
          <rect x={b.x} y={b.y} width={1} height={1} fill="#f2b33d" />
        </g>
      ))}

      {/* foreground: wheat at both edges */}
      <Wheat x={14} h={34} delay={0} />
      <Wheat x={24} h={26} delay={0.6} />
      <Wheat x={292} h={30} delay={0.3} />
      <Wheat x={306} h={22} delay={0.9} />
    </svg>
  );
}

/** The wandering crew, rendered with RIPPLE's pixel avatars. Decorative greetings only. */
const CREW = [
  { avatar: 'crown', big: true, lines: ['your call!', 'one change, right?', 'nice meadow today'] },
  { avatar: 'detective', big: false, lines: ['tracing consequences…', "who's affected?", 'blast radius mapped!'] },
  { avatar: 'chef', big: false, lines: ['menus updated!', '86 the salmon', 'kitchen coordinated'] },
  { avatar: 'wizard', big: false, lines: ['draft ready for review', 'no prices promised!', 'wording checked ✓'] },
  { avatar: 'piggy', big: false, lines: ['line 3 looks odd…', 'hours vs worklog?', 'evidence, please!'] },
  { avatar: 'scholar', big: false, lines: ['policy check first', 'two-person sign-off!', "that's in the rules"] },
  { avatar: 'engineer', big: false, lines: ['dependencies first', 'what could slip?', 'plan v2 incoming'] },
] as const;

type Walker = {
  x: number;
  y: number;
  /** Seconds for the current move; 0 while held. */
  dur: number;
  ease: string;
  left: boolean;
  moving: boolean;
  held: boolean;
  /** Bumped on each landing, so the squash replays. */
  landed: number;
  /** Degrees it swings away from the direction you drag it. */
  lean: number;
};

/** Where people may stand, as % of the scene: inside the meadow, clear of the edges. */
const ZONE = { x0: 8, x1: 92, y0: 72, y1: 92 };

function start(i: number): Walker {
  const x = ZONE.x0 + ((i + 0.5) / CREW.length) * (ZONE.x1 - ZONE.x0);
  const y = ZONE.y0 + ((i * 37) % 100) / 100 * (ZONE.y1 - ZONE.y0);
  return { x, y, dur: 0, ease: 'linear', left: false, moving: false, held: false, landed: 0, lean: 0 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The team, wandering: each walks to a random spot, stops a while, and picks
 * another. Grab one and it squirms in your hand; let go and it drops back
 * into the meadow and carries on.
 */
export function Roamers() {
  const [walkers, setWalkers] = useState<Walker[]>(() => CREW.map((_, i) => start(i)));
  // The live positions; state is a copy for rendering.
  const cur = useRef<Walker[]>(walkers);
  const timers = useRef<number[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; dx: number; dy: number; lastX: number; t: number } | null>(null);
  const settle = useRef(0);
  const still = useRef(false);
  const stepRef = useRef<(i: number) => void>(() => {});
  const [say, setSay] = useState<{ i: number; text: string; n: number } | null>(null);

  // Every so often one of them says something short.
  useEffect(() => {
    let t = 0;
    let n = 0;
    const next = (wait: number) => {
      t = window.setTimeout(() => {
        const free = CREW.map((_, i) => i).filter((i) => !cur.current[i].held);
        if (free.length) {
          const i = free[Math.floor(Math.random() * free.length)];
          const lines = CREW[i].lines;
          setSay({ i, text: lines[Math.floor(Math.random() * lines.length)], n: ++n });
          t = window.setTimeout(() => {
            setSay(null);
            next(2500 + Math.random() * 4000);
          }, 2800);
        } else next(1500);
      }, wait);
    };
    next(1800);
    return () => window.clearTimeout(t);
  }, []);

  const update = (i: number, patch: (w: Walker) => Walker) => {
    cur.current = cur.current.map((w, j) => (j === i ? patch(w) : w));
    setWalkers(cur.current);
  };

  useEffect(() => {
    still.current = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    const list = timers.current;
    const step = (i: number) => {
      const w = cur.current[i];
      if (w.held) return;
      if (w.moving) {
        update(i, (v) => ({ ...v, moving: false }));
        list[i] = window.setTimeout(() => step(i), 1200 + Math.random() * 3200);
        return;
      }
      const x = ZONE.x0 + Math.random() * (ZONE.x1 - ZONE.x0);
      const y = ZONE.y0 + Math.random() * (ZONE.y1 - ZONE.y0);
      const dur = Math.max(1.6, Math.hypot(x - w.x, (y - w.y) * 2) / 4.5);
      update(i, (v) => ({ ...v, x, y, dur, ease: 'linear', left: x < v.x, moving: true }));
      list[i] = window.setTimeout(() => step(i), dur * 1000);
    };
    stepRef.current = step;
    if (!still.current) CREW.forEach((_, i) => (list[i] = window.setTimeout(() => step(i), 400 + i * 450)));
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  /** Pointer position as % of the scene. */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };

  const grab = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    window.clearTimeout(timers.current[i]);
    const p = at(e);
    // Hold it where you grabbed it, but the left/top transition may still be running: read where it is now.
    const r = box.current!.getBoundingClientRect();
    const el = e.currentTarget.getBoundingClientRect();
    const feetX = ((el.left + el.width / 2 - r.left) / r.width) * 100;
    const feetY = ((el.bottom - r.top) / r.height) * 100;
    drag.current = { i, dx: feetX - p.x, dy: feetY - p.y, lastX: e.clientX, t: e.timeStamp };
    update(i, (w) => ({ ...w, x: feetX, y: feetY, dur: 0, moving: false, held: true }));
  };

  const move = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.i !== i) return;
    const p = at(e);
    const x = clamp(p.x + d.dx, 2, 98);
    // Swing like a pendulum: drag right and the body trails left.
    const speed = (e.clientX - d.lastX) / Math.max(8, e.timeStamp - d.t);
    d.lastX = e.clientX;
    d.t = e.timeStamp;
    const lean = clamp(-speed * 28, -40, 40);
    update(i, (w) => ({ ...w, x, y: clamp(p.y + d.dy, 12, 99), lean, left: x < w.x ? true : x > w.x ? false : w.left }));
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => update(i, (w) => ({ ...w, lean: 0 })), 90);
  };

  const drop = (i: number) => () => {
    if (drag.current?.i !== i) return;
    drag.current = null;
    update(i, (w) => {
      const y = clamp(w.y, ZONE.y0, ZONE.y1);
      // Falls under gravity when let go above the meadow.
      const fall = y > w.y + 1 ? Math.min(0.9, 0.25 + Math.sqrt((y - w.y) / 100) * 0.7) : 0.15;
      return { ...w, lean: 0, x: clamp(w.x, ZONE.x0, ZONE.x1), y, dur: fall, ease: 'cubic-bezier(0.55, 0, 1, 0.45)', held: false, landed: w.landed + 1 };
    });
    if (!still.current) timers.current[i] = window.setTimeout(() => stepRef.current(i), 1600 + Math.random() * 1500);
  };

  return (
    <div ref={box} className="meadow-roamers" aria-hidden>
      {walkers.map((w, i) => {
        const id = CREW[i];
        // Further back is smaller.
        const depth = w.held ? 1.25 : clamp((w.y - ZONE.y0) / (ZONE.y1 - ZONE.y0), 0, 1);
        const size = (id.big ? 56 : 44) * (0.78 + depth * 0.32);
        return (
          <div
            key={i}
            className={`meadow-walker ${w.held ? 'cursor-grabbing' : 'cursor-grab'}`}
            onPointerDown={grab(i)}
            onPointerMove={move(i)}
            onPointerUp={drop(i)}
            onPointerCancel={drop(i)}
            style={{
              left: w.x + '%',
              top: w.y + '%',
              zIndex: w.held ? 400 : Math.round(w.y),
              transform: 'translate(-50%, -100%)',
              transition: w.dur ? `left ${w.dur}s ${w.ease}, top ${w.dur}s ${w.ease}` : 'none',
            }}
          >
            {say?.i === i && !w.held && (
              <div key={say.n} className="meadow-say-wrap">
                <div className="px-say meadow-say">{say.text}</div>
              </div>
            )}
            <div className="px-lean" style={{ transform: 'rotate(' + w.lean + 'deg)' }}>
              <div
                key={w.landed}
                className={w.held ? 'px-held' : w.landed ? 'px-land' : undefined}
                style={{ '--px-fall': w.dur + 's', animationDelay: w.held ? -(i * 0.13) + 's' : undefined } as React.CSSProperties}
              >
                <div className={w.moving ? 'px-run' : undefined} style={{ transform: w.left ? 'scaleX(-1)' : undefined }}>
                  <div className="px-kick">
                    <PixelAvatar type={id.avatar} size={Math.round(size)} />
                  </div>
                </div>
              </div>
            </div>
            {/* a soft shadow under the feet, left on the ground while held */}
            <div
              className="meadow-shadow"
              style={{ width: size * 0.6, opacity: w.held ? 0 : 1 }}
            />
          </div>
        );
      })}
    </div>
  );
}
