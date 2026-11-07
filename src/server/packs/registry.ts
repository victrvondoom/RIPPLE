import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkflowPack } from '../engine/types.js';

/**
 * Session 19: packs are DISCOVERED, not listed. Every folder under src/server/packs/ with a pack.ts (or compiled pack.js)
 * is imported once at start-up and each exported WorkflowPack object is registered. A pack declares its own tier
 * ('core' = default registry) and capability system. Two merges in a row silently dropped hand-written `.register()`
 * lines (13 then 28 failing tests); with discovery a pack cannot go missing, and `tests/registry.test.ts` checks that
 * every pack folder produced a registered pack.
 */
const isPack = (v: unknown): v is WorkflowPack =>
  !!v && typeof v === 'object' && typeof (v as WorkflowPack).id === 'string' && Array.isArray((v as WorkflowPack).roles) && typeof (v as WorkflowPack).analyzeRole === 'function';

const PACK_DIR = dirname(fileURLToPath(import.meta.url));
export const PACK_FOLDERS: string[] = readdirSync(PACK_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && (existsSync(join(PACK_DIR, e.name, 'pack.ts')) || existsSync(join(PACK_DIR, e.name, 'pack.js'))))
  .map((e) => e.name).sort();
const DISCOVERED: { folder: string; pack: WorkflowPack }[] = [];
for (const folder of PACK_FOLDERS) {
  const file = existsSync(join(PACK_DIR, folder, 'pack.ts')) ? join(PACK_DIR, folder, 'pack.ts') : join(PACK_DIR, folder, 'pack.js');
  const mod = await import(pathToFileURL(file).href) as Record<string, unknown>;
  const packs = Object.values(mod).filter(isPack);
  if (packs.length === 0) throw new Error(`packs/${folder}/pack exports no WorkflowPack`);
  for (const pack of packs) DISCOVERED.push({ folder, pack });
}
/** Every discovered pack with the folder it came from (used by tests and the packs API). */
export const discoveredPacks = () => DISCOVERED.map((d) => ({ folder: d.folder, id: d.pack.id, tier: d.pack.tier ?? 'extended' }));

export interface PackListing { id: string; name: string; domain: string; status: 'implemented' | 'planned'; tagline: string }
const PLANNED: PackListing[] = [];

export class PackRegistry {
  private packs = new Map<string, WorkflowPack>();
  register(p: WorkflowPack) { if (this.packs.has(p.id)) throw new Error(`duplicate pack ${p.id}`); this.packs.set(p.id, p); return this; }
  get(id: string) { return this.packs.get(id); }
  all() { return [...this.packs.values()]; }
  listings(): PackListing[] {
    const impl = this.all().map((p) => ({ id: p.id, name: p.name, domain: p.domain, status: 'implemented' as const, tagline: p.description }));
    return [...impl, ...PLANNED.filter((x) => !this.packs.has(x.id))];
  }
}
export function defaultRegistry() {
  const r = new PackRegistry();
  for (const d of DISCOVERED) if (d.pack.tier === 'core') r.register(d.pack);
  return r;
}

export function extendedRegistry() {
  const r = defaultRegistry();
  for (const d of DISCOVERED) if (d.pack.tier !== 'core') r.register(d.pack);
  return r;
}
