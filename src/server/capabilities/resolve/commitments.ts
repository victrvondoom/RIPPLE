/**
 * RESOLVE capability: deterministic commitment extraction and deadline resolution from an email thread.
 *
 * Ported to TypeScript from RESOLVE `src/inbox_intel.py` (github.com/victrvondoom/Resolve). No model is called.
 * Every commitment cites the exact sentence it came from. Email text is untrusted data: instruction-like text never
 * becomes an obligation, automated notices never create commitments, and vague time phrases get NO date.
 * Differences from the Python original, stated plainly: time zones are a fixed UTC offset in minutes (the original
 * accepts IANA zone names), and "within N days" windows are resolved as N calendar days (a RIPPLE addition, since
 * provider replies usually phrase promises that way).
 */

export type CommitmentKind = 'PROMISE_BY_USER' | 'PROMISE_BY_OTHER' | 'REQUEST_TO_USER' | 'DEPENDENCY';
export type DeadlineConfidence = 'EXPLICIT_DATE' | 'RESOLVED_RELATIVE' | 'AMBIGUOUS' | null;
export interface ThreadMessage { id: string; sender: string; to?: string; body: string; sentAt: string /* ISO 8601 */ }
export interface Deadline { deadlineAt: string | null; confidence: DeadlineConfidence; reviewReason: string | null; phrase: string | null; explicit: boolean }
export interface Commitment {
  sourceMessageId: string; kind: CommitmentKind; requiredAction: string; evidenceText: string;
  deadline: Deadline; requestingPerson: string | null; responsiblePerson: string | null;
  ownershipState: 'RESOLVED' | 'PARTIAL' | 'UNRESOLVED'; obligationKey: string; sentAt: string;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const AUTOMATED_SENDER = /(no-?reply|donotreply|notifications?@|mailer-daemon|newsletter)/i;
const REQUEST_RE = /\b(could you|can you|would you|please|need you to|send me|can we get|will you)\b/i;
const PROMISE_RE = /\b(i['’]ll|i will|i can|i['’]m going to|i['’]m sending|i promise)\b/i;
const OTHER_PROMISE_RE = /\b(he['’]ll|she['’]ll|they['’]ll|we['’]ll|i['’]ll|we will|will send|will share|will be (?:processed|refunded|credited|reversed))\b/i;
const DEPENDENCY_RE = /\b(before|ahead of|prior to)\b.*\b(call|meeting|review|demo|launch)\b/i;
const HYPOTHETICAL_RE = /\b(maybe|might|possibly|perhaps|if we|we could consider|someday|would be nice)\b/i;
const HISTORICAL_RE = /\b(i sent|we discussed|last week|yesterday i|already sent|you sent)\b/i;
const AMBIGUOUS_TIME = /\b(soon|later|next week|end of the month|at some point|when you can|shortly|when possible|whenever (?:you can|possible)|in due course|sometime)\b/i;
export const INJECTION_RE = /ignore (all |any )?(previous|prior|above) instructions|disregard (the |your )?(system|previous) (prompt|instructions)|send (me )?(the )?(full |entire |whole )?inbox|forward (me )?every (message|email)|reveal (your|the) (system )?prompt/i;
const AUTOMATED_BODY = /(unsubscribe|this is an automated|do not reply|you are receiving this)/i;
const TIME_OF_DAY = /\b(?:by|before|at|until|no later than|around|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2})\b/i;
const WITHIN_DAYS = /\bwithin\s+(\d{1,3})\s+(?:working\s+|business\s+|calendar\s+)?days?\b/i;

/** Sentences of the NEW text; quoted lines ('>') belong to earlier messages and are dropped. */
export function sentences(text: string): string[] {
  const fresh = (text ?? '').split(/\r?\n/).filter((l) => !l.trimStart().startsWith('>')).join('\n');
  return fresh.split(/(?<=[.!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean);
}

function clock(text: string): [number, number] | null {
  const m = TIME_OF_DAY.exec(text); if (!m) return null;
  const raw = m[1]!.toLowerCase().replace(/\./g, '');
  if (raw === 'noon') return [12, 0];
  if (raw === 'midnight') return [0, 0];
  const mm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw); if (!mm) return null;
  let hour = Number(mm[1]); const minute = Number(mm[2] ?? 0);
  if (mm[3]) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (mm[3] === 'pm' ? 12 : 0); }
  return hour > 23 || minute > 59 ? null : [hour, minute];
}

const local = (iso: string, off: number) => new Date(Date.parse(iso) + off * 60000);
const toIso = (y: number, mo: number, d: number, h: number, mi: number, s: number, off: number) => new Date(Date.UTC(y, mo, d, h, mi, s) - off * 60000).toISOString();
const weekdayIdx = (d: Date) => (d.getUTCDay() + 6) % 7; // Monday = 0, as Python's weekday()

/** Never invents a date: vague phrases and "next <weekday>" are AMBIGUOUS and get none. */
export function resolveDeadline(sentence: string, sentAt: string, utcOffsetMin = 0): Deadline {
  const base = local(sentAt, utcOffsetMin); const s = sentence.toLowerCase();
  const empty: Deadline = { deadlineAt: null, confidence: null, reviewReason: null, phrase: null, explicit: false };
  const amb = AMBIGUOUS_TIME.exec(s);
  if (amb && !/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}\s*(st|nd|rd|th)?\b)/.test(s))
    return { ...empty, confidence: 'AMBIGUOUS', reviewReason: 'the time phrase is vague; please set the deadline', phrase: amb[0] };
  const nxt = /\bnext (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(s);
  if (nxt) return { ...empty, confidence: 'AMBIGUOUS', reviewReason: "'next <weekday>' can mean two different days; please confirm", phrase: nxt[0] };
  let day: Date | null = null; let conf: DeadlineConfidence = null; let phrase: string | null = null; let explicit = false;
  const shift = (n: number) => new Date(base.getTime() + n * 86400000);
  const within = WITHIN_DAYS.exec(s);
  if (/\btomorrow\b/.test(s)) { day = shift(1); conf = 'RESOLVED_RELATIVE'; phrase = 'tomorrow'; }
  else if (/\btoday\b/.test(s)) { day = base; conf = 'RESOLVED_RELATIVE'; phrase = 'today'; }
  else if (within) { day = shift(Number(within[1])); conf = 'RESOLVED_RELATIVE'; phrase = within[0]; }
  else {
    for (let i = 0; i < WEEKDAYS.length && !day; i++) {
      const hit = new RegExp(`\\b(by|on|before|until)\\s+(${WEEKDAYS[i]})\\b`).exec(s); if (!hit) continue;
      const delta = (i - weekdayIdx(base) + 7) % 7;
      if (hit[1] === 'before') {
        if (delta === 0) return { ...empty, confidence: 'AMBIGUOUS', phrase: hit[0], reviewReason: "'before <today's weekday>' is unclear; please confirm the date" };
        day = shift(delta - 1);
      } else day = shift(delta);
      conf = 'RESOLVED_RELATIVE'; phrase = hit[0];
    }
    if (!day) {
      const m = new RegExp(`\\b(by|on|before)\\s+(${MONTHS.join('|')})\\s+(\\d{1,2})\\b`).exec(s);
      if (m) {
        const mo = MONTHS.indexOf(m[2]!), d = Number(m[3]);
        const y = mo > base.getUTCMonth() || (mo === base.getUTCMonth() && d >= base.getUTCDate()) ? base.getUTCFullYear() : base.getUTCFullYear() + 1;
        day = new Date(Date.UTC(y, mo, d)); conf = 'EXPLICIT_DATE'; phrase = m[0]; explicit = true;
      } else {
        const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(s);
        if (iso) { day = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))); conf = 'EXPLICIT_DATE'; phrase = iso[0]; explicit = true; }
      }
    }
  }
  const c = clock(sentence);
  if (!c && !day) return empty;
  const ymd = (d: Date) => [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()] as const;
  if (c) {
    const tod = TIME_OF_DAY.exec(sentence)![0];
    if (!day) { day = base; conf = 'RESOLVED_RELATIVE'; phrase = tod; explicit = true; }
    else { const head = phrase?.split(' ').at(-1)?.toLowerCase() ?? ''; phrase = head && tod.toLowerCase().startsWith(`${head} `) ? `${phrase} ${tod.split(' ').slice(1).join(' ')}` : `${phrase} ${tod}`.trim(); }
    const [y, mo, d] = ymd(day);
    return { deadlineAt: toIso(y, mo, d, c[0], c[1], 0, utcOffsetMin), confidence: conf, reviewReason: null, phrase, explicit };
  }
  const [y, mo, d] = ymd(day!);
  return { deadlineAt: toIso(y, mo, d, 23, 59, 59, utcOffsetMin), confidence: conf, reviewReason: null, phrase, explicit };
}

