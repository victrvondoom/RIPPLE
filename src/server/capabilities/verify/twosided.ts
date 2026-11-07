/**
 * Two-sided verification (session 16; inherited from Kite's verifier suite, which checks that an attack is blocked AND that
 * legitimate traffic still works). A fix is only verified when both sides hold. Pure: RIPPLE sends no probes itself. The
 * observations are recorded by a human (as sentinel's error rate already is) and parsed here.
 *
 * Fail-closed: an 'unknown' observation fails its check, and an empty or unparseable record never passes. Kite's suite returned
 * "simulated" success when a probe threw; that behaviour is deliberately not carried over.
 * Imported by packs/sentinel/pack.ts (completion check and answer parsing for the post-rollback probe question).
 */
export type Expect = 'must-block' | 'must-allow';
export interface Probe { name: string; expect: Expect; observed: 'blocked' | 'allowed' | 'unknown' }
export interface TwoSidedCheck { name: string; passed: boolean; detail: string }

const LINE = /^\s*(must-block|must-allow)\s+(.+?)\s*:\s*(blocked|allowed|unknown)\s*$/i;

/** Parses lines such as "must-block GET /admin: blocked" or "must-allow GET /checkout: allowed". Other lines are reported, not guessed. */
export function parseProbes(text: string): { probes: Probe[]; unparsed: string[] } {
  const probes: Probe[] = []; const unparsed: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = LINE.exec(line);
    if (!m) { unparsed.push(line.trim()); continue; }
    probes.push({ name: m[2], expect: m[1].toLowerCase() as Expect, observed: m[3].toLowerCase() as Probe['observed'] });
  }
  return { probes, unparsed };
}

/** One check per probe. A must-block probe passes only if it was observed blocked; a must-allow probe only if observed allowed. */
export function twoSided(probes: Probe[]): TwoSidedCheck[] {
  if (probes.length === 0) return [{ name: 'two-sided probes recorded', passed: false, detail: 'no probe results were recorded; nothing is verified' }];
  return probes.map((p) => {
    const want = p.expect === 'must-block' ? 'blocked' : 'allowed';
    const passed = p.observed === want;
    return { name: `${p.expect}: ${p.name}`, passed, detail: p.observed === 'unknown' ? 'result unknown; fails closed' : `expected ${want}, observed ${p.observed}` };
  });
}
