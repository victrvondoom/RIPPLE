import { useEffect, useState } from 'react';
import { Mascot3D } from './Mascot3D';

/**
 * Pre-login front door (session 20): one screen, no scrolling. Three columns: the headline on the left, the 3D switch
 * (it follows the cursor) in the middle, the sign-in / create-account card on the right. The terminal reads the live
 * collaboration mode from /api/health instead of printing a fixed line.
 */
export function Landing({ children }: { children: React.ReactNode }) {
  const [collab, setCollab] = useState<{ mode: string; connected: boolean } | null>(null);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((d) => setCollab(d.collab ?? null)).catch(() => setCollab(null)); }, []);
  useEffect(() => { document.documentElement.classList.add('no-scroll'); return () => document.documentElement.classList.remove('no-scroll'); }, []);
  const sw = collab === null ? 'checking…' : collab.mode === 'switch' ? (collab.connected ? 'connected' : 'configured · not connected') : 'local mode';
  return (
    <div className="poster poster-fit">
      <header className="poster-bar">
        <span className="poster-brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden><circle cx="16" cy="16" r="4" fill="#f6a17c" /><circle cx="16" cy="16" r="9" fill="none" stroke="#f6a17c" strokeWidth="2.5" /><circle cx="16" cy="16" r="14" fill="none" stroke="#9ad3b4" strokeWidth="1.5" strokeDasharray="3 3" /></svg>
          RIPPLE
        </span>
        <span className="poster-bar-right">BUILT FOR <b>FLIP THE SWITCH</b></span>
      </header>
      <main className="poster-main poster-3col">
        <section className="poster-copy">
          <div className="poster-kicker">Multi-agent workflows · reality-checked · online</div>
          <h1 className="poster-title">Every agent<br />says done.<br /><span className="poster-pill">Prove it.</span></h1>
          <p className="poster-sub">One change → every consequence identified → every responsible person coordinated → every approved action <b>independently verified</b>.</p>
          <div className="term poster-term" aria-label="About this server">
            <div className="dots"><i /><i /><i />~/ripple</div>
            <div><span className="prompt">$</span> ripple --status</div>
            <div className="ln"><span className="k">verification</span><span className="v">independent read-back</span></div>
            <div className="ln"><span className="k">approvals</span><span className="v">named person · exact version</span></div>
            <div className={`ln${collab?.connected ? '' : ' warn'}`}><span className="k">switch</span><span className="v">{sw}</span></div>
          </div>
        </section>
        <section className="poster-mascot" aria-hidden>
          <Mascot3D mood="idle" size={240} />
          <p className="poster-mascot-cap">Ask the agent <em>why.</em></p>
        </section>
        <section className="poster-login">{children}</section>
      </main>
      <p className="poster-foot">Deterministic analyzers · dry-run connectors: nothing is emailed, paid or submitted</p>
    </div>
  );
}
