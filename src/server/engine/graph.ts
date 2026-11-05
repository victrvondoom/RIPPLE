import type { ArtifactDef, ChangeItem, WorkflowPack } from './types.js';

export interface GraphNodeSpec { key: string; kind: 'change' | 'artifact' | 'department' | 'owner' | 'decision'; label: string; data?: Record<string, unknown> }
export interface GraphEdgeSpec { from: string; to: string; relation: string; why?: string }
export interface ImpactGraph {
  nodes: GraphNodeSpec[]; edges: GraphEdgeSpec[];
  impactedArtifacts: string[]; checkedNotAffected: string[]; departments: string[];
}

/**
 * Builds the impact graph from a pack's declarative dependency model:
 *   change item --rule--> artifact --artifactEdge--> artifact --> department --> owner role
 * Only nodes actually reached from a real change item are instantiated (no generic checklist).
 * Decisions are attached when any gated artifact is impacted.
 */
export function buildImpactGraph(pack: WorkflowPack, items: ChangeItem[]): ImpactGraph {
  const nodes = new Map<string, GraphNodeSpec>();
  const edges: GraphEdgeSpec[] = [];
  const artifactByKey = new Map(pack.artifacts.map((a) => [a.key, a]));
  const roleName = (k: string) => pack.roles.find((r) => r.key === k)?.name ?? k;
  const reached = new Set<string>();
  const queue: string[] = [];

  items.forEach((it, i) => {
    const ck = `change:${it.field}`;
    nodes.set(ck, { key: ck, kind: 'change', label: `${it.label}: ${fmt(it.before)} → ${fmt(it.after)}`, data: { index: i, severity: it.severity } });
    for (const rule of pack.rules) {
      if (!rule.trigger(it)) continue;
      edges.push({ from: ck, to: `artifact:${rule.to}`, relation: rule.relation, why: rule.why });
      if (!reached.has(rule.to)) { reached.add(rule.to); queue.push(rule.to); }
    }
  });
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of pack.artifactEdges.filter((x) => x.from === cur)) {
      edges.push({ from: `artifact:${e.from}`, to: `artifact:${e.to}`, relation: e.relation, why: e.why });
      if (!reached.has(e.to)) { reached.add(e.to); queue.push(e.to); }
    }
  }
  const depts = new Set<string>();
  for (const key of reached) {
    const a = artifactByKey.get(key) as ArtifactDef;
    nodes.set(`artifact:${key}`, { key: `artifact:${key}`, kind: 'artifact', label: a.label, data: { department: a.department, ownerRole: a.ownerRole, description: a.description } });
    depts.add(a.department);
    nodes.set(`department:${a.department}`, { key: `department:${a.department}`, kind: 'department', label: a.department });
    edges.push({ from: `artifact:${key}`, to: `department:${a.department}`, relation: 'handled_by' });
    nodes.set(`owner:${a.ownerRole}`, { key: `owner:${a.ownerRole}`, kind: 'owner', label: roleName(a.ownerRole), data: { roleKey: a.ownerRole } });
    edges.push({ from: `department:${a.department}`, to: `owner:${a.ownerRole}`, relation: 'owned_by' });
  }
  for (const d of pack.decisions) {
    const gated = d.gates.filter((g) => reached.has(g));
    if (!gated.length) continue;
    nodes.set(`decision:${d.key}`, { key: `decision:${d.key}`, kind: 'decision', label: d.label, data: { ownerRole: d.ownerRole } });
    for (const g of gated) edges.push({ from: `artifact:${g}`, to: `decision:${d.key}`, relation: 'needs_decision' });
    nodes.set(`owner:${d.ownerRole}`, { key: `owner:${d.ownerRole}`, kind: 'owner', label: roleName(d.ownerRole), data: { roleKey: d.ownerRole } });
    edges.push({ from: `decision:${d.key}`, to: `owner:${d.ownerRole}`, relation: 'decided_by' });
  }
  return {
    nodes: [...nodes.values()], edges,
    impactedArtifacts: [...reached],
    checkedNotAffected: pack.artifacts.filter((a) => !reached.has(a.key)).map((a) => a.key),
    departments: [...depts],
  };
}

/** Downstream closure from a start node over stored edges (used by the Work Graph UI to highlight consequences). */
export function downstream(edges: { from_node: string; to_node: string }[], startIds: string[]): Set<string> {
  const out = new Set<string>(startIds);
  const q = [...startIds];
  while (q.length) {
    const c = q.shift()!;
    for (const e of edges) if (e.from_node === c && !out.has(e.to_node)) { out.add(e.to_node); q.push(e.to_node); }
  }
  return out;
}
const fmt = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