const STOPW = new Set(['reminder', 'update', 'updated', 'updates', 'again', 'following', 'follow', 'checking', 'ping', 'could', 'would', 'will', 'please', 'that', 'this', 'with', 'from', 'your', 'have', 'just', 'need', 'want', 'into', 'about', 'them', 'there', 'should', 'they', 'their', 'then', 'than', 'instead', 'moved', 'legal', 'thanks', 'thank', 'also', 'still', 'really', 'today', 'tomorrow', 'soon', 'when', 'what', 'which', 'where', 'while', 'hello', 'hope', 'sorry', 'kindly', 'ahead', 'anyway', 'you', 'the', 'and', 'for']);
const DEADLINE_WORDS = /\b(by|before|until|on|no later than|tomorrow|today|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight|at|within|working|business|days?)\b|\d{1,2}(:\d{2})?\s*(am|pm)|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,3}\b/gi;
export const obligationWords = (action: string) => new Set(((action ?? '').toLowerCase().replace(DEADLINE_WORDS, ' ').match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOPW.has(w)));
/** Stable identity of an obligation: content words with the deadline phrase removed. */
export const obligationKey = (action: string) => [...obligationWords(action)].sort().join(' ').slice(0, 200);
export function sameObligation(a: string, b: string, threshold = 0.7) {
  const wa = obligationWords(a), wb = obligationWords(b); if (!wa.size || !wb.size) return false;
  const inter = [...wa].filter((w) => wb.has(w)).length; return inter / new Set([...wa, ...wb]).size >= threshold;
}
const person = (h: string) => (/<([^>]+)>/.exec(h ?? '')?.[1] ?? h ?? '').trim().toLowerCase();

