/**
 * OfferRoom domain logic: profile helpers, explainable fit score, the TRUTH GUARD, resume critique and mock interviews.
 * Ported from OfferRoom (MIT, github.com/roshan62varma-bot/offerroom: fit.py, tailor.py, interview.py, profile.py).
 * Pure functions, no I/O, no model: everything here is deterministic and unit-tested.
 */
import { IMPLIES, canonicalSkill, extractSkills, gapProject, skillCategory } from './skills.js';

export type Level = 'intern' | 'entry' | 'mid' | 'senior';
export interface Edu { id: string; school: string; degree?: string; field?: string; start?: string; end?: string; grade?: string; coursework?: string[] }
export interface Exp { id: string; company: string; role: string; type?: string; start?: string; end?: string; bullets: string[] }
export interface Proj { id: string; name: string; tech: string[]; bullets: string[]; link?: string }
export interface Profile {
  name: string; email?: string; location?: string; headline: string; summary: string;
  education: Edu[]; experience: Exp[]; projects: Proj[]; skills: string[]; achievements: string[];
  preferences: { roles: string[]; locations: string[]; remote_ok: boolean; relocate?: boolean; level: Level };
}
export interface Job { id: string; title: string; company: string; location: string; remote: boolean; level: Level; minYears?: number; required: string[]; preferred: string[]; description: string }
export interface Tailored {
  headline: string; summary: string; skills: string[];
  experience: { id: string; bullets: string[] }[]; projects: { id: string; bullets: string[] }[]; achievements: string[];
}
export interface TruthIssue { severity: 'block' | 'warn'; path: string; message: string }

const PREFIX = { education: 'edu', experience: 'exp', projects: 'proj' } as const;
export const SECTIONS = ['education', 'experience', 'projects'] as const;

/** Assigns stable ids (exp-1, proj-2…) to entries that lack one, and trims bullets. Idempotent. */
export function normalizeProfile(raw: any): Profile {
  const p = structuredClone(raw) as any;
  for (const sec of SECTIONS) {
    const list: any[] = Array.isArray(p[sec]) ? p[sec] : [];
    const used = new Set(list.map((e) => e.id).filter(Boolean));
    let n = 1;
    p[sec] = list.map((e) => {
      const out = { ...e };
      if (!out.id) { while (used.has(`${PREFIX[sec]}-${n}`)) n++; out.id = `${PREFIX[sec]}-${n}`; used.add(out.id); }
      out.bullets = (out.bullets ?? []).map((b: string) => String(b).trim()).filter(Boolean);
      if (sec === 'projects') out.tech = out.tech ?? [];
      return out;
    });
  }
  p.skills = p.skills ?? []; p.achievements = p.achievements ?? [];
  p.preferences = { roles: [], locations: [], remote_ok: true, level: 'entry', ...(p.preferences ?? {}) };
  return p as Profile;
}

export const entryLabel = (p: Profile, id: string): string => {
  for (const e of p.education) if (e.id === id) return e.school;
  for (const e of p.experience) if (e.id === id) return `${e.role} @ ${e.company}`;
  for (const e of p.projects) if (e.id === id) return e.name;
  return id;
};

