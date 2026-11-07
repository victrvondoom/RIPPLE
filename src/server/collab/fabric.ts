import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CaseRoomsTopology, CollabPort, IdentityStatus, InboundMessage, OpenedCaseRoom, OutboundMessage, RoomInfo, RoomParticipant } from './port.js';
import { SwitchCollab, type SwitchConfig } from './switch.js';

/**
 * Switch FABRIC (session 21): several independently registered Switch agent identities, one connection each.
 *
 * Why: a flagship case is worked by seven agents (coordinator, intake, investigator, SLA/policy, finance arbiter,
 * independent verifier, customer resolution). Each one is a SEPARATE Switch identity with its OWN API key, its own
 * event stream and heartbeat, and its own room memberships, so the Switch server — not RIPPLE — decides what each
 * agent can read and where it can post (least privilege). A message a role produces is posted through THAT role's
 * connection, so the room history shows the real sender assigned by the server.
 *
 * Honest limit (stated in the UI and docs): the role ANALYSIS still executes inside the RIPPLE engine process as
 * deterministic analyzers; what is separate per agent is the Switch identity, credentials, connection and membership.
 *
 * The coordinator identity is the legacy single `SwitchCollab`, so every pack that does not declare case rooms keeps
 * working exactly as before (openRoom / send / subscribe delegate to it).
 */
