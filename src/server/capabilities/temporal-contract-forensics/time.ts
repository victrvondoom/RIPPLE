/**
 * Exact instant handling. Instants are integer milliseconds since the Unix epoch (UTC).
 * Only ISO-8601 strings with an explicit offset are accepted: a bare local time is ambiguous and is rejected.
 */

export class TcfInputError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'TcfInputError'; }
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value: unknown, field: string): number {
  if (typeof value !== 'string') throw new TcfInputError('INVALID_INSTANT', `${field} must be an ISO-8601 string with offset`);
  const m = ISO_RE.exec(value);
  if (!m) throw new TcfInputError('INVALID_INSTANT', `${field} "${value}" is not ISO-8601 with an explicit offset (Z or ±hh:mm)`);
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = Number(m[6] ?? 0);
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) throw new TcfInputError('INVALID_INSTANT', `${field} "${value}" has an out-of-range field`);
  const base = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(base);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new TcfInputError('INVALID_INSTANT', `${field} "${value}" is not a real calendar date`);
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const sign = m[8]!.startsWith('-') ? -1 : 1;
    const oh = Number(m[8]!.slice(1, 3)); const om = Number(m[8]!.slice(4, 6));
    if (oh > 23 || om > 59) throw new TcfInputError('INVALID_INSTANT', `${field} "${value}" has an invalid offset`);
    offsetMin = sign * (oh * 60 + om);
  }
  return base - offsetMin * 60_000;
}

export function formatInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
}

/** "26m 30s", "1h 02m 00s", "450ms", "0s". Exact: never rounds. */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  const sign = ms < 0 ? '-' : ''; let r = Math.abs(ms);
  const h = Math.floor(r / 3_600_000); r -= h * 3_600_000;
  const m = Math.floor(r / 60_000); r -= m * 60_000;
  const s = Math.floor(r / 1000); const milli = r - s * 1000;
  const sec = milli ? `${s}.${String(milli).padStart(3, '0')}s` : `${s}s`;
  if (h) return `${sign}${h}h ${String(m).padStart(2, '0')}m ${sec.padStart(milli ? 6 : 3, '0')}`;
  if (m) return `${sign}${m}m ${sec.padStart(milli ? 6 : 3, '0')}`;
  return `${sign}${sec}`;
}

export function assertTimeZone(tz: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); } catch { throw new TcfInputError('INVALID_TIME_ZONE', `unknown IANA time zone "${tz}"`); }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wallClock(utcMs: number, tz: string): number {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(utcMs))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!, ((utcMs % 1000) + 1000) % 1000);
}

/** UTC offset of `tz` at instant `utcMs`, in ms (local = utc + offset). */
export function zoneOffsetMs(utcMs: number, tz: string): number { return wallClock(utcMs, tz) - utcMs; }

/**
 * The UTC instant of a local wall-clock time in `tz`. A local time that does not exist (DST gap) resolves
 * forward to the first instant after the gap; an ambiguous local time (DST overlap) resolves to the earlier one.
 */
export function zonedToUtc(y: number, month1: number, d: number, h: number, mi: number, tz: string): number {
  assertTimeZone(tz);
  const local = Date.UTC(y, month1 - 1, d, h, mi, 0, 0);
  const candidates = new Set<number>();
  for (const probe of [local - 36 * 3_600_000, local, local + 36 * 3_600_000]) candidates.add(local - zoneOffsetMs(probe, tz));
  const exact = [...candidates].filter((u) => wallClock(u, tz) === local).sort((a, b) => a - b);
  if (exact.length) return exact[0]!;
  // Gap: the earliest instant whose wall clock is after `local`.
  let lo = local - 36 * 3_600_000; let hi = local + 36 * 3_600_000;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (wallClock(mid, tz) >= local) hi = mid; else lo = mid; }
  return hi;
}

/** [start, end) of calendar month "YYYY-MM" in `tz`, as UTC milliseconds. */
export function calendarMonthWindow(month: string, tz: string): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new TcfInputError('INVALID_MONTH', `calendarMonth "${month}" must be YYYY-MM`);
  const y = Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new TcfInputError('INVALID_MONTH', `calendarMonth "${month}" has an invalid month`);
  const start = zonedToUtc(y, mo, 1, 0, 0, tz);
  const end = mo === 12 ? zonedToUtc(y + 1, 1, 1, 0, 0, tz) : zonedToUtc(y, mo + 1, 1, 0, 0, tz);
  return [start, end];
}

/** The calendar month (in `tz`) that [start, end) exactly spans, or null. */
export function monthSpanned(start: number, end: number, tz: string): string | null {
  const local = new Date(wallClock(start, tz));
  const month = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  const [s, e] = calendarMonthWindow(month, tz);
  return s === start && e === end ? month : null;
}

export function isSafeMs(n: unknown): n is number { return typeof n === 'number' && Number.isSafeInteger(n); }
