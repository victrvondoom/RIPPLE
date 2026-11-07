/**
 * Switch decision authority (session 21). PURE: no I/O. Given what the Switch SERVER said about a message (sender id,
 * sender type, platform marker, on-behalf-of, room) plus the server's room roster, the workspace's pinned identities
 * and the approval it targets, it returns every reason the decision must be refused. An empty list means the decision
 * may enter the engine's ONE authoritative transition (Engine.decideApproval), which then applies its own role,
 * approver, four-eyes, two-person and expiry checks. Nothing here can approve anything by itself.
 *
 * The text of a message is never evidence of who sent it. "APPROVE" from an agent, from an unpinned account, from the
 * wrong room, for another case, for an old payload hash or for a superseded revision is refused and recorded.
 *
 * Strict grammar (one line; optional leading @mention; case and approval references as RIPPLE printed them):
 *   APPROVE <CASE_REF> <APPROVAL_REF> <PAYLOAD_SHA256>       e.g. APPROVE RPL-1A2B3C A-7B1D04 9f86d0…(64 hex)
 *   REJECT  <CASE_REF> <APPROVAL_REF> <reason>
 */

export interface StrictDecision { verb: 'approve' | 'reject'; caseRef: string; approvalRef: string; hash: string | null; reason: string }

export function parseStrictDecision(body: string | null | undefined): StrictDecision | null {
  const m = /^\s*(?:@[\w.-]+[:,]?\s+)*(approve|reject)\s+(RPL-[0-9A-Z]{6})\s+(A-[0-9A-Z]{6})\b\s*([\s\S]*)$/i.exec(body ?? '');
  if (!m) return null;
  const verb = m[1]!.toLowerCase() as StrictDecision['verb']; const rest = m[4]!.trim();
  if (verb === 'approve') { const h = /^([0-9a-f]{64})\b\s*([\s\S]*)$/i.exec(rest); return { verb, caseRef: m[2]!.toUpperCase(), approvalRef: m[3]!.toUpperCase(), hash: h ? h[1]!.toLowerCase() : null, reason: h ? h[2]!.trim() : rest }; }
  return { verb, caseRef: m[2]!.toUpperCase(), approvalRef: m[3]!.toUpperCase(), hash: null, reason: rest };
}

export const caseRefOf = (missionId: string) => `RPL-${missionId.replace(/[^0-9a-z]/gi, '').slice(-6).toUpperCase()}`;

export type RefusalCode =
  | 'unverifiable_identity' | 'agent_sender' | 'on_behalf_of' | 'wrong_room' | 'not_room_member' | 'identity_not_pinned'
  | 'identity_name_mismatch' | 'wrong_case' | 'unknown_approval' | 'superseded_revision' | 'expired' | 'already_decided'
  | 'hash_missing' | 'payload_hash_mismatch' | 'reason_required' | 'switch_unavailable';

export interface DecisionFacts {
  message: { senderId: string; senderName: string; senderKind?: string | null; onBehalfOf?: string | null; roomId?: string | null };
  /** Server roster of the room the message arrived in (list_participants), or null when it could not be read. */
  roster: { id: string | null; name: string; type: string }[] | null;
  /** Names of every RIPPLE-registered agent identity (they can never decide). */
  agentNames: string[];
  /** The pinned person for this sender id in this workspace, or null. */
  pinned: { userId: string; switchName: string; chatUsername: string | null } | null;
  decision: StrictDecision;
  mission: { caseRef: string; analysisRev: number };
  /** The approval the reference resolves to (any status), or null. */
  approval: { status: string; analysisRev: number; expiresAt: string | null; payloadHash: string; decisionRoomId: string | null } | null;
  now: string;
}

export function evaluateDecision(f: DecisionFacts): { code: RefusalCode; detail: string }[] {
  const out: { code: RefusalCode; detail: string }[] = [];
  const no = (code: RefusalCode, detail: string) => out.push({ code, detail });
  const { message: msg, decision: d } = f;
  const name = (msg.senderName ?? '').trim();
  if (!msg.senderId?.trim()) no('unverifiable_identity', 'the Switch event carries no sender id, so the sender cannot be authenticated');
  const rosterAgent = (f.roster ?? []).some((p) => p.type === 'agent' && (p.name.toLowerCase() === name.toLowerCase() || (!!p.id && p.id === msg.senderId)));
  if (rosterAgent || f.agentNames.some((n) => n.toLowerCase() === name.toLowerCase())) no('agent_sender', `${name || msg.senderId} is an agent identity; agents never approve or reject (they flag, humans decide)`);
  if (msg.senderKind === 'platform' || msg.onBehalfOf) no('on_behalf_of', `posted by a platform client${msg.onBehalfOf ? ` on behalf of ${msg.onBehalfOf}` : ''}; a financial decision must be posted by the person's own account`);
  if (!f.approval) no('unknown_approval', `no approval ${d.approvalRef} exists in case ${f.mission.caseRef}`);
  if (d.caseRef !== f.mission.caseRef) no('wrong_case', `message names case ${d.caseRef}; this room belongs to ${f.mission.caseRef}`);
  if (f.approval) {
    if (!f.approval.decisionRoomId) no('wrong_room', 'this approval has no Switch decision room bound to it');
    else if (msg.roomId !== f.approval.decisionRoomId) no('wrong_room', `decision arrived in room ${msg.roomId ?? '?'}; it is only accepted in the bound decision room ${f.approval.decisionRoomId}`);
  }
  if (f.roster === null) no('not_room_member', 'the room roster could not be read from Switch; membership unverified');
  else if (!f.roster.some((p) => p.type === 'user' && p.name.toLowerCase() === name.toLowerCase())) no('not_room_member', `${name || msg.senderId} is not a person (type "user") in this room's Switch roster`);
  if (!f.pinned) no('identity_not_pinned', `sender id ${msg.senderId || '(none)'} is not pinned to a RIPPLE person in this workspace`);
  else if (f.pinned.switchName.toLowerCase() !== name.toLowerCase() && (f.pinned.chatUsername ?? '').toLowerCase() !== name.toLowerCase()) no('identity_name_mismatch', `pinned sender id belongs to ${f.pinned.switchName}, but the event names ${name}`);
  if (f.approval) {
    if (f.approval.status === 'stale' || f.approval.analysisRev !== f.mission.analysisRev) no('superseded_revision', `approval belongs to analysis rev ${f.approval.analysisRev}; the case is at rev ${f.mission.analysisRev}`);
    else if (f.approval.status === 'expired' || (f.approval.status === 'pending' && f.approval.expiresAt && f.now > f.approval.expiresAt)) no('expired', `approval expired at ${f.approval.expiresAt}`);
    else if (f.approval.status !== 'pending') no('already_decided', `approval is already ${f.approval.status}`);
    if (d.verb === 'approve') {
      if (!d.hash) no('hash_missing', 'APPROVE must quote the full 64-hex payload SHA-256 shown in the request');
      else if (d.hash !== f.approval.payloadHash) no('payload_hash_mismatch', `quoted ${d.hash.slice(0, 12)}…, the current payload is ${f.approval.payloadHash.slice(0, 12)}…`);
    }
  }
  if (d.verb === 'reject' && d.reason.length < 3) no('reason_required', 'REJECT needs a reason');
  return out;
}
