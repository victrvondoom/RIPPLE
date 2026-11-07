import type { WorkflowPack } from '../engine/types.js';
import { beoPack } from './beo/pack.js';
import { sceneShiftPack } from './sceneshift/pack.js';
import { scopeGuardPack } from './scopeguard/pack.js';
import { invoiceGuardPack } from './invoiceguard/pack.js';
import { shiftRelayPack } from './shiftrelay/pack.js';
import { moveMatePack } from './movemate/pack.js';
import { podFlowPack } from './podflow/pack.js';
import { submitReadyPack } from './submitready/pack.js';
import { sentinelPack } from './sentinel/pack.js';
import { schemacourtPack } from './schemacourt/pack.js';
import { clearsendPack } from './clearsend/pack.js';
import { crewpilotPack } from './crewpilot/pack.js';
import { offerroomPack } from './offerroom/pack.js';
import { revenuePack } from './revenue/pack.js';
import { consumerPack } from './consumer/pack.js';
import { billingPack } from './billing/pack.js';
import { depgatePack } from './depgate/pack.js';

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
  return new PackRegistry()
    .register(beoPack)
    .register(sceneShiftPack)
    .register(scopeGuardPack)
    .register(invoiceGuardPack)
    .register(shiftRelayPack)
    .register(moveMatePack)
    .register(podFlowPack)
    .register(submitReadyPack);
}

export function extendedRegistry() {
  return defaultRegistry()
    .register(sentinelPack)
    .register(schemacourtPack)
    .register(clearsendPack)
    .register(crewpilotPack)
    .register(offerroomPack)
    .register(revenuePack)
    .register(consumerPack)
    .register(billingPack)
    .register(depgatePack)

}
