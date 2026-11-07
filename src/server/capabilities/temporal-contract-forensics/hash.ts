import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, no whitespace. Numbers must be finite.
 * Two structurally equal values always produce the same string, so hashes are content addresses.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

export function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** Domain-separated content hash: the tag prevents a hash of one kind of object being replayed as another. */
export function contentHash(tag: string, value: unknown): string { return sha256(`${tag}\n${canonicalJson(value)}`); }

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Structured clone then freeze: callers can never mutate an analysis' inputs afterwards. */
export function frozenCopy<T>(value: T): T { return deepFreeze(structuredClone(value)); }

/** Shallow copy without the given keys. */
export function omit<T extends object>(o: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}
