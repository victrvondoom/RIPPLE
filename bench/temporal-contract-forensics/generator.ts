/**
 * TCFB generator: deterministic adversarial scenarios with known ground truth.
 *
 * Every case starts from a hidden TRUE timeline of the contracted scope. Honest sources observe it through a clock
 * (true offset within the declared uncertainty, optional drift within the declared rate) and report state intervals
 * whose boundary bounds always contain the true reading. Categories then add the adversarial ingredient: gaps,
 * duplicates, late or shuffled delivery, foreign scopes, overlapping incidents, flapping, deliberate lies,
 * maintenance claims, contract-version boundaries, time-zone boundaries, exact threshold ties, broken contracts and
 * wrong scopes. The generator also emits an independent oracle view (see lib.ts).
 */
import type { AuthorityClass, ContractDocument, MaintenanceRecord, ObservedState } from '../../src/server/capabilities/temporal-contract-forensics/index.js';
import { CATEGORIES, iso, LATTICE as L, MIN, RANKS, rng, type BenchCase, type Category, type Ev, type OracleRecord, type OracleRules, type Rng, type Truth } from './lib.js';

interface Src {
  sys: string; clock: string; auth: AuthorityClass; sig?: boolean;
  U: number; known: number; trueOff: number; ppm: number; rho: number; jit: number;
  scope: { service: string; region?: string; customer?: string; semantics?: 'UNIVERSAL' | 'AGGREGATE' };
  applies: boolean; transitions?: boolean; incident?: (s: number, e: number) => string;
}

interface Ctx {
  r: Rng; W0: number; ref: number; evidence: Ev[]; view: OracleRecord[]; trueReadings: BenchCase['meta']['trueReadings'];
  qualifying: Set<ObservedState>; counter: number;
}

const rank = (s: Src) => (s.auth === 'SIGNED_MONITORING' && !s.sig ? RANKS.UNVERIFIED_MANUAL : RANKS[s.auth]);
const reading = (s: Src, ref: number, t: number) => t + s.trueOff + (s.rho * (t - ref)) / 1e6; // exact integer by construction
const widen = (s: Src, ref: number, x: number) => (s.ppm ? Math.ceil((s.ppm * (Math.abs(x - ref) + s.U)) / 1e6) : 0);

/** Declared bound [r − jit, r] in the source clock; the oracle view of it in the corrected frame. */
function bound(c: Ctx, s: Src, t: number, jit: number): { tb: { earliest: string; latest: string }; lo: number; hi: number; read: number } {
  const read = reading(s, c.ref, t); const r = read + (jit ? c.r.int(0, jit / L) * L : 0);
  const a = r - jit - s.known; const b = r - s.known;
  return { tb: { earliest: iso(r - jit), latest: iso(r) }, lo: a - widen(s, c.ref, a), hi: b + widen(s, c.ref, b), read };
}

function base(c: Ctx, s: Src, id: string, rec: string, observed: number) {
  return {
    id, incidentId: 'INC-1', scope: { ...s.scope },
    source: { system: s.sys, recordId: rec, authority: s.auth, clockId: s.clock, ...(s.sig !== undefined ? { signatureVerified: s.sig } : {}) },
    observedAt: iso(observed), provenance: { reference: `${s.sys}://${rec}`, contentHash: `sha256:${s.sys}:${rec}` },
  };
}

/**
 * Emit one source's honest report of `segments` (true time, alternating state), as INTERVAL records or as
 * TRANSITION records. Returns emitted evidence ids.
 */
