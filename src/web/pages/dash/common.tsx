import type { ReactNode } from 'react';

/** Shared, presentation-only pieces for the four dashboards. All numbers come from server read models. */
export const SYS_LABEL: Record<string, string> = { engineering: 'Engineering', incident: 'Incidents', commerce: 'Commerce', knowledge: 'Knowledge', personal: 'Personal', creative: 'Creative', data: 'Data' };
export const STAGE_LABEL: Record<string, string> = { intake: 'Intake', analysis: 'Agent analysis', approval: 'Human approval', execute: 'Execute', verify: 'Verify', complete: 'Complete' };
const PRI: Record<string, string> = { critical: 'b-bad', high: 'b-bad', warning: 'b-warn', medium: 'b-warn', info: 'b-info', low: '' };

export const SysTag = ({ id }: { id?: string | null }) => id ? <span className="badge dash-sys">{SYS_LABEL[id] ?? id}</span> : <span className="badge">—</span>;
export const Pri = ({ p }: { p: string }) => <span className={`badge ${PRI[p] ?? ''}`}>{p}</span>;

export const Kpi = ({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) => (
  <div className={`card dash-kpi ${tone ? `dash-kpi-${tone}` : ''}`}>
    <div className="muted small">{label}</div>
    <div className="stat">{value}</div>
    {sub && <div className="small muted">{sub}</div>}
  </div>
);

export const Header = ({ kicker, title, sub, right }: { kicker: string; title: string; sub: ReactNode; right?: ReactNode }) => (
  <div className="row between dash-head">
    <div><div className="dash-kicker">{kicker}</div><h1>{title}</h1><p className="muted" style={{ margin: 0 }}>{sub}</p></div>
    {right}
  </div>
);

/** Verification-rate trend. Days without any independent check are drawn as gaps, never as 0 %. */
export function Trend({ points }: { points: { day: string; rate: number | null; checks: number }[] }) {
  const W = 560, H = 120, P = 6;
  const xs = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, points.length - 1);
  const ys = (r: number) => H - P - (r / 100) * (H - 2 * P);
  const segs: string[] = []; let cur = '';
  points.forEach((p, i) => { if (p.rate === null) { if (cur) segs.push(cur); cur = ''; } else cur += `${cur ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.rate).toFixed(1)} `; });
  if (cur) segs.push(cur);
  const any = points.some((p) => p.rate !== null);
  return <svg viewBox={`0 0 ${W} ${H}`} className="dash-trend" role="img" aria-label="Share of independent checks that passed, last 14 days">
    {[0, 50, 100].map((g) => <line key={g} x1={P} x2={W - P} y1={ys(g)} y2={ys(g)} className="dash-grid" />)}
    {segs.map((d, i) => <path key={i} d={d} className="dash-line" />)}
    {points.map((p, i) => p.rate !== null && <circle key={p.day} cx={xs(i)} cy={ys(p.rate)} r={3.2} className="dash-dot"><title>{`${p.day}: ${p.rate}% of ${p.checks} check(s) passed`}</title></circle>)}
    {!any && <text x={W / 2} y={H / 2} textAnchor="middle" className="dash-empty-text">No independent checks recorded in the last 14 days</text>}
  </svg>;
}

/** Horizontal share bar (e.g. lifecycle coverage). */
export const Meter = ({ value, max = 100, label }: { value: number; max?: number; label?: string }) => (
  <div className="dash-meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
    <span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
  </div>
);

export const Pipeline = ({ stages }: { stages: { stage: string; count: number }[] }) => (
  <div className="dash-pipe">
    {stages.map((s, i) => <div key={s.stage} className={`dash-pipe-step ${s.count ? 'on' : ''}`}>
      <div className="dash-pipe-n">{s.count}</div><div className="small">{STAGE_LABEL[s.stage] ?? s.stage}</div>
      {i < stages.length - 1 && <span className="dash-pipe-arrow" aria-hidden>→</span>}
    </div>)}
  </div>
);

export const since = (iso?: string | null) => {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso); if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};
