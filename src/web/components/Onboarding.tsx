import { PixelAvatar } from './PixelAvatars';

const TEAM = ['detective', 'engineer', 'crown', 'wizard', 'scholar', 'piggy'] as const;

/** "Meet your tiny team" first-run modal (reference: moa onboarding). */
export function Onboarding({ onPick, onClose }: { onPick: () => void; onClose: () => void }) {
  return <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="Meet your tiny team" onClick={onClose}>
    <div className="tour-card" onClick={(e) => e.stopPropagation()}>
      <div className="tour-banner">
        {TEAM.map((t) => <PixelAvatar key={t} type={t as any} size={28} />)}
        <button className="tour-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="tour-body">
        <h2>Meet your tiny finance team</h2>
        <p className="muted">Six specialist agents work a GPU-billing case. You are the controller: you only make the calls. <em>Demo data is synthetic; agents here are rule-based and labelled as such.</em></p>
        <ol className="tour-steps">
          <li><strong>Pick a billing event</strong><span>Simulate a Lambda bill that charges 12 GPU hours after the instance was shut down.</span></li>
          <li><strong>Watch, then decide</strong><span>The team digs in on the canvas and asks you to approve a $1,200 dispute.</span></li>
          <li><strong>Check the record</strong><span>Every step lands in the Audit trail with who decided what.</span></li>
        </ol>
        <div className="row" style={{ gap: 12 }}>
          <button className="primary" onClick={onPick}>Pick a billing event →</button>
          <button className="linkish" onClick={onClose}>Look around first</button>
        </div>
      </div>
    </div>
  </div>;
}
