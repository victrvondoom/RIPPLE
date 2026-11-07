import { describe, it, expect } from 'vitest';
import { defaultRegistry, extendedRegistry, PACK_FOLDERS, discoveredPacks } from '../src/server/packs/registry.js';
import { PACK_SYSTEM } from '../src/server/capabilities/catalog.js';
import { DEMO_USERS } from '../src/server/seed.js';

/** Session 19: packs are discovered from their folders; these checks make a lost pack or person impossible to miss. */
describe('pack discovery', () => {
  it('every pack folder produces exactly one registered pack, with unique ids', () => {
    const found = discoveredPacks();
    expect(new Set(found.map((f) => f.folder))).toEqual(new Set(PACK_FOLDERS));
    expect(found.length).toBe(PACK_FOLDERS.length);
    expect(extendedRegistry().all().map((p) => p.id).sort()).toEqual(found.map((f) => f.id).sort());
  });
  it('the default registry is exactly the packs that declare tier core', () => {
    expect(defaultRegistry().all().map((p) => p.id).sort()).toEqual(discoveredPacks().filter((f) => f.tier === 'core').map((f) => f.id).sort());
    expect(defaultRegistry().all().length).toBe(8);
  });
  it('every pack declares its capability system, and the catalog derives from it', () => {
    for (const p of extendedRegistry().all()) { expect(p.system, p.id).toBeDefined(); expect(PACK_SYSTEM[p.id]).toBe(p.system); }
  });
  it('every human role of every pack is mapped to a seeded person', () => {
    const mapped = new Set(DEMO_USERS.flatMap((u) => u.map));
    const orphans = extendedRegistry().all().flatMap((p) => p.roles.filter((r) => r.kind === 'human' && !mapped.has(r.key)).map((r) => `${p.id}/${r.key}`));
    expect(orphans).toEqual([]);
  });
});
