/**
 * REDEEM capability: consumer intake safety, case-fact extraction and confirmed memory.
 *
 * Ported to TypeScript from REDEEM (github.com/victrvondoom/Redeem):
 *   - `apps/api/app/policy/safety.py`          evaluate_intent (credential / clinical / money-transfer refusals, scam clarify)
 *   - `apps/api/app/policy/payment_safety.py`  scam-pattern indicators (heuristic, not a fraud guarantee)
 *   - `apps/api/app/memory/extract.py`         rule-based mapping of an answer to a memory field (subset: refund mode,
 *                                             contact method). Negation-aware; ambiguity -> clarification, never a guess.
 * Prompt-injection detection is NOT duplicated here: RIPPLE's `packs/untrusted.ts` is the single implementation.
 * The "confirmed memory" rule from REDEEM memory/service.py is kept: an extracted fact is only PROPOSED until the consumer
 * confirms it, and sensitive facts are never auto-confirmed. In RIPPLE the confirmation is an assignee-only question.
 */

export interface SafetyDecision { decision: 'ALLOW' | 'REFUSE' | 'CLARIFY'; riskClass: string; explanation: string; evidence: string[] }
const CRED = /\b(otp|one[- ]time (password|code)|pin|cvv|password|passcode)\b/i;
const SHARE = /\b(share|send|give|tell|provide|read out|enter|collect|ask)\b/i;
const THIRD_PARTY = /\b(asked me|asking me|someone|caller|they want|wants me|message says|told me to|is asking)\b/i;
const CLINICAL = /\b(diagnos\w*|prescrib\w*|what medicine|which medicine|dosage|dose of|treatment for|am i sick)\b/i;
const TRANSFER = /\b(transfer|send|wire|pay)\b.{0,30}\b(money|funds|rs\.?|₹|rupees|lakh|crore)\b|\bcharge (my|the) card\b/i;

export function evaluateIntent(text: string): SafetyDecision {
  if (CRED.test(text) && SHARE.test(text) && THIRD_PARTY.test(text))
    return { decision: 'CLARIFY', riskClass: 'identity', evidence: ['third_party_credential_request'], explanation: 'This looks like a scam attempt. Never share an OTP, PIN, CVV or password with anyone, including callers claiming to be your bank. RIPPLE will never ask for them.' };
  if (CRED.test(text) && SHARE.test(text))
    return { decision: 'REFUSE', riskClass: 'identity', evidence: [`matched:${CRED.exec(text)![0].toLowerCase()}`], explanation: 'RIPPLE never collects or relays OTPs, PINs, passwords or security codes.' };
  if (CLINICAL.test(text))
    return { decision: 'REFUSE', riskClass: 'health', evidence: ['clinical_request'], explanation: 'RIPPLE handles administration only and cannot diagnose, prescribe or advise on treatment.' };
  if (TRANSFER.test(text))
    return { decision: 'REFUSE', riskClass: 'financial', evidence: ['autonomous_payment_request'], explanation: 'RIPPLE never moves money or charges cards. It can prepare a dispute or reminder for your approval instead.' };
  return { decision: 'ALLOW', riskClass: 'none', explanation: 'No policy concern at intent level.', evidence: [] };
}

const SCAM_RULES: [string, 'high' | 'medium', RegExp, string][] = [
  ['OTP_REQUEST', 'high', /\b(otp|one[- ]time (password|code)|pin|cvv|password)\b/i, 'Genuine banks never ask you to share an OTP, PIN, CVV or password.'],
  ['URGENCY', 'medium', /\b(urgent|immediately|within \d+ ?(min|minutes|hours)|last chance|blocked today|account (will be )?(blocked|suspended))\b/i, 'Artificial urgency is a common pressure tactic.'],
  ['UNVERIFIED_LINK', 'high', /(https?:\/\/\S+|\b\w+\.(xyz|top|click|link|online)\b|bit\.ly\/\S+)/i, 'Payment or KYC links should be opened only from the official app or site.'],
  ['IMPERSONATION', 'medium', /\b(rbi|income tax|customs|police|cbi|bank (official|manager|executive)|kyc (update|expired))\b/i, 'Authority impersonation is common in payment scams.'],
  ['REMOTE_ACCESS', 'high', /\b(anydesk|teamviewer|quicksupport|screen ?share)\b/i, 'Never install remote-access apps at a caller\'s request.'],
  ['COLLECT_REQUEST', 'medium', /\b(collect request|approve (the )?request to receive|send .{0,20} to receive)\b/i, 'Approving a UPI collect request sends money out; it never receives money.'],
];
export function scanForScam(text: string) {
  const indicators = SCAM_RULES.filter(([, , re]) => re.test(text)).map(([code, severity, , message]) => ({ code, severity, message }));
  return { level: indicators.some((i) => i.severity === 'high') ? 'high' : indicators.length ? 'medium' : 'none_detected', indicators,
    disclaimer: 'Heuristic indicators only. Absence of indicators is not proof of safety.' } as const;
}

