import { useEffect, useRef, useState } from 'react';
import { Mascot3D, type Mood } from './Mascot3D';
import { Stepper } from './Stepper';

/**
 * Scroll-driven walkthrough on the pre-login page. This is a labelled ILLUSTRATION (no server data exists before sign-in):
 * the real, recomputed version is the signed-in "Flipside Review" page.
 */
const STEPS: { key: string; label: string; mood: Mood; badge?: boolean; title: string; body: string; card: string }[] = [
  { key: 'seal', label: 'Seal', mood: 'idle', title: 'Seal the session before review.', body: 'The author\'s agent session is fingerprinted into the PR as one Merkle root. Nothing leaves the author yet.', card: 'author-agent · seal for PR #142 · 10 steps · root fingerprint attached' },
  { key: 'ask', label: 'Ask', mood: 'ask', title: 'Ask for one step, not the session.', body: 'The reviewer\'s agent reads only the public PR, finds a change the description never explains, and asks the author why.', card: 'reviewer-agent · auth/session.py changed and the description never says why. Q1 sent to the author.' },
  { key: 'refuse', label: 'Refuse', mood: 'refuse', title: 'Asking for everything is refused.', body: 'A whole-session request is refused by policy. The only thing that can be shared is one approved step.', card: 'policy · whole-session request refused' },
  { key: 'approve', label: 'Approve', mood: 'happy', title: 'Only the author can approve.', body: 'The author answers in their own words, then approves a card only they can answer. Managers cannot approve on their behalf.', card: 'author-agent · Disclose step 5 of 10? [1. Approve] [2. Decline]' },
  { key: 'verify', label: 'Verify', mood: 'verify', badge: true, title: 'Prove it is in the sealed session.', body: 'The step is checked against the seal and re-read after delivery. An edited copy fails with PROOF_FAIL.', card: 'verifier · OK step 5 is in the sealed session · edited copy: PROOF_FAIL' },
];

export function FlipsideShowcase() {
  const [on, setOn] = useState(0); const refs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) setOn(Number((e.target as HTMLElement).dataset.i)); }, { rootMargin: '-45% 0px -45% 0px' });
    refs.current.forEach((r) => r && io.observe(r)); return () => io.disconnect();
  }, []);
  const s = STEPS[on];
  return <section className="fs-show" aria-labelledby="fs-h">
    <div className="fs-kicker">Flipside review · cross-team agents</div>
    <h2 id="fs-h">Ask the agent <em>why.</em></h2>
    <div className="fs-show-grid">
      <div className="fs-sticky">
        <Mascot3D mood={s.mood} variant={s.badge ? 'badge' : 'robot'} size={260} />
        <Stepper stages={STEPS.map((x, i) => ({ key: x.key, label: x.label, status: i < on ? 'done' : i === on ? 'current' : 'pending' }))} onPick={(i) => refs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' })} active={on} />
        <div className="term" style={{ width: '100%' }}><div className="dots"><i /><i /><i />#pr-142</div><div style={{ padding: '4px 2px' }}>{s.card}</div></div>
        <span className="fs-illus">Illustration with synthetic data. Sign in and open "Flipside Review" for the real, recomputed run.</span>
      </div>
      <div className="fs-steps">
        {STEPS.map((x, i) => <article key={x.key} data-i={i} ref={(el) => { refs.current[i] = el; }} className={`fs-step${i === on ? ' on' : ''}`}><h3>{x.title}</h3><p className="muted">{x.body}</p></article>)}
      </div>
    </div>
  </section>;
}