function emit(c: Ctx, s: Src, segments: { s: number; e: number; down: boolean }[], opts: { exactOuter?: boolean } = {}): string[] {
  const ids: string[] = [];
  const end = segments[segments.length - 1]!.e;
  const obs = reading(s, c.ref, end) + 2 * MIN + s.U;
  // Boundary bounds are shared between the segment that ends and the one that starts there.
  const bounds = new Map<number, ReturnType<typeof bound>>();
  const bAt = (t: number, outer: boolean) => { if (!bounds.has(t)) bounds.set(t, bound(c, s, t, outer && opts.exactOuter !== false ? 0 : s.jit)); return bounds.get(t)!; };
  if (s.transitions) {
    segments.forEach((g, i) => {
      const id = `${s.sys}-t${++c.counter}`; const b = bAt(g.s, i === 0);
      const last = i === segments.length - 1;
      const hold = last ? bAt(g.e, true) : null;
      c.evidence.push({ ...base(c, s, id, id, obs), ...(s.incident ? { incidentId: s.incident(g.s, g.e) } : {}), assertion: { kind: 'TRANSITION', to: g.down ? 'UNAVAILABLE' : 'HEALTHY', at: b.tb, ...(hold ? { holdsUntil: hold.tb.latest } : {}) } });
      c.trueReadings[id] = { at: b.read };
      ids.push(id);
    });
    if (s.applies) segments.forEach((g, i) => {
      const a = bAt(g.s, i === 0); const z = i + 1 < segments.length ? bAt(g.e, false) : bAt(g.e, true);
      c.view.push({ id: ids[i]!, clock: s.clock, polarity: g.down ? 'Q' : 'N', kind: 'INTERVAL', sLo: a.lo, sHi: a.hi, eLo: z.lo, eHi: z.hi, rank: rank(s) });
    });
    return ids;
  }
  segments.forEach((g, i) => {
    const id = `${s.sys}-${++c.counter}`;
    const a = bAt(g.s, i === 0); const z = bAt(g.e, i === segments.length - 1);
    c.evidence.push({ ...base(c, s, id, id, obs), ...(s.incident ? { incidentId: s.incident(g.s, g.e) } : {}), assertion: { kind: 'INTERVAL', state: g.down ? 'UNAVAILABLE' : 'HEALTHY', start: a.tb, end: z.tb } });
    c.trueReadings[id] = { start: a.read, end: z.read };
    if (s.applies) c.view.push({ id, clock: s.clock, polarity: g.down ? 'Q' : 'N', kind: 'INTERVAL', sLo: a.lo, sHi: a.hi, eLo: z.lo, eHi: z.hi, rank: rank(s) });
    ids.push(id);
  });
  return ids;
}

/** Alternating segments of [from, to) given true down intervals; optionally with gaps removed (returned separately). */
function segmentsOf(down: [number, number][], from: number, to: number, gaps: [number, number][] = []): { s: number; e: number; down: boolean }[][] {
  const cuts = new Set<number>([from, to]);
  for (const [a, b] of [...down, ...gaps]) { if (a > from && a < to) cuts.add(a); if (b > from && b < to) cuts.add(b); }
  const pts = [...cuts].sort((x, y) => x - y);
  const out: { s: number; e: number; down: boolean }[][] = [[]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = pts[i]!; const e = pts[i + 1]!;
    if (gaps.some(([a, b]) => s >= a && e <= b)) { if (out[out.length - 1]!.length) out.push([]); continue; }
    const dn = down.some(([a, b]) => s >= a && e <= b);
    const cur = out[out.length - 1]!; const last = cur[cur.length - 1];
    if (last && last.down === dn) last.e = e; else cur.push({ s, e, down: dn });
  }
  return out.filter((x) => x.length);
}

function randomTruth(r: Rng, W0: number, n = r.int(1, 2), span = 120): [number, number][] {
  const out: [number, number][] = []; let t = W0 + r.int(-30, (span - 70) * 6) * L;
  for (let i = 0; i < n; i++) { const len = r.int(18, 300) * L; out.push([t, t + len]); t += len + r.int(24, 240) * L; }
  return out;
}

function src(r: Rng, i: number, over: Partial<Src> = {}): Src {
  const U = over.U ?? r.pick([0, 0, 1, 3, 6, 9, 12]) * L;
  const auth = over.auth ?? r.pick(['SIGNED_MONITORING', 'AUTHENTICATED_INFRASTRUCTURE', 'SYNTHETIC_PROBE'] as const);
  return { sys: `src${i}`, clock: `clk${i}`, auth, sig: auth === 'SIGNED_MONITORING' ? true : undefined, U, known: 0, trueOff: U ? r.int(-U / L, U / L) * L : 0, ppm: 0, rho: 0, jit: r.pick([0, 1, 3, 6]) * L, scope: { service: 'orders-api' }, applies: true, ...over };
}