/** Ownership comes from the authenticated mailbox address and the real sender/recipient, never a display name alone. */
export function extractCommitments(messages: ThreadMessage[], userAddress: string, utcOffsetMin = 0): Commitment[] {
  const out: Commitment[] = []; const user = (userAddress ?? '').toLowerCase().trim();
  for (const m of messages) {
    const senderRaw = m.sender ?? ''; const sender = senderRaw.toLowerCase();
    if (AUTOMATED_SENDER.test(sender) || AUTOMATED_BODY.test(m.body ?? '')) continue;
    const fromUser = !!user && sender.includes(user);
    const senderAddr = person(senderRaw); const recipientAddr = m.to ? person(m.to.split(',')[0]!) : null;
    for (const sent of sentences(m.body)) {
      if (HYPOTHETICAL_RE.test(sent) || HISTORICAL_RE.test(sent) || INJECTION_RE.test(sent)) continue;
      let kind: CommitmentKind | null = null;
      if (PROMISE_RE.test(sent) && fromUser) kind = 'PROMISE_BY_USER';
      else if (OTHER_PROMISE_RE.test(sent) && !fromUser) kind = 'PROMISE_BY_OTHER';
      else if (REQUEST_RE.test(sent) && !fromUser) kind = 'REQUEST_TO_USER';
      else if (DEPENDENCY_RE.test(sent) && !fromUser) kind = 'DEPENDENCY';
      if (!kind) continue;
      const [requesting, responsible] =
        kind === 'PROMISE_BY_USER' ? [recipientAddr || null, user || null]
          : kind === 'PROMISE_BY_OTHER' ? [user || null, senderAddr || null]
            : kind === 'REQUEST_TO_USER' ? [senderAddr || null, user || null]
              : [senderAddr || null, null];
      out.push({
        sourceMessageId: m.id, kind, requiredAction: sent.slice(0, 300), evidenceText: sent.slice(0, 500), deadline: resolveDeadline(sent, m.sentAt, utcOffsetMin),
        requestingPerson: requesting, responsiblePerson: responsible, ownershipState: requesting && responsible ? 'RESOLVED' : responsible === null ? 'UNRESOLVED' : 'PARTIAL',
        obligationKey: obligationKey(sent), sentAt: m.sentAt,
      });
    }
  }
  return out;
}

/** RIPPLE addition: the state of a promise on a given day, from recorded data only. */
export function commitmentState(c: Commitment, todayIso: string, fulfilled: boolean): 'FULFILLED' | 'OPEN' | 'OVERDUE' | 'NEEDS_DATE' {
  if (fulfilled) return 'FULFILLED';
  if (!c.deadline.deadlineAt) return 'NEEDS_DATE';
  return Date.parse(c.deadline.deadlineAt) < Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`) ? 'OVERDUE' : 'OPEN';
}