/** Every skill the profile can back up -> where it shows up ('skills' or an entry id). Implied skills (Pytest ⇒ Unit Testing) included. */
export function allSkills(p: Profile): Record<string, string[]> {
  const where: Record<string, string[]> = {};
  const add = (s: string, w: string) => { const list = (where[s] ??= []); if (!list.includes(w)) list.push(w); };
  for (const s of p.skills) add(canonicalSkill(s), 'skills');
  for (const sec of ['experience', 'projects'] as const) for (const e of p[sec] as any[]) {
    const tech: string[] = e.tech ?? [];
    const text = [e.role ?? '', e.name ?? '', tech.join(' '), ...e.bullets].join(' ');
    for (const s of new Set([...extractSkills(text), ...tech.map(canonicalSkill)])) add(s, e.id);
  }
  for (const e of p.education) for (const s of extractSkills((e.coursework ?? []).join(' '))) add(s, e.id);
  for (const [s, places] of Object.entries({ ...where })) for (const implied of IMPLIES[s] ?? []) for (const w of places) add(implied, w);
  return where;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseDate(s: string | undefined, today: string): Date | null {
  const t = (s ?? '').trim().toLowerCase();
  if (!t) return null;
  if (['present', 'current', 'now', 'ongoing'].includes(t)) return new Date(today);
  const m = /([a-z]{3})[a-z]*\.?\s*'?(\d{2,4})/.exec(t);
  if (!m || !MONTHS.includes(m[1])) return null;
  let y = Number(m[2]); if (y < 100) y += 2000;
  return new Date(Date.UTC(y, MONTHS.indexOf(m[1]), 1));
}
/** Professional experience in years; internships count half. `today` is injected so the result is deterministic. */
export function experienceYears(p: Profile, today: string): number {
  let total = 0;
  for (const e of p.experience) {
    const a = parseDate(e.start, today), b = parseDate(e.end || 'present', today);
    if (a && b && b >= a) total += ((b.getTime() - a.getTime()) / 86400000 / 365.25) * (/intern/i.test(`${e.role}${e.type ?? ''}`) ? 0.5 : 1);
  }
  return Math.round(total * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------------- jobs
/** Builds a Job. If the posting does not list required/preferred skills, they are extracted from the description text. */
export function normalizeJob(c: any): Job {
  const split = (c.description ?? '').split(/nice[- ]to[- ]have|preferred|bonus|good to have/i);
  const required: string[] = (c.required?.length ? c.required.map(canonicalSkill) : extractSkills(split[0] ?? ''));
  const preferred: string[] = (c.preferred?.length ? c.preferred.map(canonicalSkill) : extractSkills(split.slice(1).join(' '))).filter((s: string) => !required.includes(s));
  return { id: c.jobId, title: c.title, company: c.company, location: c.location ?? '', remote: !!c.remote, level: c.level ?? 'entry', minYears: c.minYears, required: [...new Set(required)], preferred: [...new Set(preferred)], description: c.description ?? '' };
}

// ------------------------------------------------------------------------------------------------------------------ fit
const WEIGHTS = { required: 0.45, preferred: 0.1, role: 0.15, level: 0.2, location: 0.1 };
const NON_TECH = /marketing|sales|account (?:executive|manager)|business development|\bbd\b|operations|\bops\b|content|copywrit|\bcopy\b|video|editor|\bhr\b|human resources|recruit|talent|finance|accounts payable|legal|compliance|customer support|customer success|community|partnership|brand|social media|growth|strategy|insurance|risk|ambassador|creative/i;
const TECH = /engineer|developer|\bsde\b|software|backend|back-end|frontend|front-end|full ?stack|\bdata\b|\bml\b|machine learning|\bai\b|devops|\bsre\b|cloud|security|mobile|android|\bios\b|\bqa\b|test|platform|infrastructure|research|programmer|coding/i;
const FOCUS = ['backend', 'back-end', 'frontend', 'front-end', 'full stack', 'fullstack', 'data', 'ml', 'machine learning', 'ai', 'mobile', 'android', 'ios', 'devops', 'cloud', 'security', 'platform', 'embedded', 'game'];

export interface Fit {
  jobId: string; title: string; company: string; score: number; verdict: string;
  breakdown: { required: number; preferred: number; role: number; level: number; location: number };
  matched: string[]; matchedPreferred: string[]; missing: string[]; missingPreferred: string[];
  evidence: Record<string, string[]>; gaps: { skill: string; required: boolean; plan: string }[]; proveIt: string[];
  roleNote: string; levelNote: string; locationNote: string; cappedBy: string[];
}

function roleScore(job: Job, p: Profile): [number, string] {
  const wanted = `${p.preferences.roles.join(' ')} ${p.headline}`.toLowerCase();
  const technical = TECH.test(job.title);
  if (NON_TECH.test(job.title) && !technical) return [0.05, `different field: '${job.title}' isn't an engineering role`];
  const focus = FOCUS.filter((f) => new RegExp(`\\b${f.replace(/[+]/g, '\\$&')}\\b`).test(wanted) && new RegExp(`\\b${f}\\b`).test(job.title.toLowerCase()));
  if (focus.length) return [1, `matches your target (${focus[0]})`];
  if (technical) return [0.75, 'engineering role'];
  return [0.5, 'role type unclear from the title'];
}
function coverage(wanted: string[], have: Record<string, string[]>): { score: number; proven: string[]; listed: string[]; missing: string[] } {
  if (!wanted.length) return { score: 0.7, proven: [], listed: [], missing: [] };
  const proven: string[] = [], listed: string[] = [], missing: string[] = [];
  for (const s of wanted) {
    const where = have[s] ?? [];
    if (where.some((w) => w !== 'skills')) proven.push(s); else if (where.length) listed.push(s); else missing.push(s);
  }
  return { score: (proven.length + 0.7 * listed.length) / wanted.length, proven, listed, missing };
}
function levelScore(job: Job, years: number): [number, string] {
  if (job.level === 'intern') return [1, 'internship: built for students'];
  if (job.level === 'entry') return [1, 'entry-level role'];
  if (job.level === 'senior') return [0.05, 'senior role: a long shot for a fresher'];
  const need = job.minYears;
  if (need == null) return [0.6, 'seniority not stated'];
  if (years >= need) return [1, `asks ${need}+ years; you have about ${years}`];
  const gap = need - years;
  return [gap <= 1 ? 0.8 : gap <= 2 ? 0.45 : 0.15, `asks ${need}+ years; you have about ${years}`];
}
function locationScore(job: Job, prefs: Profile['preferences']): [number, string] {
  const wanted = prefs.locations.map((l) => l.toLowerCase());
  const loc = job.location.toLowerCase();
  const inWanted = () => wanted.some((w) => w && (w.includes(loc) || loc.includes(w)));
  if (job.remote) {
    if (!prefs.remote_ok) return [0.4, 'remote, but you prefer on-site'];
    if (loc && !loc.includes('remote') && !inWanted()) return [0.7, `remote, based in ${job.location}: check which countries they hire from`];
    return [1, 'remote'];
  }
  if (!loc) return [0.6, 'location not stated'];
  if (inWanted()) return [1, `in ${job.location}`];
  if (prefs.relocate) return [0.7, `in ${job.location} (you're open to relocating)`];
  return wanted.length ? [0.3, `in ${job.location}, not in your preferred locations`] : [0.6, job.location];
}

/**
 * Score (0-100) = 45% required skills + 10% nice-to-haves + 15% role match + 20% seniority + 10% location.
 * A skill backed by a project/job counts fully; one only in the skills list counts 70%.
 * Guards: thin evidence (<3 named skills) can't look perfect; a different field is capped at 30; on-site outside your cities at 64.
 */
export function scoreFit(p: Profile, job: Job, today: string): Fit {
  const have = allSkills(p);
  const years = experienceYears(p, today);
  const req = coverage(job.required, have);
  const pref = coverage(job.preferred, have);
  let reqScore = req.score;
  let prefScore = pref.score;
  if (!job.preferred.length) prefScore = 0.5;
  const n = job.required.length;
  if (n > 0 && n < 3) reqScore = (reqScore * n) / 3 + (0.5 * (3 - n)) / 3;   // thin evidence
  const [role, roleNote] = roleScore(job, p);
  const [lvl, levelNote] = levelScore(job, years);
  const [loc, locationNote] = locationScore(job, p.preferences);
  let total = Math.round(100 * (WEIGHTS.required * reqScore + WEIGHTS.preferred * prefScore + WEIGHTS.role * role + WEIGHTS.level * lvl + WEIGHTS.location * loc));
  const cappedBy: string[] = [];
  if (role < 0.1) { total = Math.min(total, 30); cappedBy.push(roleNote); }
  if (loc <= 0.3) { total = Math.min(total, 64); cappedBy.push(`on-site outside your locations (${job.location})`); }
  const evidence: Record<string, string[]> = {};
  for (const s of [...req.proven, ...pref.proven]) evidence[s] = have[s].filter((w) => w !== 'skills').slice(0, 3).map((w) => entryLabel(p, w));
  const gaps = [...req.missing.map((s) => ({ skill: s, required: true, plan: gapProject(s) })), ...pref.missing.slice(0, 3).map((s) => ({ skill: s, required: false, plan: gapProject(s) }))];
  const proveIt = [...req.listed, ...pref.listed].map((s) => `'${s}' is only in your skills list; add a project bullet that shows it`);
  const verdict = total >= 75 ? 'strong fit: apply' : total >= 60 ? 'good fit: tailor and apply' : total >= 45 ? 'stretch: apply if you like the team, and close a gap first' : 'weak fit: probably skip';
  return {
    jobId: job.id, title: job.title, company: job.company, score: total, verdict,
    breakdown: { required: Math.round(reqScore * 100), preferred: Math.round(prefScore * 100), role: Math.round(role * 100), level: Math.round(lvl * 100), location: Math.round(loc * 100) },
    matched: [...req.proven, ...req.listed], matchedPreferred: [...pref.proven, ...pref.listed], missing: req.missing, missingPreferred: pref.missing,
    evidence, gaps, proveIt, roleNote, levelNote, locationNote, cappedBy,
  };
}

// ------------------------------------------------------------------------------------------------------ tailor + truth
const STOP = new Set(`a an the and or of to in on for with by at from as is are was were be been this that these those it its into using used use via over under across per our we i my me you your their they them he she his her which who whom what when where while than then also both each such can could will would should may might built build developed develop created create designed design implemented implement made make worked work`.split(/\s+/));
const tokens = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).filter((x) => !STOP.has(x) && x.length > 1));
const numbers = (t: string) => new Set(t.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []);
const flatten = (x: unknown): string[] => (x && typeof x === 'object' ? Object.values(x as object).flatMap(flatten) : [String(x)]);
const relevance = (text: string, weights: Record<string, number>) => extractSkills(text).reduce((a, s) => a + (weights[s] ?? 0), 0) + 0.01 * Math.sqrt(text.length);

/** Deterministic tailoring: picks, orders and trims profile content for one job. It never writes a new claim. */
export function autoTailor(p: Profile, job: Job, maxProjects = 3, maxBullets = 3): Tailored {
  const weights: Record<string, number> = {};
  for (const s of job.required) weights[s] = 2;
  for (const s of job.preferred) if (!(s in weights)) weights[s] = 1;
  const entryScore = (e: Exp | Proj) => relevance([(e as Exp).role ?? '', (e as Proj).name ?? '', ((e as Proj).tech ?? []).join(' '), ...e.bullets].join(' '), weights);
  const pick = (e: Exp | Proj, limit: number) => {
    const ranked = [...e.bullets].sort((a, b) => relevance(b, weights) - relevance(a, weights)).slice(0, limit);
    return e.bullets.filter((b) => ranked.includes(b));
  };
  const projects = [...p.projects].sort((a, b) => entryScore(b) - entryScore(a)).slice(0, maxProjects);
  const have = allSkills(p);
  const matched = [...job.required, ...job.preferred].filter((s) => s in have);
  const rest = p.skills.filter((s) => !matched.includes(canonicalSkill(s)) && !matched.includes(s))
    .sort((a, b) => Number(['soft', 'other'].includes(skillCategory(canonicalSkill(a)))) - Number(['soft', 'other'].includes(skillCategory(canonicalSkill(b)))));
  const edu = p.education[0];
  const degree = [edu?.degree, edu?.field].filter(Boolean).join(' ').trim();
  const top = projects[0];
  const skillsLine = (matched.length ? matched : p.skills).slice(0, 3).join(', ');
  const bits = [degree && edu?.school ? `${degree} student at ${edu.school}` : '', skillsLine ? `working with ${skillsLine}` : ''].filter(Boolean);
  let summary = bits.join(', ');
  if (top) { summary += `. Built ${top.name}`; if (top.tech.length) summary += ` with ${top.tech.slice(0, 3).join(', ')}`; }
  summary = summary ? `${summary}.` : p.summary;
  const achievements = [...p.achievements].sort((a, b) => relevance(b, weights) - relevance(a, weights)).slice(0, 3);
  return {
    headline: p.headline ?? '', summary, skills: [...matched, ...rest].slice(0, 16),
    experience: p.experience.map((e) => ({ id: e.id, bullets: pick(e, maxBullets + 1) })),
    projects: projects.map((e) => ({ id: e.id, bullets: pick(e, maxBullets) })), achievements,
  };
}

/** TRUTH GUARD: blocks invented entries, invented numbers, unsupported skills and bullets that don't trace back to the profile. */
export function verifyTruth(t: Partial<Tailored>, p: Profile): TruthIssue[] {
  const issues: TruthIssue[] = [];
  const known = allSkills(p);
  const knownSet = new Set(Object.keys(known));
  const knownLower = [...knownSet].map((s) => s.toLowerCase());
  const profileNumbers = numbers(flatten(p).join(' '));
  const entries = new Map<string, any>();
  for (const sec of SECTIONS) for (const e of p[sec] as any[]) entries.set(e.id, e);
  const block = (path: string, message: string) => issues.push({ severity: 'block', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warn', path, message });

  (t.skills ?? []).forEach((s, i) => { if (!knownSet.has(canonicalSkill(s))) block(`skills[${i}]`, `'${s}' is not in your profile; add it to the profile first if it's true`); });
  for (const sec of ['experience', 'projects'] as const) (t[sec] ?? []).forEach((te, i) => {
    const src = entries.get(te.id);
    if (!src) { block(`${sec}[${i}]`, `unknown entry id '${te.id}': resumes can only use profile entries`); return; }
    const srcText = flatten(src).join(' ');
    const srcTokens = new Set([...tokens(srcText), ...knownLower]);
    const srcNumbers = numbers(srcText);
    (te.bullets ?? []).forEach((b, j) => {
      const path = `${sec}[${i}].bullets[${j}]`;
      const newNums = [...numbers(b)].filter((x) => !srcNumbers.has(x));
      if (newNums.length) block(path, `numbers [${newNums.sort().join(', ')}] don't appear in this entry; no invented metrics`);
      const bt = tokens(b);
      const overlap = (set: Set<string>) => [...bt].filter((x) => set.has(x)).length / Math.max(1, bt.size);
      const best = Math.max(0, ...(src.bullets as string[]).map((o: string) => overlap(new Set([...tokens(o), ...knownLower]))));
      if (best < 0.5 && overlap(srcTokens) < 0.6) block(path, 'this bullet doesn\'t trace back to the profile entry; rephrase, don\'t invent');
      else if (best < 0.5) warn(path, 'heavily rephrased; double-check it still says what really happened');
      for (const s of extractSkills(b)) if (!knownSet.has(s)) block(path, `mentions '${s}', which isn't in your profile`);
    });
  });
  for (const field of ['headline', 'summary'] as const) {
    const text = t[field] ?? '';
    for (const s of extractSkills(text)) if (!knownSet.has(s)) block(field, `mentions '${s}', which isn't in your profile`);
    const nn = [...numbers(text)].filter((x) => !profileNumbers.has(x));
    if (nn.length) block(field, `numbers [${nn.sort().join(', ')}] aren't in your profile`);
  }
  (t.achievements ?? []).forEach((a, i) => {
    if (!p.achievements.includes(a) && [...numbers(a)].some((x) => !profileNumbers.has(x))) block(`achievements[${i}]`, "achievement numbers don't match your profile");
  });
  return issues;
}

/** Short stable fingerprint of a list of issues / a resume, used to bind a human answer to exactly what they were shown. */
export const fingerprint = (s: string) => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0'); };

const WEAK_OPENERS = /^(?:worked on|helped|responsible for|assisted|did|was|were|involved in|participated|tasked with|handled various|part of)\b/i;
export interface Critique { strength: number; findings: { kind: string; where: string; bullet: string; fix: string }[]; topFixes: { kind: string; where: string; bullet: string; fix: string }[]; defend: { skill: string; where: string; question: string }[] }
/** A second opinion on a tailored resume. Only flags things fixable honestly: wording, emphasis, and facts to ASK the candidate for. */
export function critique(t: Tailored, p: Profile, job: Job): Critique {
  const findings: Critique['findings'] = []; const defend: Critique['defend'] = [];
  const textParts = [t.summary, t.skills.join(' ')];
  for (const sec of ['experience', 'projects'] as const) for (const te of t[sec]) {
    const label = entryLabel(p, te.id);
    for (const b of te.bullets) {
      textParts.push(b);
      const words = b.split(/\s+/).length;
      if (WEAK_OPENERS.test(b)) findings.push({ kind: 'weak_verb', where: label, bullet: b, fix: 'lead with a strong verb: Built, Designed, Cut, Shipped, Automated' });
      if (!/\d/.test(b)) findings.push({ kind: 'no_impact', where: label, bullet: b, fix: 'ask the candidate for a real number (users, time saved, %); never guess' });
      if (words > 28) findings.push({ kind: 'too_long', where: label, bullet: b, fix: `${words} words; cut to under 25` });
      const hits = extractSkills(b).filter((s) => [...job.required, ...job.preferred].includes(s));
      if (hits.length && defend.length < 3) defend.push({ skill: hits[0], where: label, question: `Your resume says: "${b}". Walk me through how you did that with ${hits[0]}. What was hard?` });
    }
  }
  const have = allSkills(p);
  const shown = extractSkills(textParts.join(' '));
  for (const s of job.required) if (s in have && !shown.includes(s)) findings.push({ kind: 'hidden_skill', where: 'resume', bullet: '', fix: `'${s}' is in your profile and the job requires it, but this resume never shows it` });
  const w: Record<string, number> = { hidden_skill: 10, weak_verb: 6, too_long: 4, no_impact: 2 };
  const order = ['hidden_skill', 'weak_verb', 'too_long', 'no_impact'];
  return { strength: Math.max(0, 100 - findings.reduce((a, f) => a + w[f.kind], 0)), findings, topFixes: [...findings].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 3), defend };
}

/** Human-readable "what changed and why" for the approval message. */
export function tailoringChanges(t: Tailored, p: Profile): string[] {
  const out: string[] = [];
  const pickedIds = new Set(t.projects.map((x) => x.id));
  if (t.projects.length) out.push(`Projects, most relevant first: ${t.projects.map((x) => entryLabel(p, x.id)).join(', ')}`);
  const dropped = p.projects.filter((x) => !pickedIds.has(x.id)).map((x) => x.name);
  if (dropped.length) out.push(`Left out as less relevant: ${dropped.join(', ')}`);
  if (t.skills.length) out.push(`Skills reordered so the job's skills come first: ${t.skills.slice(0, 6).join(', ')}…`);
  const original = new Set([...p.experience, ...p.projects].flatMap((e) => e.bullets));
  const rephrased = [...t.experience, ...t.projects].flatMap((e) => e.bullets).filter((b) => !original.has(b)).length;
  if (rephrased) out.push(`${rephrased} bullet(s) rephrased to use the job's wording (truth guard checked)`);
  return out;
}

// ------------------------------------------------------------------------------------------------------- mock interview
const BANK: Record<string, [string, string[]][]> = {
  Python: [["What's the difference between a list and a tuple, and when would you use each?", ['mutable', 'immutable', 'hashable', 'dict key', 'performance']], ['How do generators work and why would you use one?', ['yield', 'lazy', 'memory', 'iterator']]],
  JavaScript: [['Explain the event loop in JavaScript.', ['call stack', 'queue', 'async', 'non-blocking', 'microtask']], ["What's the difference between == and ===?", ['type', 'coercion', 'strict']]],
  TypeScript: [['Why use TypeScript over JavaScript? Give a bug it would have caught.', ['type', 'compile', 'interface', 'catch', 'refactor']]],
  React: [['What triggers a re-render in React, and how do you avoid unnecessary ones?', ['state', 'props', 'memo', 'usememo', 'usecallback', 'key']], ['When would you use useEffect, and what does its dependency array do?', ['side effect', 'dependency', 'cleanup', 'fetch', 'subscribe']]],
  'Node.js': [['How does Node.js handle many concurrent requests on one thread?', ['event loop', 'non-blocking', 'async', 'i/o', 'libuv']]],
  'REST APIs': [['How would you design REST endpoints for a todo app? Cover status codes.', ['get', 'post', 'put', 'delete', '201', '404', 'resource']]],
  SQL: [["What's the difference between INNER JOIN and LEFT JOIN? Give an example.", ['matching', 'null', 'all rows', 'left table']], ['What is an index and when can it hurt?', ['lookup', 'b-tree', 'write', 'slower', 'storage']]],
  PostgreSQL: [['How would you find and fix a slow query in Postgres?', ['explain', 'index', 'analyze', 'scan']]],
  MongoDB: [['When would you choose MongoDB over a relational database?', ['schema', 'document', 'flexible', 'join', 'relations']]],
  Docker: [["What's the difference between an image and a container?", ['template', 'running', 'instance', 'layer', 'dockerfile']]],
  Kubernetes: [["What problem does Kubernetes solve that Docker alone doesn't?", ['orchestration', 'scaling', 'self-healing', 'pods', 'deployment']]],
  Git: [['Explain merge vs rebase. When would you avoid rebasing?', ['history', 'linear', 'shared', 'conflict']]],
  Java: [['Explain the difference between an interface and an abstract class.', ['implementation', 'multiple', 'state', 'contract']]],
  'Machine Learning': [['How do you detect and handle overfitting?', ['validation', 'regularization', 'dropout', 'more data', 'cross']]],
  'Data Structures': [["How does a hash map work, and what's its time complexity?", ['hash', 'bucket', 'collision', 'o(1)', 'resize']], ['When would you use a heap?', ['priority', 'min', 'max', 'log n', 'top k']]],
  'System Design': [['How would you design a URL shortener?', ['hash', 'database', 'cache', 'redirect', 'scale', 'collision']]],
  AWS: [["What's the difference between EC2 and Lambda? When would you pick each?", ['server', 'serverless', 'scale', 'cost', 'cold start']]],
  FastAPI: [['How does FastAPI use type hints?', ['validation', 'pydantic', 'docs', 'schema']]],
  LLMs: [['How would you reduce hallucinations in an LLM feature?', ['retrieval', 'rag', 'ground', 'evaluate', 'prompt', 'citation']]],
  'Unit Testing': [['What makes a good unit test?', ['isolated', 'fast', 'deterministic', 'mock', 'one thing']]],
};
const BEHAVIORAL: [string, string[]][] = [
  ['Tell me about a time you got stuck on a bug. What did you do?', ['debug', 'tried', 'learned', 'result']],
  ['Describe a time you worked in a team and disagreed with someone.', ['listen', 'compromise', 'outcome', 'team']],
  ['Tell me about something you learned quickly for a project.', ['learn', 'docs', 'built', 'result']],
];
export interface IQuestion { id: string; kind: 'intro' | 'project' | 'technical' | 'gap' | 'behavioral' | 'panel'; question: string; skill?: string; expect: string[] }

export function interviewPlan(p: Profile, job: Job, fit: Fit, n = 6): IQuestion[] {
  const qs: IQuestion[] = [];
  let top: Proj | undefined = p.projects[0];
  for (const where of Object.values(fit.evidence)) if (where.length) { top = p.projects.find((x) => x.name === where[0]) ?? top; break; }
  qs.push({ id: 'q1', kind: 'intro', question: `Tell me about yourself and why ${job.company}.`, expect: ['student', (top?.name ?? 'project').toLowerCase(), 'built', job.company.toLowerCase(), ...fit.matched.slice(0, 2).map((s) => s.toLowerCase())] });
  if (top) qs.push({ id: 'q2', kind: 'project', question: `Walk me through ${top.name}. Why ${top.tech.slice(0, 2).join(', ') || 'your stack'}, and what would you change now?`, expect: ['problem', 'because', 'trade', 'challenge', 'improve', ...top.tech.slice(0, 2).map((t) => t.toLowerCase())] });
  const used = new Set<string>();
  for (const s of [...fit.matched, ...job.required]) for (const [q, exp] of BANK[s] ?? []) if (!used.has(q) && qs.length < n - 2) { used.add(q); qs.push({ id: `q${qs.length + 1}`, kind: 'technical', skill: s, question: q, expect: exp }); break; }
  if (fit.missing.length) qs.push({ id: `q${qs.length + 1}`, kind: 'gap', skill: fit.missing[0], question: `This role uses ${fit.missing[0]}, which isn't on your resume. How would you get productive with it in your first two weeks?`, expect: ['docs', 'small project', 'ask', 'mentor', 'similar', 'plan'] });
  const b = BEHAVIORAL[job.title.length % BEHAVIORAL.length];
  qs.push({ id: `q${qs.length + 1}`, kind: 'behavioral', question: b[0], expect: b[1] });
  return qs.slice(0, n).map((q, i) => ({ ...q, id: `q${i + 1}` }));
}

const FILLERS = /\b(?:um+|uh+|erm+|hmm+|you know|i mean|basically)\b[,.]?\s*|(?<=, )like,\s*/gi;
const STAR: Record<string, RegExp> = {
  situation: /\b(?:when|while|during|at my|in my|our team|the project)\b/, task: /\b(?:had to|needed to|my (?:job|role|task|goal)|responsible)\b/,
  action: /\b(?:i (?:built|wrote|added|fixed|decided|used|created|led|tried|debugged|refactored|designed)|so i|i then)\b/,
  result: /\b(?:result|as a result|reduced|improved|increased|shipped|launched|learned|which meant|outcome|finally)\b/,
};
export interface Grade { score: number; rubricScore: number; coachScore: number | null; fillers: number; rubric: { relevance: number; structure: number; specificity: number; length: number }; covered: string[]; tips: string[]; words: number }
/** Transparent rubric grade (relevance 40% / structure 25% / specificity 20% / length 15%). Spoken answers: fillers removed and counted. */
export function gradeAnswer(q: Pick<IQuestion, 'kind' | 'expect'>, answer: string, coachScore?: number): Grade {
  const fillers = (answer.match(FILLERS) ?? []).length;
  const a = answer.replace(FILLERS, '').replace(/\s+/g, ' ').trim();
  const low = a.toLowerCase();
  const words = (a.match(/\w+/g) ?? []).length;
  const exp = q.expect ?? [];
  const hit = exp.filter((e) => low.includes(e));
  const relevanceScore = exp.length ? Math.min(1, hit.length / Math.max(2, exp.length * 0.6)) : 0.6;
  let star: string[] = []; let structure: number;
  if (['behavioral', 'project', 'intro'].includes(q.kind)) { star = Object.entries(STAR).filter(([, re]) => re.test(low)).map(([k]) => k); structure = star.length / 4; }
  else { const markers = [/\bbecause\b/, /\bfor example\b|\be\.g\.|\bsuch as\b/, /trade-?off|downside|but\b/, /o\([^)]*\)|complexity|faster|slower/].filter((m) => m.test(low)); structure = Math.min(1, markers.length / 2); }
  const specific = Math.min(1, (/\d/.test(a) ? 0.4 : 0) + (/\bi\b/.test(low) ? 0.3 : 0) + ((a.match(/[A-Z][a-zA-Z+#.]+/g) ?? []).length >= 2 ? 0.3 : 0));
  const length = words >= 40 && words <= 220 ? 1 : (words >= 20 && words < 40) || (words > 220 && words <= 320) ? 0.6 : 0.2;
  const raw = 0.4 * relevanceScore + 0.25 * structure + 0.2 * specific + 0.15 * length;
  const rubricScore = Math.round((1 + 4 * raw) * 10) / 10;
  let score = rubricScore; let coach: number | null = null;
  if (coachScore != null) { coach = Math.max(1, Math.min(5, coachScore)); score = Math.round(((rubricScore + coach) / 2) * 10) / 10; }
  const tips: string[] = [];
  if (fillers >= 3) tips.push(`${fillers} filler words (um, like, basically…). Pause instead; it sounds more confident`);
  const missed = exp.filter((e) => !hit.includes(e)).slice(0, 3);
  if (missed.length) tips.push(`Strong answers usually touch on: ${missed.join(', ')}`);
  if (['behavioral', 'project'].includes(q.kind) && star.length < 4) tips.push(`Use STAR. Missing: ${Object.keys(STAR).filter((k) => !star.includes(k)).join(', ')}`);
  if (q.kind === 'technical' && structure < 1) tips.push('Explain *why* and give a concrete example or trade-off');
  if (specific < 0.6) tips.push('Be specific: name the tool, your exact part, and a number if you have a real one');
  if (words < 40) tips.push(`Too short (${words} words); aim for 60–150`); else if (words > 220) tips.push(`Too long (${words} words); lead with the point, then one example`);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { score, rubricScore, coachScore: coach, fillers, rubric: { relevance: r2(relevanceScore), structure: r2(structure), specificity: r2(specific), length: r2(length) }, covered: hit, tips, words };
}
