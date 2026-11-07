/**
 * Collaboration boundary. The mission engine only knows this interface.
 * Implementations: LocalCollab (in-process, clearly labelled) and SwitchCollab (Switch agent protocol).
 */
export interface RoomInfo { mode: 'local' | 'switch'; externalId: string | null; name: string; note: string }
export interface OutboundMessage {
  kind: 'handoff' | 'finding' | 'question' | 'answer' | 'approval_request' | 'decision' | 'status' | 'escalation';
  senderKey: string; senderName: string; toKey?: string; toName?: string; body: string;
}
/** An attachment as Switch delivers it (`AttachmentRef`, never the bytes); inspected by the RECLAIM guardrail before use. */
export interface InboundAttachment { filename: string; mimetype: string; size: number; mxc?: string; caption?: string }
/**
 * A message as Switch delivers it on the event stream. Every field below is set by the Switch SERVER, never by the text:
 * `senderId` is the opaque participant id (`@switch-<type>-<id>:<server>`; match it, never parse it), `senderKind` is
 * 'platform' when the Switch app posted it, and `onBehalfOf` names the person a platform message speaks for.
 * `roomId` is the room the server says the event belongs to (switch-core 0.31 agent-protocol event catalog).
 */
export interface InboundMessage {
  senderName: string; senderId: string; body: string; messageId: string; addressed: boolean; timestamp: number; attachments?: InboundAttachment[];
  senderKind?: string | null; onBehalfOf?: string | null; roomId?: string; threadId?: string | null;
  /** Name of the RIPPLE agent identity whose connection received the event (the room member that heard it). */
  receivedBy?: string;
}

/** A participant as `list_participants` reports it (switch-core 0.31: {id, name, type: 'agent' | 'user', status}). */
export interface RoomParticipant { id: string | null; name: string; type: 'agent' | 'user' | string; status?: string | null }

/**
 * Case room topology (session 21, flagship). A pack DECLARES the rooms one case needs: their purpose, instructions,
 * which agent identities and which human roles belong in each, how they link, and how sensitive their content is.
 * The engine executes it generically: through Switch when collaboration is Switch (each room is a real `create_room`,
 * each member identity connects with its own credentials), and as clearly labelled LOCAL rooms otherwise.
 */
export interface CaseRoomSpec {
  key: string;
  /** Room name prefix; the case reference is appended (e.g. `finance-approval` → `finance-approval-RPL-1A2B3C`). */
  name: string;
  purpose: string;
  instructions: string;
  /** Pack role keys of the AGENT identities that are members of this room (least privilege: nobody else is). */
  agentRoles: string[];
  /** Pack role keys of the HUMAN participants invited to this room (bridged rooms only). */
  humanRoles: string[];
  /** 'restricted' rooms hold raw records (ledger, logs) and are created private; only digests leave them. */
  sensitivity: 'shared' | 'restricted';
  /** Room keys this room links to (create_room linked_rooms). */
  links?: string[];
  /** Whether single records from this room may be disclosed (with a Merkle proof, audited) to another room. Default: true for shared rooms, false for restricted rooms unless set. */
  discloseRecords?: boolean;
}
export interface CaseRoomsTopology {
  rooms: CaseRoomSpec[];
  /** Which room each role speaks in (agents post their findings and documents there). */
  roleRoom: Record<string, string>;
  /** Room for system/coordination messages. */
  defaultRoom: string;
  /** The coordinator role whose identity creates the rooms. */
  coordinatorRole: string;
}
export interface OpenedCaseRoom { key: string; externalId: string | null; name: string; note: string; members: string[]; humans: string[]; linkedTo: string[]; mode: 'local' | 'switch' }
export interface IdentityStatus { name: string; roleKeys: string[]; connected: boolean; rooms: number; lastError: string | null; lastBeatOkAt: string | null }

/**
 * Level 3 case topology (session 15). A pack may DECLARE this shape; the engine executes it generically
 * against the collab boundary, and only the Switch adapter can actually run it. It describes the dynamic
 * bootstrap a coordinator performs when a case arrives: two sub-rooms linked to the intake room, an
 * exclusive room-role in the finance room, the follow-ups bootstrap text, and who the arbiter agent is.
 */
export interface SwitchCaseTopology {
  /** Sub-room where verification/ops agents work (e.g. #ops-verify-<case_id>). */
  opsRoom: { roleKeys: string[]; label: string; instructions: string };
  /** Sub-room where the settlement arbiter works (e.g. #finance-settle-<case_id>). */
  financeRoom: { roleKeys: string[]; label: string; instructions: string };
  /** `assume_role`-able instruction bundle in the finance room; `exclusive: true` → at most one live holder on the server. */
  exclusiveRole: { name: string; instructions: string };
  /** Switch agent name of the arbiter that will hold the exclusive role (via SWITCH_ROLE_AGENTS). */
  arbiterAgentName: string;
}

