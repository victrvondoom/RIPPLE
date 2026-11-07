/**
 * In-memory archive reader for package files (.tgz / .tar.gz / .zip / .whl). Nothing is written to disk, extracted,
 * imported or executed: entries are returned as byte buffers and only text-like entries are decoded for scanning.
 * Hard limits stop decompression bombs and oversized entries; anything skipped is listed with its reason.
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';

export const ARCHIVE_LIMITS = { maxUnpackedBytes: 200 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024, maxEntries: 20000 } as const;
export interface ArchiveEntry { path: string; data: Buffer }
export interface ArchiveRead { entries: ArchiveEntry[]; skipped: { path: string; reason: string }[]; format: 'tar' | 'zip' | 'unknown' }

function cstr(b: Buffer, off: number, len: number) { const s = b.subarray(off, off + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); }
function octal(b: Buffer, off: number, len: number) { const s = cstr(b, off, len).trim(); return s ? parseInt(s, 8) : 0; }

export function readTar(buf: Buffer): ArchiveRead {
  const out: ArchiveRead = { entries: [], skipped: [], format: 'tar' };
  let off = 0; let longName: string | null = null; let paxPath: string | null = null;
  while (off + 512 <= buf.length && out.entries.length + out.skipped.length < ARCHIVE_LIMITS.maxEntries) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12); const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155); let name = cstr(h, 0, 100); if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + 512; const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    const path = paxPath ?? longName ?? name; paxPath = null; longName = null;
    if (type !== '0' && type !== '\0' && type !== '7') { if (type === '1' || type === '2') out.skipped.push({ path, reason: 'link entry' }); continue; }
    if (size > ARCHIVE_LIMITS.maxEntryBytes) { out.skipped.push({ path, reason: `entry larger than ${ARCHIVE_LIMITS.maxEntryBytes} bytes` }); continue; }
    out.entries.push({ path, data: Buffer.from(data) });
  }
  return out;
}

type Limits = { maxUnpackedBytes: number; maxEntryBytes: number; maxEntries: number };
/** Streams zip entries one at a time (so a 200 MB bulk export never sits fully unpacked in memory). */
export function* zipEntries(buf: Buffer, limits: Limits = ARCHIVE_LIMITS): Generator<ArchiveEntry | { path: string; skipped: string }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { yield { path: '(archive)', skipped: 'no end-of-central-directory record' }; return; }
  let count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); let total = 0;
  // Zip64: the 16/32-bit fields are saturated; the real values sit in the zip64 end record named by the locator.
  if ((count === 0xffff || p === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(eocd - 12));
    if (buf.readUInt32LE(z) === 0x06064b50) { count = Number(buf.readBigUInt64LE(z + 32)); p = Number(buf.readBigUInt64LE(z + 48)); }
  }
  for (let n = 0; n < count && n < limits.maxEntries && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42); const path = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (path.endsWith('/')) continue;
    if (usize > limits.maxEntryBytes || csize === 0xffffffff) { yield { path, skipped: 'entry too large or zip64' }; continue; }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) { yield { path, skipped: 'bad local header' }; continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer | null;
    try { data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes }) : null; }
    catch { yield { path, skipped: 'could not inflate' }; continue; }
    if (!data) { yield { path, skipped: `compression method ${method}` }; continue; }
    total += data.length; if (total > limits.maxUnpackedBytes) { yield { path, skipped: 'archive unpacked size limit reached' }; return; }
    yield { path, data };
  }
}

export function readZip(buf: Buffer, limits: Limits = ARCHIVE_LIMITS): ArchiveRead {
  const out: ArchiveRead = { entries: [], skipped: [], format: 'zip' };
  for (const e of zipEntries(buf, limits)) {
    if ('skipped' in e) { if (e.path === '(archive)') out.format = 'unknown'; out.skipped.push({ path: e.path, reason: e.skipped }); }
    else out.entries.push(e);
  }
  return out;
}

/** Detects the format from magic bytes: gzip (then tar), zip, or plain tar. */
export function readArchive(buf: Buffer): ArchiveRead {
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return readTar(gunzipSync(buf, { maxOutputLength: ARCHIVE_LIMITS.maxUnpackedBytes })); }
    catch { return { entries: [], skipped: [{ path: '(archive)', reason: 'gzip could not be decoded or exceeded the size limit' }], format: 'unknown' }; }
  }
  if (buf.readUInt32LE(0) === 0x04034b50) return readZip(buf);
  if (buf.length > 262 && buf.subarray(257, 262).toString() === 'ustar') return readTar(buf);
  return { entries: [], skipped: [{ path: '(archive)', reason: 'unrecognised archive format' }], format: 'unknown' };
}

const TEXT_EXT = /\.(?:[cm]?js|jsx|ts|tsx|json|py|pyw|pyi|sh|bash|ps1|bat|cmd|vbs|md|markdown|txt|rst|cfg|toml|ini|ya?ml|html?|pth|php|rb|pl|lua|gyp|in)$/i;
/** Decodes an entry as text when it is text-like and has no NUL byte in its first 8 KiB. */
export function asText(e: ArchiveEntry): string | null {
  const base = e.path.split('/').pop() ?? '';
  if (!TEXT_EXT.test(base) && !/^(?:setup|PKG-INFO|METADATA|Makefile|README|LICENSE|binding)/i.test(base)) return null;
  if (e.data.subarray(0, 8192).includes(0)) return null;
  return e.data.toString('utf8');
}