function contract(r: Rng, W0: number, T: number, inclusive: boolean, over: Partial<ContractDocument> = {}, measurement: Partial<ContractDocument['measurement']> = {}): ContractDocument {
  return {
    contractId: 'TCFB-MSA', version: '1', effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: null,
    scope: { service: 'orders-api' },
    measurement: { period: { type: 'INCIDENT_WINDOW' }, metric: 'CUMULATIVE_DOWNTIME', qualifyingStates: ['UNAVAILABLE'], ...measurement },
    breach: { type: 'DOWNTIME_EXCEEDS', thresholdMs: T, inclusive },
    ...over,
  };
}

/** Independent month boundaries for zones whose offset at the start of every month is known (no DST change on the 1st). */
const TZ = {
  'Asia/Tokyo': () => 9 * 60, 'Asia/Kolkata': () => 330,
  'America/New_York': (y: number, m: number) => { void y; return m >= 4 && m <= 11 ? -240 : -300; }, // EDT Apr–Nov 1st, EST otherwise
} as const;
function monthStart(y: number, m: number, tz: keyof typeof TZ): number { const yy = m > 12 ? y + 1 : y; const mm = m > 12 ? 1 : m; return Date.UTC(yy, mm - 1, 1) - TZ[tz](yy, mm) * MIN; }

function rulesOf(c: ContractDocument): OracleRules | null {
  if (!c.breach || c.breach.type !== 'DOWNTIME_EXCEEDS' || !c.measurement?.qualifyingStates?.length || (c.clauses ?? []).some((x) => x.type !== 'INFORMATIONAL')) return null;
  const m = c.measurement;
  return { thresholdMs: c.breach.thresholdMs, inclusive: c.breach.inclusive, metric: m.metric, mergeGapMs: m.episodeMergeGapMs ?? 0, countMergedGaps: m.countMergedGaps ?? false, minEpisodeMs: m.minimumQualifyingEpisodeMs ?? 0, graceMs: m.gracePerEpisodeMs ?? 0 };
}

