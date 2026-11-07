/**
 * RECLAIM attachment guardrail — deterministic, runs BEFORE any parsing of uploaded dispute evidence.
 *
 * Why: Switch issue #908 — attachments passed through a bridge bypass the guardrails that apply to
 * message TEXT (a caption or filename can carry instructions that would reach an analyzer verbatim).
 * This module closes that path for RIPPLE: every attachment arriving with a message (Switch
 * `AttachmentRef`: filename, mimetype, size, `mxc` URI — never the bytes) is inspected here, an
 * untrusted-text scan runs over its filename + caption + any text preview, and the sanitized,
 * clearly-labelled form is the ONLY thing later analysis may read. No model call is involved.
 *
 * Deterministic by design (deterministic analyzers only, AGENTS.md): same input → same findings.
 */

export interface AttachmentLike {
  filename: string;
  mimetype: string;
  size: number;
  /** Switch `mxc` media URI (opaque key; the file itself is fetched on demand when a human asks). */
  mxc?: string;
  /** Free text a sender attached to the file. */
  caption?: string;
  /** Optional text preview of the file's content, when one was extracted. */
  text?: string;
}

export interface AttachmentFinding {
  code: 'extension_mimetype_mismatch' | 'executable_attachment' | 'oversized' | 'untrusted_media_uri'
    | 'control_characters' | 'injection_in_filename' | 'injection_in_caption' | 'injection_in_text' | 'empty_attachment';
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface SanitizedAttachment {
  /** Identifier that is safe to display and reference (the original filename is kept only here, in the finding context). */
  safeLabel: string;
  /** Neutralized filename (control/injection characters replaced). */
  filename: string;
  mimetype: string;
  size: number;
  mxc: string | null;
  /** The ONLY text downstream code may read. Instruction-like content is quoted as data, not removed. */
  quotedData: string;
  /** true = quarantine: honest analysis may reference the attachment but must NOT treat it as evidence. */
  quarantined: boolean;
  guard: 0 | 1 | 2 | 3; // 0 = pass, 1 = low, 2 = medium, 3 = high (mirrors REDEEM's intake refusal tiers)
  findings: AttachmentFinding[];
}

const MAX_ATTACHMENT_BYTES = 26_214_400; // 25 MiB, our own intake ceiling (independent of Switch's limits).
const EXECUTABLE = /\.(exe|msi|bat|cmd|com|scr|vbs|js|jar|sh|apk|dll|ps1)$/i;
const DOC_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', md: 'text/markdown', yaml: 'text/yaml',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  eml: 'message/rfc822',
  exe: 'application/x-msdownload', js: 'text/javascript', sh: 'application/x-sh', bat: 'application/x-msdownload', jar: 'application/java-archive',
};
// Detects (and replaces) control/zero-width characters on purpose; the regex is the point, not an accident.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200D\u2028\u2029\uFEFF]/;

/** Switch-critical instruction patterns RECLAIM treats as injection attempts in attachment-carried text. */
const INJECTION: [RegExp, string][] = [
  [/ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions?|rules?|prompts?)/i, 'tries to make the reader ignore previous instructions'],
  [/(?:approve|authori[sz]e|release|send|pay|refund)\s+(?:the\s+)?(?:release|funds?|payment|payout|refund|credit)/i, 'tries to make the reader release funds or a credit'],
  [/\b(?:disregard|override|bypass)\b.{0,30}\b(?:rules?|checks?|gates?|guardrails?|guard|verif\w+)/i, 'tries to bypass checks or guardrails'],
  [/mark (?:this |it |the \w+ )?(?:as )?(?:verified|approved|passed|complete[d]?|refunded)/i, 'tries to make the reader mark something verified/approved/refunded'],
  [/\b(?:system|developer) (?:prompt|message|instructions?)\b/i, 'refers to system/developer instructions'],
  [/\b(?:you are|act as|from now on.*?)\b.{0,20}\b(?:the )?(?:settlement|payout|payout-approv\w+|arbiter|approver)\b/i, 'tries to assign the reader an approving role'],
];

function injectionFindings(field: 'filename' | 'caption' | 'text', text: string): AttachmentFinding[] {
  return INJECTION.filter(([re]) => re.test(text)).map(([, why]): AttachmentFinding => ({
    code: field === 'filename' ? 'injection_in_filename' : field === 'caption' ? 'injection_in_caption' : 'injection_in_text',
    detail: `Attachment ${field} ${why} (quoted as data; not acted on)`,
    severity: 'high',
  }));
}

