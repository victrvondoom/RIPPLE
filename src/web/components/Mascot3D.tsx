import { useEffect, useRef } from 'react';

/**
 * Glossy 3D mascot built from CSS 3D transforms (stacked extrusion layers + specular highlight; no WebGL dependency).
 * One shared requestAnimationFrame loop per mascot: the body tilts toward the pointer with a time-corrected spring, the eyes
 * look at it, and the whole thing floats. Writes CSS variables directly (no React re-render per frame). The loop sleeps while the
 * mascot is off screen or the tab is hidden, and `prefers-reduced-motion` turns movement off (a static pose is still drawn).
 */
export type Mood = 'idle' | 'ask' | 'refuse' | 'happy' | 'verify';
const LAYERS = 9;

export function Mascot3D({ mood = 'idle', variant = 'robot', size = 260, className = '' }: { mood?: Mood; variant?: 'robot' | 'badge'; size?: number; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current; if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tx = 0, ty = 0, x = 0, y = 0, vx = 0, vy = 0, raf = 0, last = performance.now(), visible = true, blinkAt = performance.now() + 2200, blinkUntil = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      tx = Math.max(-1, Math.min(1, (e.clientX - cx) / (innerWidth * 0.45))); ty = Math.max(-1, Math.min(1, (e.clientY - cy) / (innerHeight * 0.45)));
    };
    const tick = (now: number) => {
      raf = 0; if (!visible || document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      // damped spring toward the pointer target (frame-rate independent)
      const k = 90, c = 13;
      vx += ((tx - x) * k - vx * c) * dt; vy += ((ty - y) * k - vy * c) * dt; x += vx * dt; y += vy * dt;
      const t = now / 1000; const bob = Math.sin(t * 1.6) * 7;
      el.style.setProperty('--ry', `${(x * 22 + Math.sin(t * 0.7) * 2.5).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-y * 16 + Math.cos(t * 0.9) * 1.5).toFixed(2)}deg`);
      el.style.setProperty('--bob', `${bob.toFixed(2)}px`);
      el.style.setProperty('--ex', `${(x * 14).toFixed(2)}px`); el.style.setProperty('--ey', `${(y * 9).toFixed(2)}px`);
      el.style.setProperty('--sh', `${(1 - bob / 90).toFixed(3)}`);
      if (now > blinkAt) { blinkUntil = now + 130; blinkAt = now + 2400 + Math.random() * 3200; }
      el.style.setProperty('--blink', now < blinkUntil ? '0.08' : '1');
      raf = requestAnimationFrame(tick);
    };
    const start = () => { if (!raf && !reduce) { last = performance.now(); raf = requestAnimationFrame(tick); } };
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) start(); }, { threshold: 0.05 });
    io.observe(el); addEventListener('pointermove', onMove, { passive: true }); document.addEventListener('visibilitychange', start);
    if (reduce) { el.style.setProperty('--ry', '-8deg'); el.style.setProperty('--rx', '4deg'); } else start();
    return () => { io.disconnect(); removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', start); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return (
    <div ref={root} className={`m3d m3d-${variant} mood-${mood} ${className}`} style={{ width: size, height: size * 1.15 }} role="img" aria-label={variant === 'badge' ? 'Verified badge' : 'Flipside agent mascot'}>
      <div className="m3d-stage">
        <div className="m3d-body">
          {Array.from({ length: LAYERS }, (_, i) => <i key={i} className="m3d-ext" style={{ transform: `translateZ(${-(i + 1) * 3}px)`, opacity: 1 - i * 0.04 }} />)}
          <div className="m3d-face">
            {variant === 'robot' ? (
              <div className="m3d-screen"><div className="m3d-eyes"><b className="m3d-eye" /><b className="m3d-eye" /></div></div>
            ) : (
              <svg className="m3d-check" viewBox="0 0 100 100" aria-hidden><circle cx="50" cy="50" r="31" fill="none" stroke="#17120a" strokeWidth="7" /><path d="M33 51 l12 12 l23 -26" fill="none" stroke="#17120a" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
            <span className="m3d-gloss" />
          </div>
        </div>
        <div className="m3d-shadow" />
      </div>
    </div>
  );
}
