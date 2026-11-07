import type { Context, Hono } from 'hono';
import type { Actor, Engine } from '../engine/engine.js';
import { STATE_LABEL } from '../engine/states.js';

/**
 * Workspace memory graph (session 20). One connected graph built from recorded rows only: workflows, missions, people,
 * agents, decisions (answered questions and decided approvals) and actions. The API never returns the whole graph:
 * it returns a FOCUS node with its neighbourhood (two hops, capped), so the UI can walk from node to node. `q` finds
 * nodes by text ("Noor", "rollback", "package") so a person can say what they want and the graph moves there.
 */
type Env = { Variables: { actor: Actor } };
export interface MemNode { id: string; type: 'workflow' | 'mission' | 'person' | 'agent' | 'decision' | 'action'; label: string; sub: string; facts: [string, string][] }
export interface MemEdge { from: string; to: string; label: string }

export function buildMemory(engine: Engine, ws: string) {
  const db = engine.db; const nodes = new Map<string, MemNode>(); const edges: MemEdge[] = [];
  const add = (n: MemNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const link = (from: string, to: string, label: string) => { if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, label }); };
  const users = db.all('SELECT id, name, role, title, department FROM users WHERE workspace_id=?', ws);
  for (const u of users) add({ id: `person:${u.id}`, type: 'person', label: u.name, sub: `${u.title ?? ''} · ${u.role}`, facts: [['Role', u.role], ['Department', u.department ?? '—']] });
  const missions = db.all('SELECT id, title, state, pack_id, created_at, updated_at FROM missions WHERE workspace_id=?', ws);
  const usedPacks = new Set(missions.map((m) => m.pack_id));
  for (const p of engine.packs.all()) if (usedPacks.has(p.id)) add({ id: `workflow:${p.id}`, type: 'workflow', label: p.name, sub: p.domain, facts: [['Domain', p.domain], ['Missions', String(missions.filter((m) => m.pack_id === p.id).length)]] });
  for (const r of db.all("SELECT pack_id, key, name, kind, user_id FROM agent_roles WHERE workspace_id=?", ws)) {
    if (!usedPacks.has(r.pack_id)) continue;
    if (r.kind === 'agent') { add({ id: `agent:${r.pack_id}:${r.key}`, type: 'agent', label: r.name, sub: engine.packs.get(r.pack_id)?.name ?? r.pack_id, facts: [['Workflow', engine.packs.get(r.pack_id)?.name ?? r.pack_id]] }); link(`agent:${r.pack_id}:${r.key}`, `workflow:${r.pack_id}`, 'works in'); }
    else if (r.user_id) link(`person:${r.user_id}`, `workflow:${r.pack_id}`, `is ${r.name}`);
  }
  for (const m of missions) {
    add({ id: `mission:${m.id}`, type: 'mission', label: m.title, sub: STATE_LABEL[m.state as keyof typeof STATE_LABEL] ?? m.state, facts: [['State', STATE_LABEL[m.state as keyof typeof STATE_LABEL] ?? m.state], ['Workflow', engine.packs.get(m.pack_id)?.name ?? m.pack_id], ['Updated', m.updated_at]] });
    link(`mission:${m.id}`, `workflow:${m.pack_id}`, 'runs on');
  }
  for (const q of db.all("SELECT id, mission_id, key, text, status, answer, answered_by, answered_at, assignee_user_id FROM questions WHERE workspace_id=?", ws)) {
    const id = `decision:q:${q.id}`;
    add({ id, type: 'decision', label: q.text.length > 70 ? `${q.text.slice(0, 68)}…` : q.text, sub: q.status === 'answered' ? `answered: ${String(q.answer ?? '').slice(0, 40)}` : 'waiting for an answer', facts: [['Question', q.text], ['Status', q.status], ['Answer', q.answer ?? '—'], ['Answered at', q.answered_at ?? '—']] });
    link(id, `mission:${q.mission_id}`, 'decides for');
    if (q.answered_by) link(`person:${q.answered_by}`, id, 'answered'); else if (q.assignee_user_id) link(`person:${q.assignee_user_id}`, id, 'must answer');
  }
  for (const ap of db.all("SELECT id, mission_id, title, status, decided_by, decided_at, decision_note, approver_user_id FROM approvals WHERE workspace_id=? AND status IN ('pending','approved','rejected')", ws)) {
    const id = `decision:a:${ap.id}`;
    add({ id, type: 'decision', label: ap.title, sub: ap.status, facts: [['Approval', ap.title], ['Status', ap.status], ['Note', ap.decision_note ?? '—'], ['Decided at', ap.decided_at ?? '—']] });
    link(id, `mission:${ap.mission_id}`, 'approves for');
    if (ap.decided_by) link(`person:${ap.decided_by}`, id, ap.status); else if (ap.approver_user_id) link(`person:${ap.approver_user_id}`, id, 'must decide');
  }
  for (const a of db.all("SELECT ac.id, ac.mission_id, ac.title, ac.status, ac.owner_role, ac.connector, m.pack_id FROM actions ac JOIN missions m ON m.id = ac.mission_id WHERE ac.workspace_id=? AND ac.status NOT IN ('stale','superseded')", ws)) {
    const id = `action:${a.id}`;
    add({ id, type: 'action', label: a.title, sub: a.status, facts: [['Action', a.title], ['Status', a.status], ['Connector', a.connector]] });
    link(id, `mission:${a.mission_id}`, 'part of'); link(`agent:${a.pack_id}:${a.owner_role}`, id, 'proposed');
  }
  return { nodes, edges };
}