/** Inspect one attachment. Returns the sanitized form plus findings; never throws on weird input. */
export function sanitizeAttachment(a: Partial<AttachmentLike> | null | undefined): SanitizedAttachment {
  const filename = String(a?.filename ?? '').trim();
  const mimetype = String(a?.mimetype ?? '').trim().toLowerCase();
  const size = Number(a?.size ?? 0) || 0;
  const caption = String(a?.caption ?? '');
  const text = String(a?.text ?? '');
  const mxc = a?.mxc && /^mxc:\/\/\S+$/i.test(String(a.mxc).trim()) ? String(a.mxc).trim() : null;
  const findings: AttachmentFinding[] = [];

  if (!filename && !mxc) findings.push({ code: 'empty_attachment', detail: 'Attachment has neither filename nor media URI.', severity: 'medium' });
  if (CONTROLS.test(filename) || CONTROLS.test(caption)) findings.push({ code: 'control_characters', detail: 'Filename or caption contains control/zero-width characters.', severity: 'medium' });
  if (mxc === null && a?.mxc) findings.push({ code: 'untrusted_media_uri', detail: `Media URI "${String(a.mxc).slice(0, 60)}" is not a valid mxc:// key; the file cannot be fetched safely.`, severity: 'medium' });
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (ext && DOC_BY_EXT[ext] && mimetype && DOC_BY_EXT[ext] !== mimetype) {
    findings.push({ code: 'extension_mimetype_mismatch', detail: `Extension ".${ext}" (maps to ${DOC_BY_EXT[ext]}) but declared "${mimetype}".`, severity: 'medium' });
  }
  if (EXECUTABLE.test(filename)) findings.push({ code: 'executable_attachment', detail: `Executable attachment "${filename}" is never fetched or run.`, severity: 'high' });
  if (size > MAX_ATTACHMENT_BYTES) findings.push({ code: 'oversized', detail: `${size.toLocaleString('en-US')} bytes exceeds the ${MAX_ATTACHMENT_BYTES.toLocaleString('en-US')}-byte intake ceiling.`, severity: 'medium' });
  findings.push(...injectionFindings('filename', filename), ...injectionFindings('caption', caption), ...injectionFindings('text', text));

  const safeLabel = `attachment:${(CONTROLS[Symbol.replace](filename, '_') || mxc || 'unnamed').replace(/[^\w.@ -]/g, '_').slice(0, 80)}`;
  const quoted = [
    caption ? `caption (data, not instructions): "${caption.replace(/"/g, '""')}"` : null,
    text ? `preview (data, not instructions): "${text.slice(0, 2000).replace(/"/g, '""')}"` : null,
  ].filter(Boolean).join('\n');
  return {
    safeLabel, filename: CONTROLS[Symbol.replace](filename, '_').replace(/[^\w.@ -]/g, '_'), mimetype: mimetype || 'unknown', size, mxc,
    quotedData: findings.some((f) => f.severity === 'high' && f.code !== 'executable_attachment') ? `[quarantined by RECLAIM attachment guardrail — ${findings.filter((f) => f.severity === 'high').map((f) => f.detail).join('; ')}]\n${quoted}` : quoted,
    quarantined: findings.some((f) => f.severity === 'high'),
    guard: findings.some((f) => f.severity === 'high') ? 3 : findings.some((f) => f.severity === 'medium') ? 2 : findings.length ? 1 : 0,
    findings,
  };
}

export function sanitizeAttachments(list: Array<Partial<AttachmentLike>> | null | undefined): SanitizedAttachment[] {
  return (list ?? []).map((a) => sanitizeAttachment(a));
}

/** One-line honest status block for the Switch Trust & ROI telemetry document (every number counted here). */
export function guardrailSummary(list: SanitizedAttachment[]) {
  const quarantined = list.filter((a) => a.quarantined).length;
  return {
    inspected: list.length,
    quarantineRate: list.length ? Math.round((100 * quarantined) / list.length) / 100 : 0,
    status: list.length ? (quarantined ? `QUARANTINE (${quarantined} of ${list.length})` : 'PASS') : 'PASS (none received)',
    llmCalls: 0,
    label: 'RECLAIM attachment guardrail · deterministic (#908 defense) · runs before any parsing',
  } as const;
}