export interface CaseRoomRecord {
  key: 'ops-verify' | 'finance-settle';
  externalId: string; name: string;
  linkedTo: string;                 // the intake room id this room links back to
  note: string;
}
export interface CaseTopologyResult {
  caseId: string;
  intakeRoom: string;
  rooms: CaseRoomRecord[];
  /** HTTP room-membership isolation evidence: a non-member's connect_to_room attempt on the finance room (switch-core 0.31.0 agent bridge refuses with 400 "Agent is not a member"; 403 is the auth-level refusal). */
  isolation: { attempted: boolean; status: number | null; verifiedRefusal: boolean; detail: string };
  /** Exclusive-role lease state, as read back over the protocol. */
  role: { name: string; defined: boolean; assumedBy: string | null; confirmedHolder: string | null; guarantee: string } | null;
  /** Whether the follow-the-conversation bootstrap message was posted (server-side flag is set by the `!` commands a human runs in chat — see the playbook). */
  followUps: { bootstrapPosted: boolean; commands: string[]; note: string };
  /** Addressing-policy self-introspection + who may run APPROVE <CASE_ID> <SHA256>. */
  addressing: { policy: string | null; authority: string | null; announced: boolean; detail: string } | null;
  /** Honest labels: what of this ran for real on Switch and what is RIPPLE-side only. */
  labels: string[];
}

export interface CollabPort {
  readonly mode: 'local' | 'switch';
  readonly label: string;
  /** Honest status string for the UI. */
  describe(): { mode: string; connected: boolean; detail: string };
  openRoom(args: { missionId: string; title: string; topic: string; agentRoles: { key: string; name: string }[] }): Promise<RoomInfo>;
  send(room: RoomInfo, msg: OutboundMessage): Promise<void>;
  /** Subscribe to messages arriving in a room from outside RIPPLE (Switch only). Returns unsubscribe. */
  subscribe?(room: RoomInfo, handler: (m: InboundMessage) => void): () => void;
  /**
   * Level 3 dynamic bootstrap (optional): create the case sub-rooms, link them to the intake room, define/assume
   * the exclusive role, post the follow-ups bootstrap and the APPROVE-authority announcement. Returns a
   * structured evidence record; never throws for the caller (degradation is returned, not an error).
   */
  openCaseTopology?(args: {
    missionId: string; caseId: string; title: string; topic: string; intakeRoom: RoomInfo;
    agentRoles: { key: string; name: string }[]; topology: SwitchCaseTopology;
  }): Promise<CaseTopologyResult>;
  /**
   * Self-encoding room capture (optional): when a mission completes, export the resolved room topology as a
   * reusable `version: 2` YAML playbook. Switch side: GET /rooms/{id}/yaml when the gateway is configured;
   * otherwise a clearly-labelled local fallback composed from what the adapter recorded.
   */
  captureResolvedPlaybook?(args: { caseId: string; missionId: string; title: string; rooms: CaseRoomRecord[]; intakeRoom: RoomInfo; telemetry?: Record<string, unknown> }): Promise<{ path: string; source: 'gateway' | 'local_fallback'; yaml: string } | null>;
  /**
   * Session 21: provision a pack-declared case topology (several rooms, each with its own member identities, linked).
   * Implementations THROW when a room cannot be created: the engine must never record a room that does not exist.
   */
  openCaseRooms?(args: { missionId: string; caseRef: string; title: string; topology: CaseRoomsTopology; humans: Record<string, string[]> }): Promise<{ rooms: OpenedCaseRoom[]; labels: string[] }>;
  /** Server-side roster of a room, read through a member identity. */
  listParticipants?(room: RoomInfo): Promise<RoomParticipant[]>;
  /** Write a room-scoped document as the given role's identity; returns the server document id and a read-back hash. */
  writeDocument?(room: RoomInfo, doc: { name: string; description: string; instructions: string; content: string }, asRoleKey?: string): Promise<{ documentId: string | null; readBackHash: string | null; note: string }>;
  /** Room history read-back through a member identity. */
  history?(room: RoomInfo, limit?: number): Promise<{ sender: string; senderName: string; body: string; messageId: string }[]>;
  /** Honest per-identity connection status (never claims an identity is active unless its stream and heartbeat are). */
  identities?(): IdentityStatus[];
  close(): Promise<void>;
}
