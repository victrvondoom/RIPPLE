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
export interface InboundMessage { senderName: string; senderId: string; body: string; messageId: string; addressed: boolean; timestamp: number; attachments?: InboundAttachment[] }

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
  close(): Promise<void>;
}
