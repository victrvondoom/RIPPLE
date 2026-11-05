import type { CollabPort, OutboundMessage, RoomInfo } from './port.js';

/** LOCAL DEVELOPMENT MODE. No external service is contacted. Messages are persisted by the engine; role "agents" are RIPPLE's own analyzers. */
export class LocalCollab implements CollabPort {
  readonly mode = 'local' as const;
  readonly label = 'LOCAL MODE (not Switch)';
  describe() {
    return { mode: 'local', connected: true, detail: 'Local development collaboration. Role agents are RIPPLE rule-based analyzers exchanging real handoffs through the shared room log; no Switch server is contacted.' };
  }
  async openRoom(a: { missionId: string; title: string }): Promise<RoomInfo> {
    return { mode: 'local', externalId: null, name: `ripple-${a.missionId}`, note: 'Local mode — not a Switch room.' };
  }
  async send(_room: RoomInfo, _msg: OutboundMessage) { /* persisted by the engine's message log; nothing external */ }
  async close() {}
}
