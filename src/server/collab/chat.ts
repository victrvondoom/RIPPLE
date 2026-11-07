/**
 * Decisions typed in a bridged Switch room (session 19). This module is PURE: it only reads text and builds
 * references. The engine decides who the sender is (operator-mapped Switch sender name) and whether that person
 * may act (the engine's own assignee, approver and role checks). Nothing here can approve anything.
 *
 * Grammar (one line, first word is the verb, second word is the reference RIPPLE printed in the room):
 *   approve Q-3F9A2C          answer a blocking decision question
 *   decline Q-3F9A2C <reason> decline it (a reason is required)
 *   answer  Q-3F9A2C <text>   answer any open question
 *   approve A-7B1D04          approve a pending action approval
 *   decline A-7B1D04 <reason> reject it (a reason is required)
 */

export type ChatRefKind = 'Q' | 'A';

/** Short, human-typeable reference for a question (Q-) or approval (A-): the last six alphanumerics of its row id. */
export function chatRef(kind: ChatRefKind, id: string): string {
  return `${kind}-${id.replace(/[^0-9a-z]/gi, '').slice(-6).toUpperCase()}`;
}

export interface ChatCommand { verb: 'approve' | 'decline' | 'answer'; ref: string; rest: string }

export function parseChatCommand(body: string | null | undefined): ChatCommand | null {
  // An optional leading @mention is allowed ("@ripple approve Q-…"), because people in chat address the agent that way.
  const m = /^\s*(?:@[\w.-]+[:,]?\s+)?(approve|decline|answer)\s+([QA]-[0-9A-Z]{6})\b\s*([\s\S]*)$/i.exec(body ?? '');
  if (!m) return null;
  return { verb: m[1]!.toLowerCase() as ChatCommand['verb'], ref: m[2]!.toUpperCase(), rest: m[3]!.trim() };
}

/**
 * SWITCH_CHAT_IDENTITIES: JSON object mapping a Mattermost (Switch sender) username to a RIPPLE user's email,
 * e.g. {"alex":"alex@harborvine.example"}. Keys are lower-cased. Unmapped senders cannot act through chat.
 */
export function parseChatIdentities(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('SWITCH_CHAT_IDENTITIES must be a JSON object, e.g. {"alex":"alex@harborvine.example"}'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SWITCH_CHAT_IDENTITIES must be a JSON object');
  const out: Record<string, string> = {};
  for (const [user, email] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof email !== 'string' || !email.includes('@')) throw new Error(`SWITCH_CHAT_IDENTITIES: "${user}" must map to an email address`);
    out[user.trim().toLowerCase()] = email.trim().toLowerCase();
  }
  return out;
}
