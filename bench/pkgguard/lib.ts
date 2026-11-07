/**
 * Shared helpers for the package-risk benchmark. Registry JSON responses are cached under bench/pkgguard/.cache
 * (git-ignored) so a re-run reads the same snapshot. Package ARCHIVES are never cached or written to disk.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const CACHE = join(ROOT, '.cache');
export const DATA = join(ROOT, 'data');
export const RESULTS = join(ROOT, 'results');
for (const d of [CACHE, DATA, RESULTS]) mkdirSync(d, { recursive: true });

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
/** Deterministic split: 30% tuning, 70% held-out, by hash of ecosystem + name (never by label). */
export const split = (eco: string, name: string): 'tune' | 'heldout' => (parseInt(sha256(`${eco}:${name}`).slice(0, 8), 16) / 0xffffffff < 0.3 ? 'tune' : 'heldout');

/** Seeded PRNG (mulberry32) so every sample is reproducible from the seed in the report. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function sample<T>(arr: T[], n: number, r: () => number): T[] {
  const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

export interface Fetched { status: number; body: string | null; fetchedAt: string; error?: string }
/** GET with a JSON cache. Network errors are returned as status 0, never thrown. */
export async function getCached(url: string, opts: { accept?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<Fetched> {
  const file = join(CACHE, `${sha256(url + (opts.accept ?? ''))}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Fetched;
  const fetchedAt = new Date().toISOString();
  let res: Fetched;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: opts.accept ?? 'application/json', 'user-agent': 'ripple-pkgguard-bench/1' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (opts.maxBytes && buf.length > opts.maxBytes) res = { status: r.status, body: null, fetchedAt, error: `body ${buf.length} bytes over limit` };
      else res = { status: r.status, body: r.ok ? buf.toString('utf8') : null, fetchedAt };
      if (r.status === 429 || r.status >= 500) { if (attempt < 4) { await new Promise((s) => setTimeout(s, 2000 * 2 ** attempt)); continue; } }
    } catch (e) {
      if (attempt < 3) { await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt)); continue; }
      res = { status: 0, body: null, fetchedAt, error: String((e as Error).message) };
    }
    break;
  }
  if (res.status !== 0) writeFileSync(file, JSON.stringify(res));
  return res;
}

/** Downloads bytes into memory only (used for package archives). Returns null on any failure or over the size cap. */
export async function getBytes(url: string, maxBytes: number): Promise<{ buf: Buffer | null; status: number; error?: string }> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'ripple-pkgguard-bench/1' }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) return { buf: null, status: r.status };
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > maxBytes) return { buf: null, status: r.status, error: `archive ${len} bytes over cap` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) return { buf: null, status: r.status, error: `archive ${buf.length} bytes over cap` };
    return { buf, status: r.status };
  } catch (e) { return { buf: null, status: 0, error: String((e as Error).message) }; }
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>, label = ''): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0; let done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++; out[i] = await fn(items[i], i); done++;
      if (label && done % 250 === 0) console.error(`${label}: ${done}/${items.length}`);
    }
  }));
  return out;
}

/** Data files are written gzipped (data/*.jsonl.gz is committed, so the numbers can be recomputed offline). */
export const writeJsonl = (file: string, rows: unknown[]) => writeFileSync(join(DATA, file + '.gz'), gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { level: 9 }));
export const readJsonl = <T>(file: string): T[] => {
  const gz = join(DATA, file + '.gz');
  const text = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString('utf8') : readFileSync(join(DATA, file), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
};
export const writeResult = (file: string, v: unknown) => writeFileSync(join(RESULTS, file), typeof v === 'string' ? v : JSON.stringify(v, null, 1));
export const npmDocUrl = (name: string) => `https://registry.npmjs.org/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
export const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
