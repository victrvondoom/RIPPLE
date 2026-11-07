import type { AuthorityClass, ContractDocument, ObservedState, TemporalEvidence } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { formatInstant } from '../../src/server/capabilities/temporal-contract-forensics/index.js';

export const BASE = Date.parse('2026-03-10T12:00:00Z');
/** ISO instant `m` minutes after BASE (fractions allowed, exact to the ms). */
export const at = (m: number) => formatInstant(BASE + Math.round(m * 60_000));
export const ms = (m: number) => Math.round(m * 60_000);
export const MIN = 60_000;

export function contract(over: Partial<ContractDocument> = {}, measurement: Partial<ContractDocument['measurement']> = {}): ContractDocument {
  return {
    contractId: 'C-1', version: '1', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null,
    scope: { service: 'api' },
    measurement: { period: { type: 'INCIDENT_WINDOW' }, metric: 'CUMULATIVE_DOWNTIME', qualifyingStates: ['UNAVAILABLE'], ...measurement },
    breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: 30 * MIN, inclusive: false },
    ...over,
  };
}

export interface Opts { sj?: number; ej?: number; system?: string; auth?: AuthorityClass; clock?: string; region?: string; customer?: string; service?: string; observed?: number; record?: string; incident?: string; semantics?: 'UNIVERSAL' | 'AGGREGATE'; sig?: boolean }

function base(id: string, o: Opts, observedMin: number): Omit<TemporalEvidence, 'assertion'> {
  const system = o.system ?? 'mon';
  return {
    id, incidentId: o.incident ?? 'INC-1',
    scope: { service: o.service ?? 'api', ...(o.region ? { region: o.region } : {}), ...(o.customer ? { customer: o.customer } : {}), ...(o.semantics ? { semantics: o.semantics } : {}) },
    source: { system, recordId: o.record ?? id, authority: o.auth ?? 'AUTHENTICATED_INFRASTRUCTURE', ...(o.clock ? { clockId: o.clock } : {}), ...(o.sig !== undefined ? { signatureVerified: o.sig } : {}) },
    observedAt: at(o.observed ?? observedMin),
    provenance: { reference: `${system}://${o.record ?? id}`, contentHash: `h:${system}:${o.record ?? id}` },
  };
}

/** Interval [s, e) in minutes; sj/ej = ± jitter in SECONDS around each endpoint. */
export function iv(id: string, state: ObservedState, s: number, e: number, o: Opts = {}): TemporalEvidence {
  const sj = (o.sj ?? 0) / 60; const ej = (o.ej ?? 0) / 60;
  return { ...base(id, o, e + ej + 1), assertion: { kind: 'INTERVAL', state, start: { earliest: at(s - sj), latest: at(s + sj) }, end: { earliest: at(e - ej), latest: at(e + ej) } } };
}

export function pt(id: string, state: ObservedState, t: number, o: Opts = {}): TemporalEvidence {
  const j = (o.sj ?? 0) / 60;
  return { ...base(id, o, t + j + 1), assertion: { kind: 'POINT', state, at: { earliest: at(t - j), latest: at(t + j) } } };
}

export function tr(id: string, to: ObservedState, t: number, o: Opts & { holds?: number } = {}): TemporalEvidence {
  const j = (o.sj ?? 0) / 60;
  return { ...base(id, o, Math.max(t + j, o.holds ?? -Infinity) + 1), assertion: { kind: 'TRANSITION', to, at: { earliest: at(t - j), latest: at(t + j) }, ...(o.holds !== undefined ? { holdsUntil: at(o.holds) } : {}) } };
}

export const W = (s: number, e: number) => ({ start: at(s), end: at(e) });

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

/** Clock profiles with zero uncertainty for the given clock ids (default: the helper's default system "mon"). */
export const exact = (...ids: string[]) => (ids.length ? ids : ['mon']).map((clockId) => ({ clockId, knownOffsetMs: 0, uncertaintyMs: 0 }));

/** Honest monitors: each reports the true state as alternating intervals, with boundaries inside its stated bounds. */
export function honest(r: ReturnType<typeof rng>) {
  const truth: { s: number; e: number }[] = [];
  let t = r.int(0, 30);
  while (t < 110 && truth.length < 3) { const len = r.int(2, 40); truth.push({ s: t, e: t + len }); t += len + r.int(3, 40); }
  const clocks: { clockId: string; knownOffsetMs: number; uncertaintyMs: number }[] = [];
  const evidence: TemporalEvidence[] = [];
  const nSources = r.int(1, 3);
  for (let k = 0; k < nSources; k++) {
    const id = `src${k}`; const u = r.int(0, 12) * 10_000; const off = u ? r.int(-u / 10_000, u / 10_000) * 10_000 : 0;
    clocks.push({ clockId: id, knownOffsetMs: 0, uncertaintyMs: u });
    const jit = r.int(0, 6) * 10_000;
    // boundaries of the source's alternating timeline (minutes) from −40 to 160, with an optional gap.
    const cuts = [-40, ...truth.flatMap((x) => [x.s, x.e]), 160];
    const gapAt = r.next() < 0.4 ? r.int(1, cuts.length - 2) : -1;
    for (let i = 0; i + 1 < cuts.length; i++) {
      if (i === gapAt) continue;
      const down = i % 2 === 1; const s = cuts[i]!; const e = cuts[i + 1]!;
      const rd = (m: number) => BASE + m * MIN + off + r.int(0, jit / 10_000) * 10_000; // reading after detection delay
      const rs = rd(s); const re = rd(e);
      const b = (x: number) => ({ earliest: new Date(x - jit).toISOString(), latest: new Date(x).toISOString() });
      evidence.push({ id: `${id}-${i}`, incidentId: 'INC', scope: { service: 'api' }, source: { system: id, recordId: `${i}`, authority: 'AUTHENTICATED_INFRASTRUCTURE' }, assertion: { kind: 'INTERVAL', state: down ? 'UNAVAILABLE' : 'HEALTHY', start: b(rs), end: b(re) }, observedAt: new Date(re + u + 60_000).toISOString(), provenance: { reference: `${id}/${i}`, contentHash: `${id}/${i}` } });
    }
  }
  return { truth, clocks, evidence };
}

