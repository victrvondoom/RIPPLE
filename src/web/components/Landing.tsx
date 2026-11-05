/**
 * Pre-login front door in the "Flip the Switch" poster style (peach canvas, heavy black type, dark terminal card).
 * The child is the real login form, kept intact so flows and e2e selectors are unchanged.
 * The terminal lines are static facts about this build (not live status). The earlier pixel-meadow scene
 * (inherited from moa) is still available in ./MeadowScene.tsx; it is no longer mounted here.
 */
export function Landing({ children }: { children: React.ReactNode }) {
  return (
    <div className="poster">
      <header className="poster-bar">
        <span className="poster-brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden><circle cx="16" cy="16" r="4" fill="#f6a17c" /><circle cx="16" cy="16" r="9" fill="none" stroke="#f6a17c" strokeWidth="2.5" /><circle cx="16" cy="16" r="14" fill="none" stroke="#9ad3b4" strokeWidth="1.5" strokeDasharray="3 3" /></svg>
          RIPPLE
        </span>
        <span className="poster-bar-right">BUILT FOR <b>FLIP THE SWITCH</b></span>
      </header>
      <main className="poster-main">
        <section className="poster-copy">
          <div className="poster-kicker">Multi-agent workflows · reality-checked · online</div>
          <h1 className="poster-title">Every agent<br />says done.<br /><span className="poster-pill">Prove it.</span></h1>
          <p className="poster-sub">One change → every consequence identified → every responsible person coordinated → every approved action <b>independently verified</b>. When an agent's claim and reality disagree, RIPPLE finds the gap and coordinates a verified recovery.</p>
          <div className="term poster-term" aria-label="About this build">
            <div className="dots"><i /><i /><i />~/ripple</div>
            <div><span className="prompt">$</span> ripple --about</div>
            <div className="ln"><span className="k">reality gap engine</span><span className="v">intended · declared · observed</span></div>
            <div className="ln"><span className="k">compound failure arena</span><span className="v">independent evaluator</span></div>
            <div className="ln"><span className="k">connected systems</span><span className="v">sandbox (not production)</span></div>
            <div className="ln warn"><span className="k">switch</span><span className="v">local mode · not connected</span></div>
            <div><span className="prompt">$</span> <span className="caret" /></div>
          </div>
        </section>
        <section className="poster-login">{children}</section>
      </main>
      <p className="poster-foot">Demo workspace · deterministic analyzers · dry-run connectors: nothing is emailed, paid or submitted · Switch: local mode</p>
    </div>
  );
}
