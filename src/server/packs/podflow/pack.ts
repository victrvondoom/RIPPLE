import { z } from 'zod';
import { EngineError, type AnalysisContext, type ChangeItem, type CompletionContext, type RoleResult, type WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const platform = z.object({ label: z.string(), maxClipSec: z.number().int().positive(), titleMax: z.number().int().positive(), captionMax: z.number().int().positive() });
export const planSchema = z.object({
  episode: z.object({ title: z.string().min(1), show: z.string().min(1), number: z.number().int().positive(), durationMin: z.number().positive(), recordedOn: date, host: z.string().min(1), guests: z.array(z.string()).default([]) }),
  sourceArtifacts: z.array(z.object({ id: z.string(), kind: z.enum(['audio', 'video', 'transcript', 'show_notes']), ref: z.string(), available: z.boolean() })),
  platforms: z.record(z.string(), platform),
  style: z.object({ tone: z.string(), hashtagsMax: z.number().int().min(0).max(10), maxCandidates: z.number().int().min(1).max(8).default(4) }),
  transcript: z.array(z.any()).default([]), selectedClips: z.array(z.number()).default([]), kits: z.array(z.any()).default([]),
});
export const changeSchema = z.object({
  receivedOn: date, creatorNotes: z.string().max(2000).default(''), platforms: z.array(z.string()).min(1),
  segments: z.array(z.object({ startSec: z.number().min(0), endSec: z.number().positive(), speaker: z.string().min(1), text: z.string().min(1).max(2000) })).min(1),
});
type Plan = z.infer<typeof planSchema>; type Ch = z.infer<typeof changeSchema>; type Seg = Ch['segments'][number];
const STOP = new Set('about their there would which could really think thing these those being going where while because people other still every first after before under again never always something someone little right years year just like know very much when what that this with from have they them then than were been your yours ours into over also only such even most some make made does doing done'.split(' '));
const STRONG = /\b(biggest|worst|best|mistake|secret|surprising|incredible|never|always|nobody|everyone|terrified|obsessed|changed everything|game.?changer)\b/gi;
const CLAIM_RULES: [string, RegExp, string][] = [
  ['statistic', /\b\d+(\.\d+)?\s?(%|percent|x\b|times)|\$\s?\d[\d,]*|\b\d{2,}[,\d]*\s?(customers|orders|downloads|people|users|sales)\b/i, 'Numeric claim — confirm the figure and its source'],
  ['research_claim', /\b(study|studies|research|survey|scientists?|report(ed)? (shows?|found)|according to)\b/i, 'Cites research — confirm the source exists and says this'],
  ['absolute', /\b(always|never|everyone|nobody|guaranteed|100\s?%|every single)\b/i, 'Absolute wording — soften or confirm'],
  ['superlative', /\b(the best|the worst|the biggest|the most|number one|#1)\b/i, 'Superlative — verify or reword'],
  ['advice_regulated', /\b(invest(ing|ment)?|returns?|tax(es)?|medical|doctor|diagnos\w+|cure[sd]?|legal)\b/i, 'Touches money/health/legal — add a disclaimer or verify with a qualified source'],
];
export interface Cand { n: number; startSec: number; endSec: number; dur: number; text: string; score: number; reasons: string[]; flags: { type: string; snippet: string; advice: string }[]; speakers: string[]; trims: { platform: string; max: number; suggestedEnd: number }[] }
const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).replace(/\s+\S*$/, '') + '…');
const sentence = (t: string) => (t.match(/[^.!?]+[.!?]?/)?.[0] ?? t).trim();
const kw = (text: string, n: number) => { const f = new Map<string, number>(); for (const w of text.toLowerCase().match(/[a-z]{5,}/g) ?? []) if (!STOP.has(w)) f.set(w, (f.get(w) ?? 0) + 1); return [...f.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w); };

export function coverage(plan: Plan, segs: Seg[]) {
  const total = plan.episode.durationMin * 60; const sorted = [...segs].sort((a, b) => a.startSec - b.startSec); let covered = 0; let end = 0; const gaps: [number, number][] = [];
  for (const s of sorted) { if (s.startSec > end + 1) gaps.push([end, s.startSec]); covered += Math.max(0, s.endSec - Math.max(s.startSec, end)); end = Math.max(end, s.endSec); }
  if (end < total - 1) gaps.push([end, total]);
  return { total, covered, pct: covered / total, gaps: gaps.filter(([a, b]) => b - a >= 60), beyond: sorted.filter((s) => s.endSec > total + 1) };
}
/** Deterministic highlight finder over transcript TEXT (no audio/video is ever analysed). */
export function candidates(plan: Plan, segs: Seg[], platforms: string[]): Cand[] {
  const maxes = platforms.map((p) => plan.platforms[p]?.maxClipSec ?? 60); const win = Math.min(90, Math.max(...maxes, 30)); const sorted = [...segs].sort((a, b) => a.startSec - b.startSec); const all: Cand[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i; j < Math.min(i + 3, sorted.length); j++) {
    const part = sorted.slice(i, j + 1); const start = part[0].startSec; const end = part[part.length - 1].endSec; const dur = end - start;
    if (dur < 20 || dur > win) continue; if (part.some((s, k) => k && s.startSec - part[k - 1].endSec > 3)) continue;
    const text = part.map((s) => s.text).join(' '); const reasons: string[] = []; let score = 0;
    if (/\?/.test(text)) { score += 2; reasons.push('contains a question hook'); }
    if (/^[A-Z"“]/.test(part[0].text) && /[.!?”"]$/.test(part[part.length - 1].text)) { score += 1; reasons.push('starts and ends on complete sentences'); }
    const strong = Math.min(3, (text.match(STRONG) ?? []).length); if (strong) { score += strong; reasons.push(`${strong} strong-language cue(s)`); }
    if (/\d/.test(text)) { score += 1; reasons.push('concrete number'); }
    if (/\b(when i|one time|the day|i remember|we almost|story)\b/i.test(text)) { score += 2; reasons.push('story marker'); }
    const speakers = [...new Set(part.map((s) => s.speaker))]; if (speakers.length > 1) { score += 1; reasons.push('dialogue between speakers'); }
    if (dur >= 30 && dur <= 60) { score += 1; reasons.push('30–60s sweet spot'); }
    const flags = CLAIM_RULES.flatMap(([type, re, advice]) => { const m = re.exec(text); return m ? [{ type, snippet: text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25).trim(), advice }] : []; });
    const trims = platforms.filter((p) => dur > (plan.platforms[p]?.maxClipSec ?? 60)).map((p) => { const max = plan.platforms[p].maxClipSec; const cut = [...part].reverse().find((s) => s.endSec - start <= max); return { platform: p, max, suggestedEnd: cut ? cut.endSec : start + max }; });
    all.push({ n: 0, startSec: start, endSec: end, dur, text, score, reasons, flags, speakers, trims });
  }
  all.sort((a, b) => b.score - a.score || a.startSec - b.startSec); const picked: Cand[] = [];
  for (const c of all) { if (picked.length >= plan.style.maxCandidates) break; if (picked.some((p) => c.startSec < p.endSec && c.endSec > p.startSec)) continue; picked.push(c); }
  return picked.map((c, i) => ({ ...c, n: i + 1 }));
}
/** The approval is bound to the exact candidate set it was given for: a revised transcript produces a new key, so an old "1,3" can never be applied to different clips. */
const fp = (cs: Cand[]) => { let h = 5381; for (const ch of cs.map((c) => `${c.startSec}-${c.endSec}`).join('|')) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return h.toString(36); };
const selKey = (cs: Cand[]) => `clip_selection_${fp(cs)}`;
const sel = (plan: Plan, cs: Cand[], a: AnalysisContext['answers']): number[] | null => { const v = a[selKey(cs)]?.value as number[] | undefined; return v ? v.filter((n) => cs.some((c) => c.n === n)) : null; };