export function generateCase(category: Category, index: number, seed: number): BenchCase {
  const r = rng(seed ^ (CATEGORIES.indexOf(category) * 0x9e3779b1) ^ (index * 0x85ebca6b));
  const W0 = Date.UTC(2026, 0, 5) + r.int(0, 300) * 86_400_000 + r.int(0, 23) * 3_600_000;
  let window: [number, number] = [W0, W0 + 120 * MIN];
  const c: Ctx = { r, W0, ref: window[0], evidence: [], view: [], trueReadings: {}, qualifying: new Set(['UNAVAILABLE']), counter: 0 };
  const meta: BenchCase['meta'] = { liars: [], gaps: [], trueOffsets: {}, trueReadings: c.trueReadings, lateIds: [], maintenanceValid: {}, service: 'orders-api' };
  let truthDown = randomTruth(r, W0);
  const T = r.int(60, 360) * L; const inclusive = r.chance(0.25);
  let doc = contract(r, W0, T, inclusive);
  const clocks: { clockId: string; knownOffsetMs: number; uncertaintyMs: number; driftPpm?: number; lastSyncAt?: string }[] = [];
  const maintenance: MaintenanceRecord[] = [];
  const applied: [number, number][] = []; const possible: [number, number][] = []; const valid: [number, number][] = [];
  let expected: 'NOT_APPLICABLE' | 'INDETERMINATE' | null = null;
  let incident: BenchCase['input']['incident'];
  let measurementWindow: BenchCase['input']['measurementWindow'] = { start: iso(window[0]), end: iso(window[1]) };
  const cover = (): [number, number] => [window[0] - 30 * MIN, window[1] + 30 * MIN];
  const sources: Src[] = [];
  const addSrc = (s: Src) => { sources.push(s); clocks.push({ clockId: s.clock, knownOffsetMs: s.known, uncertaintyMs: s.U, ...(s.ppm ? { driftPpm: s.ppm, lastSyncAt: iso(c.ref) } : {}) }); meta.trueOffsets[s.clock] = s.trueOff; return s; };
  // Hardness: unless a category controls gaps itself, an honest source misses a stretch around an outage boundary
  // with probability 0.35 (the boundary is then unobserved by that source).
  const randomGap = (down: [number, number][]): [number, number][] => {
    if (!down.length || !r.chance(0.35)) return [];
    const edge = r.pick(down.flat()); const g: [number, number] = [edge - r.int(0, 30) * L, edge + r.int(6, 48) * L];
    meta.gaps.push(g); return [g];
  };
  const honest = (s: Src, gaps?: [number, number][], down = truthDown) => { const [a, b] = cover(); const ids: string[] = []; for (const segs of segmentsOf(down, a, b, gaps ?? randomGap(down))) ids.push(...emit(c, s, segs)); return ids; };
  const nSrc = r.int(1, 3);
  let uncertainBudget = 2; // keep the oracle exhaustive: at most two clocks with residual uncertainty
  const pickSrc = (i: number, over: Partial<Src> = {}) => { const s = src(r, i, over); if (s.U > 0) { if (uncertainBudget <= 0) { s.U = 0; s.trueOff = 0; } else uncertainBudget--; } return addSrc(s); };

  switch (category) {
    case 'ACCURATE_TIMESTAMPS': for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { U: 0, jit: 0 })); break;
    case 'CLOCK_DRIFT': {
      const rho = r.pick([-200, -100, 0, 100, 200]);
      honest(addSrc(src(r, 0, { U: 0, ppm: 200, rho })));
      for (let i = 1; i < nSrc; i++) honest(addSrc(src(r, i, { U: 0 })));
      break;
    }
    case 'LARGE_CLOCK_OFFSET': {
      const known = r.pick([-1, 1]) * r.pick([12, 30, 60, 90]) * L; const U = r.pick([0, 3, 6, 9]) * L;
      const s0 = pickSrc(0, { U, known }); s0.trueOff = known + (s0.U ? r.int(-s0.U / L, s0.U / L) * L : 0); meta.trueOffsets[s0.clock] = s0.trueOff;
      honest(s0); for (let i = 1; i < nSrc; i++) honest(pickSrc(i));
      break;
    }
    case 'MISSING_RECOVERY': {
      const s0 = pickSrc(0); const [a, b] = cover(); const out = truthDown[0]!;
      // s0 reports up to the outage onset (as an open transition) and then stops reporting.
      const segs = segmentsOf(truthDown, a, b).flat().filter((g) => g.s < out[0]);
      if (segs.length) emit(c, s0, segs);
      const id = `${s0.sys}-onset`; const bd = bound(c, s0, out[0], s0.jit);
      c.evidence.push({ ...base(c, s0, id, id, reading(s0, c.ref, out[0]) + 5 * MIN + s0.U), assertion: { kind: 'TRANSITION', to: 'UNAVAILABLE', at: bd.tb } });
      c.trueReadings[id] = { at: bd.read };
      c.view.push({ id, clock: s0.clock, polarity: 'Q', kind: 'POINT', sLo: bd.lo, sHi: bd.hi, eLo: bd.lo, eHi: bd.hi, rank: rank(s0) });
      meta.gaps.push([out[0], b]);
      for (let i = 1; i < nSrc; i++) { const g: [number, number] = [out[0] + r.int(0, 30) * L, out[1] + r.int(-12, 60) * L]; const gap = r.chance(0.6); if (gap) meta.gaps.push(g); honest(pickSrc(i), gap ? [g] : []); }
      break;
    }
    case 'DUPLICATE_OUTAGE_EVENTS': {
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i));
      const extra: Ev[] = [];
      for (const e of c.evidence) {
        if (r.chance(0.3)) extra.push({ ...structuredClone(e), id: `${e.id}-resent`, ingestedAt: iso(Date.parse(e.observedAt) + 3 * MIN) });
        if (r.chance(0.2)) { const d = structuredClone(e); d.id = `${e.id}-mirror`; d.source.recordId = `${e.source.recordId}-mirror`; extra.push(d); } // same raw content hash
      }
      c.evidence.push(...extra);
      break;
    }
    case 'LATE_ARRIVING_EVIDENCE': {
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i));
      meta.lateIds = c.evidence.filter(() => r.chance(0.4)).map((e) => e.id);
      break;
    }
    case 'OUT_OF_ORDER_EVENTS': {
      truthDown = randomTruth(r, W0).map(([a, b]) => [a, Math.max(b, a + 12 * L)]);
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { transitions: i === 0 || r.chance(0.5), jit: r.pick([0, 1, 3]) * L }));
      for (let i = c.evidence.length - 1; i > 0; i--) { const j = r.int(0, i); [c.evidence[i], c.evidence[j]] = [c.evidence[j]!, c.evidence[i]!]; }
      break;
    }
    case 'PARTIAL_REGIONAL_OUTAGE': {
      doc = contract(r, W0, T, inclusive, { scope: { service: 'orders-api', region: 'eu-west-1' } });
      const us = randomTruth(r, W0, 1);
      const eu = r.chance(0.5) ? truthDown : [];
      truthDown = eu;
      honest(pickSrc(0, { scope: { service: 'orders-api', region: 'eu-west-1' } }), [], eu);
      honest(pickSrc(1, { scope: { service: 'orders-api', region: 'us-east-1' }, applies: false }), [], us);
      // A global, AGGREGATE monitor: "down" only when every region is down; its health says nothing about eu-west-1.
      const both = eu.flatMap(([a, b]) => us.map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as [number, number])).filter(([a, b]) => a < b);
      const g = pickSrc(2, { scope: { service: 'orders-api', semantics: 'AGGREGATE' } });
      const before = c.view.length; honest(g, [], both);
      c.view.splice(before, c.view.length - before, ...c.view.slice(before).filter((v) => v.polarity === 'Q'));
      break;
    }
    case 'OVERLAPPING_INCIDENTS': {
      const a = randomTruth(r, W0, 1)[0]!; const b: [number, number] = [a[0] + r.int(6, 120) * L, a[1] + r.int(6, 180) * L];
      truthDown = [[a[0], Math.max(a[1], b[1])]];
      const inc = (s: number) => (s >= b[0] ? 'INC-2' : 'INC-1');
      incident = { incidentId: 'INC-1', scope: { service: 'orders-api' } };
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { incident: inc }));
      break;
    }
    case 'FLAPPING_RECOVERY': {
      let t = W0 + r.int(6, 120) * L; truthDown = [];
      for (let k = 0; k < r.int(2, 4); k++) { const len = r.int(18, 120) * L; truthDown.push([t, t + len]); t += len + r.int(2, 12) * L; }
      const merge = r.pick([0, 9, 18]) * L;
      doc = contract(r, W0, T, inclusive, {}, { metric: r.pick(['CUMULATIVE_DOWNTIME', 'LONGEST_CONTINUOUS_DOWNTIME'] as const), episodeMergeGapMs: merge, countMergedGaps: r.chance(0.5), minimumQualifyingEpisodeMs: r.pick([0, 0, 6]) * L, gracePerEpisodeMs: r.pick([0, 0, 3]) * L });
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { U: 0, jit: r.pick([0, 1]) * L }));
      break;
    }
    case 'CONFLICTING_TELEMETRY': case 'DELIBERATE_CONTRADICTION': {
      const s0 = pickSrc(0, { auth: category === 'DELIBERATE_CONTRADICTION' ? 'AUTHENTICATED_INFRASTRUCTURE' : r.pick(['SIGNED_MONITORING', 'AUTHENTICATED_INFRASTRUCTURE'] as const) });
      if (s0.auth === 'SIGNED_MONITORING') s0.sig = true;
      honest(s0);
      for (let i = 1; i < nSrc; i++) honest(pickSrc(i));
      // The liar: claims the outage ended `shift` later (or earlier) than it did, beyond its stated uncertainty,
      // or reports a failure in a truly healthy period.
      const liar = category === 'DELIBERATE_CONTRADICTION'
        ? addSrc(src(r, 9, { auth: r.pick(['AUTHENTICATED_INFRASTRUCTURE', 'SYNTHETIC_PROBE'] as const), U: 0, jit: 0 }))
        : addSrc(src(r, 9, { auth: r.pick(['CUSTOMER_REPORT', 'UNVERIFIED_MANUAL', 'SUPPORT_TICKET'] as const), U: 0, jit: 0 }));
      const out = truthDown[0]!; const shift = r.pick([-1, 1]) * r.int(12, 60) * L;
      const lie: [number, number][] = [[out[0], Math.max(out[0] + L, out[1] + shift)], ...truthDown.slice(1)];
      const before = c.evidence.length; honest(liar, [], lie);
      if (r.chance(0.5) && category === 'CONFLICTING_TELEMETRY') {
        // plus a point failure report in a truly healthy minute
        const healthyT = truthDown[truthDown.length - 1]![1] + r.int(6, 60) * L; const id = `${liar.sys}-pt`; const bd = bound(c, liar, healthyT, 0);
        c.evidence.push({ ...base(c, liar, id, id, healthyT + 10 * MIN), assertion: { kind: 'POINT', state: 'UNAVAILABLE', at: bd.tb } });
        c.view.push({ id, clock: liar.clock, polarity: 'Q', kind: 'POINT', sLo: bd.lo, sHi: bd.hi, eLo: bd.lo, eHi: bd.hi, rank: rank(liar) });
      }
      meta.liars = c.evidence.slice(before).map((e) => e.id);
      break;
    }
    case 'MAINTENANCE_EXCLUSIONS': {
      const notice = r.pick([0, 72 * 60 * MIN]);
      doc = contract(r, W0, T, inclusive, { maintenance: { noticeRequiredMs: notice } });
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i));
      const kinds = ['CONFIRMED_OK', 'UNCONFIRMED', 'LATE_NOTICE', 'OTHER_REGION'] as const;
      for (let k = 0; k < r.int(1, 2); k++) {
        const kind = r.pick(kinds); const o = truthDown[0]!; const s = o[0] + r.int(-30, 60) * L; const e = s + r.int(6, 90) * L;
        const id = `MW-${k + 1}`; const iv: [number, number] = [Math.max(s, window[0]), Math.min(e, window[1])];
        const rec: MaintenanceRecord = { id, start: iso(s), end: iso(e), status: kind === 'UNCONFIRMED' ? 'UNCONFIRMED' : 'CONFIRMED', reference: `chg://${id}`, ...(kind === 'CONFIRMED_OK' ? { announcedAt: iso(s - notice - 60 * MIN) } : kind === 'LATE_NOTICE' && notice ? { announcedAt: iso(s - notice + 60 * MIN) } : kind === 'OTHER_REGION' ? { announcedAt: iso(s - notice - 60 * MIN), regions: ['ap-south-1'] } : {}) };
        maintenance.push(rec);
        const effective = iv[0] < iv[1];
        if (kind === 'CONFIRMED_OK' || (kind === 'LATE_NOTICE' && !notice)) { if (effective) { applied.push(iv); valid.push(iv); } meta.maintenanceValid[id] = true; }
        else if (kind === 'UNCONFIRMED') { const ok = r.chance(0.5); meta.maintenanceValid[id] = ok; if (effective) { possible.push(iv); if (ok) valid.push(iv); } }
        else meta.maintenanceValid[id] = false;
      }
      break;
    }
    case 'CONTRACT_VERSION_CHANGE': {
      const T2 = r.int(60, 360) * L; const span = r.chance(0.3);
      const boundary = span ? window[0] + r.int(1, 11) * 10 * MIN : r.chance(0.5) ? window[0] - r.int(1, 30) * 86_400_000 : window[1] + r.int(1, 30) * 86_400_000;
      const v1 = contract(r, W0, T, inclusive, { version: '1', effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: iso(boundary) });
      const v2 = contract(r, W0, T2 === T ? T + L : T2, inclusive, { version: '2', effectiveFrom: iso(boundary), effectiveTo: null });
      doc = boundary >= window[1] ? v1 : v2; // the version that governs (when not spanning)
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i));
      if (span) expected = 'INDETERMINATE';
      (c as unknown as { versions: ContractDocument[] }).versions = r.chance(0.5) ? [v2, v1] : [v1, v2];
      break;
    }
    case 'WINDOW_BOUNDARY': {
      truthDown = r.chance(0.5) ? [[window[0] - r.int(6, 120) * L, window[0] + r.int(6, 240) * L]] : [[window[1] - r.int(6, 240) * L, window[1] + r.int(6, 120) * L]];
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i));
      break;
    }
    case 'TIMEZONE_BOUNDARY': {
      const tz = r.pick(Object.keys(TZ) as (keyof typeof TZ)[]);
      const y = 2026; const m = r.int(1, 11);
      const ms = monthStart(y, m, tz); const me = monthStart(y, m + 1, tz);
      const edge = r.chance(0.5) ? ms : me;
      truthDown = [[edge - r.int(6, 240) * L, edge + r.int(6, 240) * L]];
      window = [ms, me]; c.ref = ms;
      doc = contract(r, W0, T, inclusive, {}, { period: { type: 'CALENDAR_MONTH', timeZone: tz } });
      measurementWindow = { calendarMonth: `${y}-${String(m).padStart(2, '0')}` };
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { U: r.pick([0, 3]) * L }));
      break;
    }
    case 'THRESHOLD_EQUALITY': {
      const s = W0 + r.int(6, 300) * L; truthDown = [[s, s + T]];
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { U: 0, jit: 0 }));
      break;
    }
    case 'MULTIPLE_OVERLAPPING_INTERVALS': {
      truthDown = randomTruth(r, W0, r.int(2, 3));
      const n = r.int(3, 4);
      for (let i = 0; i < n; i++) honest(pickSrc(i));
      // Extra, overlapping sub-interval claims by an exact-clock probe (true, so consistent): must not double count.
      const p = pickSrc(8, { U: 0, jit: 0, auth: 'SYNTHETIC_PROBE' });
      for (const [a, b] of truthDown) for (let k = 0; k < 2; k++) {
        const x = a + r.int(0, Math.floor((b - a) / L / 2)) * L; const z = Math.min(b, x + r.int(1, 60) * L);
        if (x < z) emit(c, p, [{ s: x, e: z, down: true }]);
      }
      break;
    }
    case 'MISSING_CONTRACT_FIELDS': {
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i));
      const how = r.pick(['NO_THRESHOLD', 'NO_QUALIFYING_STATES', 'UNSUPPORTED_CLAUSE', 'NO_VERSION'] as const);
      if (how === 'NO_THRESHOLD') delete doc.breach;
      if (how === 'NO_QUALIFYING_STATES') doc.measurement.qualifyingStates = [];
      if (how === 'UNSUPPORTED_CLAUSE') doc.clauses = [{ id: '11.4', type: 'FORCE_MAJEURE', text: 'Unavailability caused by upstream cloud-provider failures is excluded.' }];
      if (how === 'NO_VERSION') doc.version = '';
      expected = 'INDETERMINATE';
      break;
    }
    case 'INCORRECT_SERVICE_SCOPE': {
      for (let i = 0; i < nSrc; i++) honest(pickSrc(i, { scope: { service: 'billing-api' }, applies: false }));
      if (r.chance(0.5)) { incident = { incidentId: 'INC-1', scope: { service: 'billing-api' } }; expected = 'NOT_APPLICABLE'; }
      else { doc = contract(r, W0, T, inclusive, { effectiveFrom: iso(window[1] + 86_400_000) }); expected = 'NOT_APPLICABLE'; }
      break;
    }
  }

  const versions = (c as unknown as { versions?: ContractDocument[] }).versions;
  const qTrue0 = subtractAll(window, [...applied, ...valid]);
  // Hardness: half of the cases put the threshold within ±3 min of the true contractual downtime, where timestamp
  // and clock uncertainty actually decide the outcome. (Equality cases keep their exact tie.)
  if (category !== 'THRESHOLD_EQUALITY' && expected === null && doc.breach?.type === 'DOWNTIME_EXCEEDS' && rulesOf(doc) && r.chance(0.5)) {
    const m = truthMeasure(truthDown, qTrue0, rulesOf(doc)!);
    doc.breach.thresholdMs = Math.max(L, m + r.int(-18, 18) * L);
  }
  const rules = rulesOf(doc);
  const exactOracle = sources.filter((s) => s.applies && s.U > 0).length <= 2;
  const qTrue = subtractAll(window, [...applied, ...valid]);
  const truth: Truth = { down: truthDown, validExclusions: valid, breach: null, metricMs: null, breachPointMs: null };
  if (rules && expected === null) {
    const bp = rules.inclusive ? rules.thresholdMs : rules.thresholdMs + 1;
    const m = truthMeasure(truthDown, qTrue, rules);
    truth.metricMs = m; truth.breachPointMs = bp; truth.breach = m >= bp;
  }
  return {
    id: `${category}#${index}`, category, index, meta: { ...meta, ...(incident ? {} : {}) },
    input: { contract: versions ?? doc, evidence: c.evidence, measurementWindow, clocks, maintenance, ...(incident ? { incident } : {}) },
    oracle: { window, appliedExclusions: applied, possibleExclusions: possible, records: c.view, clocks: Object.fromEntries(sources.map((s) => [s.clock, s.U])), rules, expected, exact: exactOracle },
    truth,
  };
}