/** The focus node, its neighbours and their neighbours (capped), plus text matches. */
export function memoryView(engine: Engine, ws: string, focus: string | null, q: string | null, cap = 70) {
  const { nodes, edges } = buildMemory(engine, ws);
  const adj = new Map<string, MemEdge[]>();
  for (const e of edges) { (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e); (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e); }
  const terms = (q ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const score = (n: MemNode) => terms.reduce((s, t) => s + (n.label.toLowerCase().includes(t) ? 3 : 0) + (n.sub.toLowerCase().includes(t) ? 1 : 0) + (n.type.includes(t) ? 1 : 0), 0);
  const matches = terms.length ? [...nodes.values()].map((n) => ({ n, s: score(n) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || (adj.get(b.n.id)?.length ?? 0) - (adj.get(a.n.id)?.length ?? 0)).slice(0, 12).map((x) => x.n) : [];
  // Default focus: the most recently updated mission (a readable neighbourhood), else the most connected node.
  const latest = engine.db.get('SELECT id FROM missions WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 1', ws);
  const most = (latest && nodes.get(`mission:${latest.id}`)) || [...nodes.values()].sort((a, b) => (adj.get(b.id)?.length ?? 0) - (adj.get(a.id)?.length ?? 0))[0];
  const centre = (focus && nodes.get(focus)) || matches[0] || most || [...nodes.values()][0] || null;
  if (!centre) return { focus: null, nodes: [], edges: [], matches: [], totals: { nodes: 0, edges: 0 } };
  // Ring 1: direct neighbours, most connected first (at most 24). Ring 2: their neighbours (at most `cap` in total).
  const deg = (id: string) => adj.get(id)?.length ?? 0;
  const ring1 = [...new Set((adj.get(centre.id) ?? []).map((e) => (e.from === centre.id ? e.to : e.from)))].sort((a, b) => deg(b) - deg(a));
  const keep = new Map<string, number>([[centre.id, 0]]);
  for (const id of ring1.slice(0, 24)) keep.set(id, 1);
  for (const id of ring1.slice(0, 24)) for (const e of adj.get(id) ?? []) { const o = e.from === id ? e.to : e.from; if (keep.size >= cap) break; if (!keep.has(o)) keep.set(o, 2); }
  return {
    focus: centre.id, hiddenNeighbours: Math.max(0, ring1.length - 24),
    nodes: [...keep.entries()].map(([id, depth]) => ({ ...nodes.get(id)!, depth, degree: adj.get(id)?.length ?? 0 })),
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    matches: matches.map((n) => ({ id: n.id, type: n.type, label: n.label, sub: n.sub })),
    totals: { nodes: nodes.size, edges: edges.length },
  };
}

export function registerMemoryRoutes(app: Hono<Env>, engine: Engine) {
  const A = (c: Context<Env>) => c.get('actor');
  app.get('/api/memory/graph', (c) => c.json(memoryView(engine, A(c).workspaceId, c.req.query('focus') ?? null, c.req.query('q') ?? null)));
}