/** Facts a consumer statement asserts. Every fact keeps the quote it came from and starts as PROPOSED (never auto-confirmed). */
export interface CaseFact { field: string; value: string; quote: string; sensitive: boolean; status: 'proposed' }
export function extractCaseFacts(text: string): CaseFact[] {
  const out: CaseFact[] = [];
  const add = (field: string, m: RegExpExecArray | null, value: (m: RegExpExecArray) => string, sensitive = false) => { if (m) out.push({ field, value: value(m), quote: m[0].trim(), sensitive, status: 'proposed' }); };
  add('amount', /(?:₹|rs\.?\s?|inr\s?)\s?([\d,]+(?:\.\d{1,2})?)/i.exec(text), (m) => m[1]!.replace(/,/g, ''));
  add('flight', /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])[ -]?(\d{2,4})\b/.exec(text), (m) => `${m[1]}${m[2]}`);
  add('card_last4', /\bending\s*(?:in\s*)?(\d{4})\b/i.exec(text), (m) => m[1]!, true);
  add('date', /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text), (m) => m[1]!);
  return out;
}

// ---- confirmed memory field mapper (REDEEM memory/extract.py, subset) ----
const FIELDS: Record<string, { label: string; question: string; values: Record<string, string[]> }> = {
  'billing.refund_mode': { label: 'Preferred refund mode', question: 'Do you want the refund to the original payment method, a wallet or a voucher (credit shell)?',
    values: { original_payment: ['original payment', 'original method', 'same card', 'same account', 'original'], wallet: ['wallet'], voucher: ['voucher', 'credit note', 'store credit', 'credit shell'] } },
  'profile.contact_method': { label: 'Preferred contact method', question: 'How should we contact you: WhatsApp, email, SMS or a call?',
    values: { whatsapp: ['whatsapp', 'whats app'], email: ['email', 'e-mail', 'mail'], sms: ['sms', 'text message'], phone_call: ['phone call', 'call me', 'a call'] } },
};
const NEG = /\b(not|no|don'?t|never|nahi|nahin)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Map an answer to one field. Negated values are ignored ("not a voucher"); two values -> clarification; none -> re-ask. */
export function mapAnswer(utterance: string, field: string): { value?: string; quote?: string; clarification?: string } {
  const f = FIELDS[field]; if (!f) return { clarification: 'unknown field' };
  const low = (utterance ?? '').toLowerCase().slice(0, 2000); const hits: [string, number, string][] = [];
  for (const [value, terms] of Object.entries(f.values)) {
    let found = false;
    for (const t of terms) {
      const re = new RegExp(`(?<![\\w])${esc(t)}(?![\\w])`, 'g'); let m: RegExpExecArray | null;
      while ((m = re.exec(low))) {
        const pre = low.slice(Math.max(0, m.index - 24), m.index).split(/[,;.]|\bbut\b|\blekin\b/).at(-1) ?? '';
        if (NEG.test(pre)) continue;                    // negated: "not a voucher"
        hits.push([value, m.index, t]); found = true; break;
      }
      if (found) break;
    }
  }
  const values = [...new Set(hits.map((h) => h[0]))];
  if (values.length > 1) return { clarification: `You mentioned ${values.join(' and ')} for ${f.label.toLowerCase()}. Which one should I save?` };
  if (!values.length) return { clarification: `I didn't catch that. ${f.question}` };
  const h = hits.find((x) => x[0] === values[0])!;
  return { value: values[0], quote: utterance.slice(h[1], h[1] + h[2].length) };
}
export const memoryQuestion = (field: string) => FIELDS[field]?.question ?? field;
