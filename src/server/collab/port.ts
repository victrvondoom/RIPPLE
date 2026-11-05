/**
 * Collaboration boundary. The mission engine only knows this interface.
 * Implementations: LocalCollab (in-process, clearly labelled) and SwitchCollab (Switch agent protocol).
 */
export interface RoomInfo { mode: 'local' | 'switch'; externalId: string | null; name: string; note: string }
export interface OutboundMessage {
  kind: 'handoff' | 'finding' | 'question' | 'answer' | 'approval_request' | 'decision' | 'status' | 'escalation';
  senderKey: string; senderName: string; toKey?: string; toName?: string; body: string;
}
export interface InboundMessage { senderName: string; senderId: string; body: string; messageId: string; addressed: boolean; timestamp: number }

export interface CollabPort {
  readonly mode: 'local' | 'switch';
  readonly label: string;
  /** Honest status string for the UI. */
  describe(): { mode: string; connected: boolean; detail: string };
  openRoom(args: { missionId: string; title: string; topic: string; agentRoles: { key: string; name: string }[] }): Promise<RoomInfo>;
  send(room: RoomInfo, msg: OutboundMessage): Promise<void>;
  /** Subscribe to messages arriving in a room from outside RIPPLE (Switch only). Returns unsubscribe. */
  subscribe?(room: RoomInfo, handler: (m: InboundMessage) => void): () => void;
  close(): Promise<void>;
}
