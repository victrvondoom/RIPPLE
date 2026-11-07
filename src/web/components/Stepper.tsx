export interface StageView { key: string; label: string; status: 'done' | 'current' | 'pending'; detail?: string }
/** Segmented progress bar like the Flipside film's Seal · Ask · Refuse · Approve · Verify rail. Pure rendering. */
export function Stepper({ stages, onPick, active }: { stages: StageView[]; onPick?: (i: number) => void; active?: number }) {
  return <ol className="fs-stepper" aria-label="Review progress">
    {stages.map((s, i) => <li key={s.key} className={`fs-seg ${s.status}${active === i ? ' active' : ''}`} title={s.detail}>
      <button type="button" disabled={!onPick} onClick={() => onPick?.(i)} aria-current={s.status === 'current' ? 'step' : undefined}><span className="fs-bar"><i /></span><span className="fs-lbl">{s.label}</span></button>
    </li>)}
  </ol>;
}
