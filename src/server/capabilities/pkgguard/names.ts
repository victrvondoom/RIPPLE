/**
 * Name-similarity signals (typosquatting and combosquatting) against a reference list of popular packages.
 * Pure and offline. The reference list is DATA supplied by the caller (see data/ and bench/pkgguard), so the thresholds
 * below are the only rule content. Every threshold is exported so the benchmark report can print exactly what ran.
 */
import type { Ecosystem } from './installs.js';

export const NAME_RULES = {
  /** Minimum length of the popular name before an edit distance of 1 counts (short names collide by chance). */
  minLenForDistance1: 4,
  /** Popular names at least this long also count at edit distance 2. */
  minLenForDistance2: 9,
  /** Affixes that turn a popular name into a lookalike ("combosquatting"). Reported as a separate, weaker signal. */
  suffixes: ['-js', 'js', '.js', '-node', '-dev', '-sdk', '-api', '-cli', '-utils', '-lib', '-py', 'py', '-python', '2', '3', '-2', '-3'],
  prefixes: ['node-', 'py-', 'py', 'python-'],
} as const;

export type SquatKind = 'typo-distance' | 'separator-confusion' | 'scope-confusion' | 'homoglyph' | 'combosquat';
export interface SquatHit { kind: SquatKind; target: string; distance?: number; detail: string }

/** Optimal-string-alignment distance (Damerau–Levenshtein with adjacent transpositions), with early exit above `max`. */
export function osaDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1); cur[0] = i; let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[m];
}

const stripSep = (s: string) => s.replace(/[-_.]/g, '');
const HOMOGLYPHS: [RegExp, string][] = [[/rn/g, 'm'], [/vv/g, 'w'], [/0/g, 'o'], [/1/g, 'l'], [/l/g, 'i']];
export const normalise = (eco: Ecosystem, name: string) => (eco === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name.toLowerCase());

export class NameIndex {
  private set: Set<string>;
  private byLen = new Map<number, string[]>();
  private bySep = new Map<string, string>();
  private byBare = new Map<string, string>();
  constructor(public eco: Ecosystem, popular: string[]) {
    const names = popular.map((p) => normalise(eco, p));
    this.set = new Set(names);
    for (const p of names) {
      const arr = this.byLen.get(p.length) ?? []; arr.push(p); this.byLen.set(p.length, arr);
      const k = stripSep(p); if (!this.bySep.has(k)) this.bySep.set(k, p);
      if (eco === 'npm' && p.startsWith('@')) { const [scope, bare] = p.slice(1).split('/'); for (const v of [`${scope}-${bare}`, `${scope}${bare}`, `${scope}.${bare}`]) if (!this.byBare.has(v)) this.byBare.set(v, p); }
    }
  }
  has(name: string) { return this.set.has(normalise(this.eco, name)); }
  size() { return this.set.size; }

  /** All squat signals for `name`. A name that IS in the popular list never matches (it is the target, not a lookalike). */
  check(raw: string): SquatHit[] {
    const name = normalise(this.eco, raw);
    if (this.set.has(name)) return [];
    const hits: SquatHit[] = [];
    // npm: a scoped lookalike of an unscoped popular name (@evil/lodash) is not flagged: scopes are namespaces.
    const flat = this.eco === 'npm' && name.startsWith('@') ? null : name;
    if (flat) {
      const sep = this.bySep.get(stripSep(flat));
      if (sep && sep !== flat) hits.push({ kind: 'separator-confusion', target: sep, detail: `differs from ${sep} only by - _ . separators` });
      const scoped = this.byBare.get(flat);
      if (scoped) hits.push({ kind: 'scope-confusion', target: scoped, detail: `unscoped copy of ${scoped}` });
      for (const [re, rep] of HOMOGLYPHS) {
        const v: string = flat.replace(re, rep);
        if (v !== flat && this.set.has(v)) { hits.push({ kind: 'homoglyph', target: v, detail: `reads like ${v} (${re.source} for ${rep})` }); break; }
      }
      const best = this.nearest(flat);
      if (best && !hits.some((h) => h.target === best.target)) hits.push({ kind: 'typo-distance', target: best.target, distance: best.d, detail: `edit distance ${best.d} from ${best.target}` });
      if (hits.length === 0) {
        const bases = [
          ...NAME_RULES.suffixes.filter((a) => flat.endsWith(a)).map((a) => [flat.slice(0, -a.length), a]),
          ...NAME_RULES.prefixes.filter((a) => flat.startsWith(a)).map((a) => [flat.slice(a.length), a]),
        ];
        const hit = bases.find(([b]) => b.length >= 4 && this.set.has(b));
        if (hit) hits.push({ kind: 'combosquat', target: hit[0], detail: `${hit[0]} with "${hit[1]}" added` });
      }
    }
    return hits;
  }

  private nearest(name: string): { target: string; d: number } | null {
    let best: { target: string; d: number } | null = null;
    for (let len = name.length - 2; len <= name.length + 2; len++) {
      for (const p of this.byLen.get(len) ?? []) {
        if (p.length < NAME_RULES.minLenForDistance1) continue;
        const max = p.length >= NAME_RULES.minLenForDistance2 ? 2 : 1;
        const d = osaDistance(name, p, max);
        if (d <= max && (!best || d < best.d)) best = { target: p, d };
        if (best?.d === 1) return best;
      }
    }
    return best;
  }
}

/** The signals strong enough to count as "lookalike" in the composite rule. Combosquat is reported but not counted. */
export const STRONG_SQUAT: SquatKind[] = ['typo-distance', 'separator-confusion', 'scope-confusion', 'homoglyph'];