function detect(plan: Plan, ch: Ch, a: AnalysisContext['answers'] = {}): ChangeItem[] {
  const unknown = ch.platforms.filter((p) => !plan.platforms[p]); if (unknown.length) throw new EngineError(422, 'unknown_platform', `Unknown platform(s): ${unknown.join(', ')}. Configured: ${Object.keys(plan.platforms).join(', ')}.`);
  const cv = coverage(plan, ch.segments); const cs = candidates(plan, ch.segments, ch.platforms); const items: ChangeItem[] = [];
  items.push({ field: 'transcript.added', label: 'Transcript text', before: plan.transcript.length ? `${plan.transcript.length} segments` : 'none', after: `${ch.segments.length} segments · ${(cv.covered / 60).toFixed(1)} of ${plan.episode.durationMin} min (${Math.round(cv.pct * 100)}%)`, kind: 'added', severity: cv.pct < 0.9 ? 'high' : 'low', note: 'Source is transcript TEXT; audio/video were not processed' });
  for (const [s, e] of cv.gaps) items.push({ field: 'transcript.gap', label: `Transcript gap ${fmt(s)}–${fmt(e)}`, before: 'expected speech', after: 'no text', kind: 'removed', severity: 'medium', note: 'Anything said here cannot be clipped' });
  for (const b of cv.beyond) items.push({ field: 'transcript.beyond', label: `Segment past episode end (${fmt(b.endSec)})`, before: `${plan.episode.durationMin} min`, after: fmt(b.endSec), kind: 'modified', severity: 'medium' });
  if (plan.sourceArtifacts.some((x) => ['audio', 'video'].includes(x.kind))) items.push({ field: 'source.media_not_processed', label: 'Audio/video not processed', before: 'media referenced', after: 'transcript text only', kind: 'modified', severity: 'low' });
  for (const c of cs) items.push({ field: `highlight.${c.n}`, label: `Highlight candidate ${c.n} (${fmt(c.startSec)}–${fmt(c.endSec)})`, before: '—', after: `score ${c.score}`, kind: 'added', severity: 'low', note: c.reasons.join('; ') });
  for (const c of cs) for (const f of c.flags) items.push({ field: `claim.${c.n}.${f.type}`, label: `Clip ${c.n}: ${f.type.replace(/_/g, ' ')}`, before: 'unchecked', after: 'needs verification', kind: 'modified', severity: 'medium', note: f.snippet });
  for (const p of ch.platforms) items.push({ field: `platform.${p}`, label: `Target: ${plan.platforms[p]?.label ?? p}`, before: '—', after: `${plan.platforms[p]?.maxClipSec ?? '?'}s max clip`, kind: 'added', severity: 'low' });
  void a; return items;
}
function apply(plan: Plan, ch: Ch, answers: AnalysisContext['answers']): Plan {
  const p: Plan = structuredClone(plan); p.transcript = ch.segments; const cs = candidates(plan, ch.segments, ch.platforms); p.selectedClips = sel(plan, cs, answers) ?? [];
  (p as any).targetPlatforms = ch.platforms; (p as any).candidates = cs.map((c) => ({ n: c.n, startSec: c.startSec, endSec: c.endSec }));
  if (p.selectedClips.length) p.kits.push({ receivedOn: ch.receivedOn, clips: p.selectedClips, platforms: ch.platforms, sourceKind: 'transcript_text' });
  return p;
}
const A = 'rule-engine/podflow';
const SRC = 'SOURCE: transcript text only — no audio or video was processed by RIPPLE.';
function analyze(role: string, ctx: AnalysisContext): RoleResult {
  const plan = ctx.plan as Plan, ch = ctx.change as Ch; const cv = coverage(plan, ch.segments); const cs = candidates(plan, ch.segments, ch.platforms); const chosen = sel(plan, cs, ctx.answers); const block = chosen === null;
  const picked = cs.filter((c) => chosen?.includes(c.n));
  if (role === 'intake') {
    const o = new Out(role, `${A}-intake@1`);
    o.info(`${ch.segments.length} transcript segments, ${(cv.covered / 60).toFixed(1)} of ${plan.episode.durationMin} min covered (${Math.round(cv.pct * 100)}%). ${SRC}`);
    if (cv.pct < 0.9) o.warn(`Transcript covers only ${Math.round(cv.pct * 100)}% of the episode; gaps at ${cv.gaps.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', ') || 'the end'}. Highlights can only come from the text provided.`, true);
    for (const b of cv.beyond) o.warn(`Segment ending ${fmt(b.endSec)} is past the stated episode length.`, true);
    for (const m of plan.sourceArtifacts.filter((x) => ['audio', 'video'].includes(x.kind))) o.warn(`${m.kind} "${m.ref}" is ${m.available ? 'available' : 'NOT available'} but is NOT processed in this version — timestamps come from the transcript and must be checked against the real media.`, true);
    o.work({ key: 'pf-media-check', title: 'Check selected clip timestamps against the real audio/video', detail: 'RIPPLE only saw transcript text. Listen to each selected clip boundary before publishing.', department: 'Creator Studio', roleKey: 'human_creator', kind: 'review', artifactKey: 'content_kit' });
    return o.done(`Transcript ${Math.round(cv.pct * 100)}% coverage; media not processed.`);
  }
  if (role === 'highlights') {
    const o = new Out(role, `${A}-highlights@1`);
    for (const c of cs) o.info(`Candidate ${c.n} ${fmt(c.startSec)}–${fmt(c.endSec)} (${Math.round(c.dur)}s, score ${c.score}): ${c.reasons.join('; ')}${c.trims.length ? ` — too long for ${c.trims.map((t) => `${t.platform} (${t.max}s)`).join(', ')}` : ''}`);
    if (!cs.length) o.warn('No highlight-sized windows (20–90s of continuous text) found.', true);
    o.ask({ key: selKey(cs), text: `Which highlight clips do you approve? Candidates: ${cs.map((c) => `${c.n} (${fmt(c.startSec)}–${fmt(c.endSec)}, ${Math.round(c.dur)}s)`).join('; ')}. Answer with numbers like "1,3" or "all".`, blocking: true, assigneeRole: 'human_creator' });
    o.draft({ kind: 'highlight_candidates', name: 'Highlight candidates', artifactKey: 'highlight_candidates', content: `# Highlight candidates (text-based)\n\n${SRC}\n\n${table(['#', 'Time', 'Dur', 'Score', 'Why', 'Claims to verify'], cs.map((c) => [c.n, `${fmt(c.startSec)}–${fmt(c.endSec)}`, `${Math.round(c.dur)}s`, c.score, c.reasons.join('; '), c.flags.length]))}\n\n${cs.map((c) => `### Clip ${c.n}\n> ${c.text}`).join('\n\n')}` });
    return o.done(`${cs.length} candidate(s) proposed; creator must choose.`);
  }
  if (role === 'factcheck') {
    const o = new Out(role, `${A}-factcheck@1`);
    for (const c of cs) for (const f of c.flags) (chosen?.includes(c.n) ? o.risk : o.warn).call(o, `Clip ${c.n} — ${f.type.replace(/_/g, ' ')}: "…${f.snippet}…" — ${f.advice}. RIPPLE has NOT verified this.`);
    for (const c of picked) for (const f of c.flags) o.work({ key: `pf-fc-${c.n}-${f.type}`, title: `Verify claim in clip ${c.n} (${f.type.replace(/_/g, ' ')}): “${clip(f.snippet, 60)}”`, detail: f.advice, department: 'Creator Studio', roleKey: 'human_creator', kind: 'review', artifactKey: 'factcheck_log' });
    o.draft({ kind: 'factcheck_log', name: 'Fact-check & uncertainty log', artifactKey: 'factcheck_log', content: `# Fact-check log${block ? ' (PROVISIONAL: no clips approved yet)' : ''}\n\n${table(['Clip', 'Type', 'Snippet', 'Advice', 'Status'], cs.flatMap((c) => c.flags.map((f) => [c.n, f.type, `…${f.snippet}…`, f.advice, chosen?.includes(c.n) ? 'creator must verify' : 'not selected'])))}\n\nNothing here has been verified by RIPPLE.` });
    return o.done(`${cs.reduce((n, c) => n + c.flags.length, 0)} uncertainty flag(s); ${picked.reduce((n, c) => n + c.flags.length, 0)} on selected clips.`);
  }
  if (role === 'copy') {
    const o = new Out(role, `${A}-copy@1`); const tags = (c: Cand) => kw(c.text, plan.style.hashtagsMax).map((w) => `#${w}`).join(' ');
    for (const c of picked) for (const t of c.trims) o.warn(`Clip ${c.n} is ${Math.round(c.dur)}s; ${plan.platforms[t.platform].label} allows ${t.max}s — suggested trim: end at ${fmt(t.suggestedEnd)}.`);
    const lines = picked.flatMap((c) => {
      const h = sentence(c.text); const titleA = clip(h, Math.min(...ch.platforms.map((p) => plan.platforms[p].titleMax))); const titleB = clip(`${plan.episode.show} #${plan.episode.number}: ${kw(c.text, 1)[0] ?? 'highlight'}`, 100);
      return [`CLIP ${c.n} | ${fmt(c.startSec)}–${fmt(c.endSec)} | ${Math.round(c.dur)}s`, `TITLE[A]: ${titleA}`, `TITLE[B]: ${titleB}`, ...ch.platforms.map((p) => `CAPTION[${p}]: ${clip(`${h} ${tags(c)}`.trim(), plan.platforms[p].captionMax)}`), ...c.trims.map((t) => `TRIM[${t.platform}]: end at ${fmt(t.suggestedEnd)} (max ${t.max}s)`), ...c.flags.map((f) => `FLAG: ${f.type} — …${f.snippet}… (creator must verify)`), ''];
    });
    const lp = ch.platforms.find((p) => /long/.test(p)); const descMax = lp ? plan.platforms[lp].captionMax : 5000;
    const desc = clip(`${plan.episode.title} — ${plan.episode.show} #${plan.episode.number} with ${plan.episode.host}${plan.episode.guests.length ? ` and ${plan.episode.guests.join(', ')}` : ''}.\n\nChapters:\n${picked.map((c) => `${fmt(c.startSec)} ${clip(sentence(c.text), 70)}`).join('\n')}\n\nTranscript-based summary; verify claims before publishing.`, descMax);
    o.draft({ kind: 'content_kit', name: 'Content kit', artifactKey: 'content_kit', content: [`# Content kit — ${plan.episode.title}${block ? ' (PROVISIONAL)' : ''}`, SRC, `Platforms: ${ch.platforms.map((p) => plan.platforms[p].label).join(', ')}`, '', ...lines, `DESCRIPTION[${lp ?? 'long'}]:`, desc, '', `Creator notes: ${ch.creatorNotes || '—'}`].join('\n') });
    return o.done(`Titles, captions and description drafted for ${picked.length} clip(s).`);
  }
  const o = new Out(role, `${A}-publisher@1`);
  const steps = picked.flatMap((c) => ch.platforms.map((p) => ({ c, p })));
  for (const { c, p } of steps) o.work({ key: `pf-up-${c.n}-${p}`, title: `Upload clip ${c.n} to ${plan.platforms[p].label} and schedule`, detail: `Timestamps ${fmt(c.startSec)}–${fmt(c.endSec)}; use the approved caption from the content kit.`, department: 'Creator Studio', roleKey: 'human_creator', kind: 'task', artifactKey: 'publish_checklist', dependsOn: ['pf-media-check'] });
  o.draft({ kind: 'publish_checklist', name: 'Publishing checklist', artifactKey: 'publish_checklist', content: `# Publishing checklist — ${plan.episode.title}\n\n- [ ] Clip timestamps checked against the real audio/video\n${picked.flatMap((c) => c.flags.map((f) => `- [ ] Verified claim in clip ${c.n} (${f.type.replace(/_/g, ' ')})`)).join('\n')}\n${steps.map(({ c, p }) => `- [ ] Clip ${c.n} uploaded to ${plan.platforms[p].label}`).join('\n')}\n- [ ] Descriptions and hashtags pasted\n- [ ] Links added to show notes\n\nChecklist state is tracked in RIPPLE; RIPPLE does not publish anything.` });
  if (!block) {
    o.act({ key: 'export_kit', type: 'export_content_kit', title: 'Export the approved content kit', connector: 'document_store', ownerRole: 'human_creator', consequential: true, draftKind: 'content_kit', approvalRole: 'manager', ackRoles: [], rationale: 'Freezes the titles, captions and clip list you will publish from.', target: 'Content kit folder', effectKey: 'content-kit' });
    o.act({ key: 'export_checklist', type: 'export_publish_checklist', title: 'Export the publishing checklist', connector: 'document_store', ownerRole: 'human_creator', consequential: true, draftKind: 'publish_checklist', approvalRole: 'manager', ackRoles: [], rationale: 'Creates the checklist you will tick through.', target: 'Content kit folder', effectKey: 'publish-checklist' });
  }
  return o.done(`${steps.length} upload task(s); ${o.actions.length} action(s) proposed.`);
}

export const podFlowPack: WorkflowPack = {
  tier: 'core', system: 'creative',
  id: 'podflow', name: 'PodFlow', domain: 'Creator Production', version: '1.0.0',
  description: 'Turn an episode transcript into a reviewable content kit: highlight candidates, clip approval, platform-limited titles and captions, fact-check flags and a publishing checklist. Transcript-text only — no audio/video processing.',
  labels: { baseline: 'Episode & sources', change: 'Transcript intake', changeVerb: 'Submit transcript', plan: 'episode', mission: 'Content kit', blurb: 'Transcript → clips → captions → checklist' },
  agentLimit: 'Analyzes text transcripts; never claims media/video was processed',
  roles: [
    { key: 'intake', name: 'Transcript Intake Agent', kind: 'agent', responsibility: 'Checks transcript coverage and states what media was NOT processed.', department: 'Creator Studio' },
    { key: 'highlights', name: 'Highlight Agent', kind: 'agent', responsibility: 'Scores text windows and proposes clip candidates.', department: 'Creator Studio' },
    { key: 'factcheck', name: 'Fact-check Agent', kind: 'agent', responsibility: 'Flags claims the creator must verify; verifies nothing itself.', department: 'Creator Studio' },
    { key: 'copy', name: 'Copy Agent', kind: 'agent', responsibility: 'Titles, captions, hashtags and description within platform limits.', department: 'Creator Studio' },
    { key: 'coordinator', name: 'Publishing Agent', kind: 'agent', responsibility: 'Builds the publishing checklist and requests approvals.', department: 'Creator Studio' },
    { key: 'human_creator', name: 'Creator (human)', kind: 'human', responsibility: 'Chooses clips, verifies claims, checks timestamps, publishes.', department: 'Creator Studio' },
  ],
  roleOrder: ['intake', 'highlights', 'factcheck', 'copy', 'coordinator'],
  planSchema, changeSchema,
  artifacts: [
    { key: 'transcript', label: 'Transcript (text)', department: 'Creator Studio', ownerRole: 'human_creator', description: 'Timestamped source text' },
    { key: 'highlight_candidates', label: 'Highlight candidates', department: 'Creator Studio', ownerRole: 'human_creator', description: 'Scored windows' },
    { key: 'factcheck_log', label: 'Fact-check log', department: 'Creator Studio', ownerRole: 'human_creator', description: 'Claims to verify' },
    { key: 'captions_titles', label: 'Titles & captions', department: 'Creator Studio', ownerRole: 'human_creator', description: 'Platform-limited copy' },
    { key: 'content_kit', label: 'Content kit', department: 'Creator Studio', ownerRole: 'human_creator', description: 'Everything to publish from' },
    { key: 'publish_checklist', label: 'Publishing checklist', department: 'Creator Studio', ownerRole: 'human_creator', description: 'Steps and completion state' },
  ],
  rules: [
    { id: 'tx', trigger: (i) => i.field.startsWith('transcript.') || i.field.startsWith('source.'), to: 'transcript', relation: 'sources', why: 'Everything derives from the text' },
    { id: 'hl', trigger: (i) => i.field === 'transcript.added', to: 'highlight_candidates', relation: 'yields', why: 'Windows are scored from the text' },
    { id: 'cl', trigger: (i) => i.field.startsWith('claim.'), to: 'factcheck_log', relation: 'flags', why: 'Claims need checking' },
    { id: 'pl', trigger: (i) => i.field.startsWith('platform.'), to: 'captions_titles', relation: 'constrains', why: 'Platform limits shape copy' },
    { id: 'hc', trigger: (i) => i.field.startsWith('highlight.'), to: 'captions_titles', relation: 'needs_copy', why: 'Each clip needs titles/captions' },
  ],
  artifactEdges: [
    { from: 'highlight_candidates', to: 'content_kit', relation: 'selected_into', why: 'Approved clips enter the kit' },
    { from: 'captions_titles', to: 'content_kit', relation: 'feeds', why: 'Copy enters the kit' },
    { from: 'factcheck_log', to: 'content_kit', relation: 'gates', why: 'Flags travel with the kit' },
    { from: 'content_kit', to: 'publish_checklist', relation: 'drives', why: 'Checklist steps come from the kit' },
  ],
  decisions: [{ key: 'approve_kit', label: 'Approve content kit', ownerRole: 'human_creator', gates: ['content_kit'] }, { key: 'approve_checklist', label: 'Approve publishing checklist', ownerRole: 'human_creator', gates: ['publish_checklist'] }],
  sample: () => {
    const L: [string, number, string][] = [
      ['Rina', 50, 'Thanks for having me. I started the shop in my spare bedroom with a secondhand kiln and no plan.'],
      ['Host', 40, 'So what was the biggest mistake you made in year one?'],
      ['Rina', 55, 'Honestly, pricing. I charged almost nothing because I was terrified nobody would buy. We almost closed in month eight.'],
      ['Host', 30, 'And what changed?'],
      ['Rina', 45, 'I raised prices by 40% and sales went up. A study from a Stanford pricing lab showed that people read low prices as low quality, and I believe that, because my customers literally told me so.'],
      ['Host', 35, 'That is wild. Did you lose your early customers?'],
      ['Rina', 65, 'Some of them, yes. But one time a customer drove four hours to buy a set of mugs and cried at the counter. That is when I knew we were building something real.'],
      ['Host', 45, 'Let us talk about wholesale. Everyone says wholesale is the only way to scale.'],
      ['Rina', 50, 'Wholesale is never worth it for a small studio. You always lose margin, and returns can wipe you out. We did 300% growth online last year without a single wholesale account.'],
      ['Host', 40, 'What does your week look like now?'],
      ['Rina', 55, 'Mondays are packing, Tuesdays are glazing, and Fridays I film behind the scenes. That content is incredible for sales.'],
      ['Host', 50, 'How do you handle burnout?'],
      ['Rina', 60, 'I closed the shop on Sundays. It sounds small but it changed everything. If you invest in rest, the work gets better.'],
      ['Host', 35, 'Any advice for someone starting out today?'],
      ['Rina', 65, 'Start before you are ready. The best first product is the one you can make twenty of this month, not the one you dream about.'],
      ['Host', 40, 'What is next for the shop?'],
      ['Rina', 50, 'A teaching studio. We already have 120 people on the waitlist, and I want classes to feel like a living room, not a lecture.'],
      ['Host', 30, 'Where can people find you?'],
      ['Rina', 40, 'At the shop name dot com, and we post new drops every second Thursday.'],
    ];
    let t = 0; const segs = L.map(([speaker, d0, text]) => { const d = Math.round(d0 * 1.7); const s = { startSec: t, endSec: t + d, speaker, text }; t += d + 1; return s; });
    return { title: 'Episode 42 — Small Shop Stories', plan: { episode: { title: 'Pricing, Burnout and Starting Before You Are Ready', show: 'Small Shop Stories', number: 42, durationMin: 30, recordedOn: '2026-10-28', host: 'Host', guests: ['Rina Alvarez'] },
      sourceArtifacts: [{ id: 'src-audio', kind: 'audio', ref: 'ep42-master.wav', available: false }, { id: 'src-notes', kind: 'show_notes', ref: 'ep42-notes.md', available: true }],
      platforms: { youtube_shorts: { label: 'YouTube Shorts', maxClipSec: 60, titleMax: 100, captionMax: 150 }, instagram_reels: { label: 'Instagram Reels', maxClipSec: 90, titleMax: 60, captionMax: 2200 }, x: { label: 'X', maxClipSec: 140, titleMax: 100, captionMax: 280 }, youtube_long: { label: 'YouTube (full episode)', maxClipSec: 3600, titleMax: 100, captionMax: 5000 } },
      style: { tone: 'warm, curious', hashtagsMax: 3, maxCandidates: 4 }, transcript: [], selectedClips: [], kits: [] },
      change: { receivedOn: '2026-11-03', creatorNotes: 'Transcript exported from the recording tool (text only). Please find clips for Shorts and X.', platforms: ['youtube_shorts', 'x'], segments: segs } };
  },
  detectChanges: detect, applyChange: apply, analyzeRole: analyze,
  parseAnswer(key, text) {
    if (key.startsWith('clip_selection')) { const t = text.trim().toLowerCase(); if (t === 'all') return { value: [1, 2, 3, 4, 5, 6, 7, 8] }; const n = [...new Set((t.match(/\d+/g) ?? []).map(Number))]; return n.length && /^[\d\s,;and]+$/.test(t) ? { value: n } : { error: 'Answer with clip numbers such as "1,3" or "all".' }; }
    return text.trim() ? { value: text.trim() } : { error: 'Answer cannot be empty.' };
  },
  completionChecks(ctx: CompletionContext) { const p = ctx.revisedPlan as Plan; return [{ key: 'pf_selection', label: 'At least one clip approved by the creator', passed: p.selectedClips.length > 0, detail: p.selectedClips.length ? `Clips ${p.selectedClips.join(', ')} approved` : 'No clip approved' }]; },
  verifyAction(action, observed, revised: Plan) {
    const c = observed.content; const out: { name: string; passed: boolean; detail: string }[] = []; const tp: string[] = (revised as any).targetPlatforms ?? [];
    const bad = /\b(audio (was|has been) (analy[sz]ed|processed)|waveform|transcribed from (the )?audio|we (listened|watched))\b/i.exec(c); out.push({ name: 'does not claim media was processed', passed: !bad, detail: bad ? `contains "${bad[0]}"` : 'no media-processing claim' });
    if (action.type === 'export_content_kit') {
      const cs = candidates(revised, revised.transcript as Seg[], tp).filter((x) => revised.selectedClips.includes(x.n));
      out.push({ name: 'source labelled as transcript text', passed: c.includes(SRC), detail: 'explicit source label present' });
      out.push({ name: 'every approved clip present with timestamps', passed: cs.every((x) => c.includes(`CLIP ${x.n} | ${fmt(x.startSec)}–${fmt(x.endSec)}`)), detail: `${cs.length} clip(s)` });
      const over = [...c.matchAll(/CAPTION\[(\w+)\]: (.*)/g)].filter((m) => revised.platforms[m[1]] && m[2].length > revised.platforms[m[1]].captionMax); out.push({ name: 'captions within platform limits', passed: !over.length, detail: over.length ? `${over[0][1]} caption is ${over[0][2].length} chars` : `${[...c.matchAll(/CAPTION\[/g)].length} caption(s) checked` });
      const tover = [...c.matchAll(/TITLE\[[AB]\]: (.*)/g)].filter((m) => m[1].length > 100); out.push({ name: 'titles within 100 characters', passed: !tover.length, detail: `${[...c.matchAll(/TITLE\[/g)].length} title(s) checked` });
      out.push({ name: 'every uncertainty flag travels with the kit', passed: cs.every((x) => x.flags.every((f) => c.includes(`FLAG: ${f.type}`))), detail: `${cs.reduce((n, x) => n + x.flags.length, 0)} flag(s)` });
    }
    if (action.type === 'export_publish_checklist') out.push({ name: 'checklist includes media check', passed: /real audio\/video/.test(c), detail: 'media-check step present' });
    return out;
  },
};
