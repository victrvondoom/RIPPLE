/**
 * RECLAIM capability: regulatory retrieval, evidence scoring and deterministic citation verification.
 *
 * Ported to TypeScript from REDEEM `apps/api/app/reclaim/kb.py`, which itself inherits RECLAIM
 * (MIT, (c) 2026 vsrupeshkumar): `services/evidence_scoring.py` (authority tiers) and
 * `services/citation_verification.py` (claim verification). Behaviour kept, stated plainly:
 *   - retrieval is BM25 over a small bundled corpus (no vector DB, no embeddings, no model call);
 *   - every hit carries `provenance`. The airline/banking rows bundled here are all `authored_guide`:
 *     written by RECLAIM's authors, NOT official regulator text. Callers must never present them as official.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KbRow {
  id: string; domain: string; title: string; authority: string; category: string; source_url: string | null;
  provenance: 'authored_guide' | 'scraped_official'; source_path: string; content_hash: string; text: string;
}
export interface KbHit {
  id: string; domain: string; title: string; authority: string; category: string; sourceUrl: string | null;
  provenance: KbRow['provenance']; passage: string;
  scores: { similarity: number; authority: number; legalWeight: number; overall: number; confidence: number };
}

const WORD = /[a-z0-9]+/g;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'has', 'have', 'not', 'you', 'your', 'can', 'will', 'any', 'all', 'its', 'may']);
const TIER1 = ['rbi', 'dgca', 'moca', 'uidai', 'irdai', 'trai', 'who', 'cdsco', 'icmr', 'mohfw', 'goi', 'govt of india', 'ncdrc', 'rera', 'national health authority', 'dot', 'nch'];
const TIER2 = ['darpg', 'mea', 'income tax dept', 'protean (nsdl)', 'parivahan', 'rti online', 'tn rera', 'maharera', 'karnataka rera', 'kerala rera', 'up rera', 'nha', 'national health mission', 'aiims', 'cpgrams'];
const LEGAL_CATS = new Set(['act', 'regulations', 'kyc', 'cards', 'loans', 'deposits', 'consumer_protection', 'passenger_facilities', 'refunds', 'accessibility', 'digital_security']);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const tokens = (text: string) => (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

export function authorityScore(a: string): number {
  const k = (a ?? '').trim().toLowerCase();
  if (!k) return 0.5;
  if (TIER1.some((t) => k === t || k.includes(t))) return 1.0;
  if (TIER2.some((t) => k === t || k.includes(t))) return 0.8;
  return 0.6;
}
export function legalWeight(category: string): number {
  const k = (category ?? '').trim().toLowerCase();
  if (LEGAL_CATS.has(k) || k.includes('act') || k.includes('regulation') || k.includes('master_direction')) return 1.0;
  if (['faq', 'guide', 'grievance_portal', 'complaints', 'template'].includes(k)) return 0.7;
  return ['overview', 'law_overview'].includes(k) ? 0.5 : 0.6;
}

export class KnowledgeBase {
  readonly byId = new Map<string, KbRow>();
  private tf: Map<string, number>[] = [];
  private df = new Map<string, number>();
  private len: number[] = [];
  private avg = 1;
  constructor(readonly rows: KbRow[]) {
    for (const r of rows) {
      this.byId.set(r.id, r);
      const c = new Map<string, number>();
      for (const t of tokens(`${r.title} ${r.text}`)) c.set(t, (c.get(t) ?? 0) + 1);
      this.tf.push(c); this.len.push([...c.values()].reduce((s, n) => s + n, 0));
      for (const t of c.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = this.len.length ? this.len.reduce((s, n) => s + n, 0) / this.len.length : 1;
  }

  search(query: string, domains?: string[], k = 6): KbHit[] {
    const q = tokens(query); if (!q.length) return [];
    const n = this.rows.length; const scored: [number, number][] = [];
    this.rows.forEach((r, i) => {
      if (domains?.length && !domains.includes(r.domain)) return;
      const tf = this.tf[i]!, dl = this.len[i]!; let s = 0;
      for (const t of new Set(q)) {
        const f = tf.get(t) ?? 0; if (!f) continue;
        const d = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
        s += (idf * (f * 2.2)) / (f + 1.2 * (0.25 + (0.75 * dl) / this.avg));
      }
      if (s > 0) scored.push([s, i]);
    });
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const top = scored.slice(0, k); const best = top[0]?.[0] ?? 1;
    return top.map(([s, i]) => this.hit(this.rows[i]!, s / best, q));
  }

  private hit(r: KbRow, sim: number, q: string[]): KbHit {
    const auth = authorityScore(r.authority), legal = legalWeight(r.category);
    const composite = 0.6 * auth + 0.25 * legal + 0.15 * 0.6;
    const overall = sim * (0.6 + 0.4 * composite);
    let conf = r.authority || r.source_url ? overall : overall * 0.6;
    if (r.provenance === 'authored_guide') conf *= 0.8;          // an authored guide is not an official text
    const low = r.text.toLowerCase();
    const pos = Math.min(...q.map((t) => low.indexOf(t)).filter((p) => p >= 0), Number.MAX_SAFE_INTEGER);
    const start = pos === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, pos - 120);
    return {
      id: r.id, domain: r.domain, title: r.title, authority: r.authority, category: r.category, sourceUrl: r.source_url, provenance: r.provenance,
      passage: r.text.slice(start, start + 520).trim(),
      scores: { similarity: r3(sim), authority: r3(auth), legalWeight: r3(legal), overall: r3(overall), confidence: r3(conf) },
    };
  }
}

let cached: KnowledgeBase | null = null;
export function kb(): KnowledgeBase {
  if (!cached) {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'corpus.json');
    cached = new KnowledgeBase((JSON.parse(readFileSync(file, 'utf8')) as { rows: KbRow[] }).rows);
  }
  return cached;
}

// ---- deterministic citation verification (RECLAIM services/citation_verification.py) ----
const CSTOP = new Set(['the', 'and', 'for', 'with', 'from', 'under', 'act', 'rule', 'rules', 'of', 'in', 'on', 'to', 'a', 'an', 'or', 'by', 'is', 'are', 'as', 'at', 'this']);

/** A claim is verified if it appears near-verbatim in the source, or >=70% of its distinctive words do. Very short claims pass (too generic to judge). */
export function verifyClaim(claim: string, source: string): boolean {
  if (!claim || !source) return false;
  const src = source.toLowerCase();
  if (src.includes(claim.toLowerCase().trim())) return true;
  const words = (claim.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 3 && !CSTOP.has(w));
  if (words.length < 2) return true;
  return words.filter((w) => src.includes(w)).length / words.length >= 0.7;
}

export const CITE_RE = /\[(kb_[0-9a-f]{14})\]/g;
/** Every [kb_xxx] marker must exist in the corpus AND be in `allowed` (what retrieval actually returned). */
export function checkCitations(text: string, allowed: string[]): { cited: string[]; bad: string[] } {
  const cited = [...new Set([...text.matchAll(CITE_RE)].map((m) => m[1]!))].sort();
  return { cited, bad: cited.filter((c) => !allowed.includes(c) || !kb().byId.has(c)) };
}