export interface FabricIdentity { name: string; agentId: string; apiKey: string; roleKeys: string[] }
export interface FabricConfig extends Omit<SwitchConfig, 'agentId' | 'apiKey' | 'selfName'> {
  coordinator: FabricIdentity;
  identities: FabricIdentity[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class SwitchFabric implements CollabPort {
  readonly mode = 'switch' as const;
  readonly label = 'SWITCH (multi-identity)';
  readonly coordinator: SwitchCollab;
  private agents = new Map<string, SwitchCollab>();
  private roleIdentity = new Map<string, string>();
  /** externalRoomId -> identity names that are members (as created by this fabric). */
  private members = new Map<string, string[]>();
  private listeners = new Map<string, () => void>();

  constructor(private cfg: FabricConfig) {
    const mk = (id: FabricIdentity) => new SwitchCollab({ ...cfg, agentId: id.agentId, apiKey: id.apiKey, selfName: id.name, roleAgents: cfg.roleAgents });
    this.coordinator = mk(cfg.coordinator);
    this.agents.set(cfg.coordinator.name, this.coordinator);
    for (const k of cfg.coordinator.roleKeys) this.roleIdentity.set(k, cfg.coordinator.name);
    for (const id of cfg.identities) {
      if (!this.agents.has(id.name)) this.agents.set(id.name, mk(id));
      for (const k of id.roleKeys) this.roleIdentity.set(k, id.name);
    }
  }

  identityForRole(roleKey: string | undefined): string | null { return roleKey ? this.roleIdentity.get(roleKey) ?? null : null; }
  identityNames(): string[] { return [...this.agents.keys()]; }
  collabFor(name: string): SwitchCollab | undefined { return this.agents.get(name); }

  describe() {
    const st = this.identities();
    const up = st.filter((s) => s.connected).length;
    return { mode: 'switch', connected: up > 0, detail: `Switch bridge ${this.cfg.bridgeUrl}; ${st.length} registered identities, ${up} with a live stream and heartbeat${st.some((s) => s.lastError) ? `; errors: ${st.filter((s) => s.lastError).map((s) => `${s.name}: ${s.lastError}`).join(' | ').slice(0, 300)}` : ''}` };
  }
  identities(): IdentityStatus[] {
    return [...this.agents.entries()].map(([name, c]) => {
      const s = c.status();
      return { name, roleKeys: [...this.roleIdentity.entries()].filter(([, n]) => n === name).map(([k]) => k), connected: s.connected, rooms: s.rooms, lastError: s.lastError, lastBeatOkAt: s.lastBeatOkAt };
    });
  }

  // ---------- legacy single-room path (every non-flagship pack) ----------
  openRoom(a: Parameters<CollabPort['openRoom']>[0]) { return this.coordinator.openRoom(a); }

  /** Picks the identity that posts: the sender role's own identity when it is a member of the room, otherwise a member. */
  private poster(roomId: string, senderKey?: string): { collab: SwitchCollab; relayed: boolean; as: string } | null {
    const mem = this.members.get(roomId);
    if (!mem) return { collab: this.coordinator, relayed: false, as: this.coordinator.name };   // legacy room
    const own = this.identityForRole(senderKey);
    if (own && mem.includes(own)) return { collab: this.agents.get(own)!, relayed: false, as: own };
    const fallback = mem.includes(this.coordinator.name) ? this.coordinator.name : mem[0];
    return fallback ? { collab: this.agents.get(fallback)!, relayed: !!own, as: fallback } : null;
  }
  async send(room: RoomInfo, msg: OutboundMessage) {
    if (!room.externalId) return;
    const p = this.poster(room.externalId, msg.senderKey);
    if (!p) throw new Error(`No RIPPLE identity is a member of Switch room ${room.externalId}; nothing posted.`);
    const body = p.relayed ? { ...msg, body: `(relayed by ${p.as}; ${this.identityForRole(msg.senderKey)} is not a member of this room) ${msg.body}` } : msg;
    await p.collab.send(room, body);
  }

  /** One listener per room: the coordinator when it is a member, else the first member identity (only members hear a room). */
  subscribe(room: RoomInfo, handler: (m: InboundMessage) => void) {
    const id = room.externalId!; const mem = this.members.get(id);
    const listenerName = !mem ? this.coordinator.name : mem.includes(this.coordinator.name) ? this.coordinator.name : mem[0]!;
    const c = this.agents.get(listenerName)!;
    const off = c.subscribe(room, (im) => handler({ ...im, receivedBy: listenerName }));
    this.listeners.set(id, off);
    return () => { off(); this.listeners.delete(id); };
  }

  // ---------- flagship case topology ----------
  /**
   * Creates every room of the declared topology on the Switch server (via the coordinator identity), with exactly the
   * declared agent members (+ invited people on bridged rooms), private visibility for restricted rooms, and links to the
   * rooms created before it. Then each member identity opens its own stream and claims the room with its own key.
   * THROWS on the first failure: a room the server did not create is never reported as created.
   */
  async openCaseRooms(args: { missionId: string; caseRef: string; title: string; topology: CaseRoomsTopology; humans: Record<string, string[]> }): Promise<{ rooms: OpenedCaseRoom[]; labels: string[] }> {
    const labels: string[] = []; const out: OpenedCaseRoom[] = [];
    const missing = [...new Set(args.topology.rooms.flatMap((r) => r.agentRoles))].filter((k) => !this.identityForRole(k));
    if (missing.length) throw new Error(`No registered Switch identity for role(s): ${missing.join(', ')} (data/switch-agents.local.json). Refusing to build a case topology with impersonated agents.`);
    // The rooms are created by the topology's coordinator role identity (e.g. the Incident Coordinator), not by RIPPLE's legacy agent.
    const creatorName = this.identityForRole(args.topology.coordinatorRole) ?? this.coordinator.name;
    const creator = this.agents.get(creatorName)!;
    labels.push(`Rooms created by ${creatorName} (create_room with its own API key).`);
    for (const spec of args.topology.rooms) {
      const memberNames = [...new Set(spec.agentRoles.map((k) => this.identityForRole(k)!))];
      const links = (spec.links ?? []).map((k) => out.find((r) => r.key === k)).filter((r): r is OpenedCaseRoom => !!r && !!r.externalId).map((r) => ({ target_room_id: r.externalId!, label: r.key }));
      const humans = this.cfg.internalOnly ? [] : (args.humans[spec.key] ?? []);
      const created = await creator.createCaseRoom({
        name: `${spec.name}-${args.caseRef}`, description: `${spec.purpose} — case ${args.caseRef}: ${args.title}`.slice(0, 400), agentNames: memberNames,
        instructions: `${spec.instructions}\n\nCase ${args.caseRef}. RIPPLE holds the authoritative case state. Approvals count only from the authenticated Switch person bound to the approver role, quoting the exact payload SHA-256. Agents never approve.`,
        linkedRooms: links, userNames: humans, restricted: spec.sensitivity === 'restricted', attach: false,
      });
      if (!created.id) throw new Error(`create_room for ${spec.name} returned no room id`);
      this.members.set(created.id, memberNames);
      for (const n of memberNames) await this.agents.get(n)!.attachRoom(created.id);   // each identity connects with its own key (throws if refused)
      out.push({ key: spec.key, externalId: created.id, name: created.name, note: `Switch room (${this.cfg.internalOnly ? 'agent-only, no chat bridge' : 'bridged'}${spec.sensitivity === 'restricted' ? ', private visibility' : ''}); members: ${memberNames.join(', ')}${humans.length ? `; people: ${humans.join(', ')}` : ''}`, members: memberNames, humans, linkedTo: links.map((l) => l.target_room_id), mode: 'switch' });
    }
    if (this.cfg.internalOnly) labels.push('SWITCH_INTERNAL_ONLY=1: rooms are agent-only; no person can post in them, so no Switch human decision can arrive in this run.');
    return { rooms: out, labels };
  }

  /** Registers rooms the fabric did not create (e.g. after a restart), so posting/listening uses the right identities. */
  adoptRoom(externalId: string, memberNames: string[]) { this.members.set(externalId, memberNames); }

  private reader(roomId: string): SwitchCollab {
    const mem = this.members.get(roomId);
    const n = !mem ? this.coordinator.name : mem.includes(this.coordinator.name) ? this.coordinator.name : mem[0]!;
    return this.agents.get(n)!;
  }
  async listParticipants(room: RoomInfo): Promise<RoomParticipant[]> {
    if (!room.externalId) return [];
    return this.reader(room.externalId).listRoomParticipants(room.externalId);
  }
  async writeDocument(room: RoomInfo, doc: { name: string; description: string; instructions: string; content: string }, asRoleKey?: string) {
    if (!room.externalId) return { documentId: null, readBackHash: null, note: 'not a Switch room' };
    const p = this.poster(room.externalId, asRoleKey) ?? { collab: this.reader(room.externalId), relayed: false, as: '' };
    const r = await p.collab.createRoomDocument(room.externalId, doc);
    let readBackHash: string | null = null; let note = `create_room_document by ${p.collab.name} → ${r.document_id}`;
    try {
      const docs = await p.collab.loadInternalDocuments(room.externalId, [r.document_id]);
      const found = (Array.isArray(docs) ? docs : []).find((d: any) => d?.document_id === r.document_id || d?.id === r.document_id || d?.name === doc.name);
      const content = found?.content ?? found?.text ?? null;
      readBackHash = typeof content === 'string' ? sha(content) : null;
      note += readBackHash ? `; load_internal_documents read back ${readBackHash === sha(doc.content) ? 'IDENTICAL content' : 'DIFFERENT content'}` : '; load_internal_documents returned no content for that id';
    } catch (e) { note += `; read-back failed: ${String((e as Error).message).slice(0, 120)}`; }
    return { documentId: r.document_id ?? null, readBackHash, note };
  }
  async history(room: RoomInfo, limit = 100) { return room.externalId ? this.reader(room.externalId).roomHistory(room.externalId, limit) : []; }

  /** Preflight helpers (see preflight.ts). */
  health() { return this.coordinator.health(); }
  listBridges() { return this.coordinator.listBridges(); }
  async contextOf(name: string) { const c = this.agents.get(name); if (!c) throw new Error(`unknown identity ${name}`); return c.myContext(); }

  async close() { for (const c of this.agents.values()) await c.close(); }
}

/**
 * Builds a fabric from data/switch-agents.local.json (written by scripts/switch-register.mjs: {name: {id, apiKey, role}})
 * and the coordinator SWITCH_* variables. Returns null when there is no Switch configuration at all.
 * Identities are matched to pack roles by the `role` recorded at registration (comma-separated keys allowed).
 */
export function fabricConfigFromEnv(env: NodeJS.ProcessEnv, base: SwitchConfig | null): FabricConfig | null {
  if (!base) return null;
  const file = env.SWITCH_AGENTS_FILE ?? 'data/switch-agents.local.json';
  const saved: Record<string, { id: string; apiKey: string; role?: string | null }> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const identities: FabricIdentity[] = Object.entries(saved).filter(([n, v]) => v?.id && v?.apiKey && n !== base.selfName).map(([name, v]) => ({ name, agentId: v.id, apiKey: v.apiKey, roleKeys: String(v.role ?? '').split(',').map((s) => s.trim()).filter(Boolean) }));
  const coordRoles = String(saved[base.selfName ?? '']?.role ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const { agentId, apiKey, selfName, ...rest } = base;
  return { ...rest, coordinator: { name: selfName ?? 'ripple', agentId, apiKey, roleKeys: coordRoles }, identities };
}