function subtractAll(w: [number, number], xs: [number, number][]): [number, number][] {
  let out: [number, number][] = [w];
  for (const [a, b] of xs) out = out.flatMap(([s, e]) => (b <= s || a >= e ? [[s, e]] : [...(a > s ? [[s, a] as [number, number]] : []), ...(b < e ? [[b, e] as [number, number]] : [])]));
  return out;
}

/** The contractual measure of the TRUE timeline (independent implementation, shared with the oracle). */
export function truthMeasure(down: [number, number][], q: [number, number][], r: OracleRules): number {
  const clipped: [number, number][] = [];
  for (const [a, b] of down) for (const [s, e] of q) { const x = Math.max(a, s); const y = Math.min(b, e); if (x < y) clipped.push([x, y]); }
  clipped.sort((x, y) => x[0] - y[0]);
  const comps: [number, number][] = [];
  for (const [a, b] of clipped) { const l = comps[comps.length - 1]; if (l && a <= l[1]) l[1] = Math.max(l[1], b); else comps.push([a, b]); }
  const groups: [number, number][][] = [];
  for (const x of comps) { const g = groups[groups.length - 1]; if (g && r.mergeGapMs > 0 && x[0] - g[g.length - 1]![1] < r.mergeGapMs) g.push(x); else groups.push([x]); }
  let total = 0;
  for (const g of groups) {
    let m = 0;
    if (r.countMergedGaps) { const hs = g[0]![0]; const he = g[g.length - 1]![1]; for (const [s, e] of q) m += Math.max(0, Math.min(he, e) - Math.max(hs, s)); }
    else for (const [a, b] of g) m += b - a;
    const counted = m < r.minEpisodeMs ? 0 : Math.max(0, m - r.graceMs);
    total = r.metric === 'CUMULATIVE_DOWNTIME' ? total + counted : Math.max(total, counted);
  }
  return total;
}

export function generateAll(perCategory: number, seed: number): BenchCase[] {
  const out: BenchCase[] = [];
  for (const cat of CATEGORIES) for (let i = 0; i < perCategory; i++) out.push(generateCase(cat, i, seed));
  return out;
}
