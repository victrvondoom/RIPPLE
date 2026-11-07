import { z } from 'zod';
import type { AnalysisContext, ChangeItem, WorkflowPack } from '../../engine/types.js';
import { Out, table } from '../common.js';
import { untrustedFindings } from '../untrusted.js';
import { parseInstalls, type PackageRef } from '../../capabilities/pkgguard/installs.js';
import { metadataVerdict, type PkgMeta } from '../../capabilities/pkgguard/metadata.js';
import { NameIndex, STRONG_SQUAT } from '../../capabilities/pkgguard/names.js';
import { referenceList } from '../../capabilities/pkgguard/reference.js';

/**
 * Package Gate: a package-install gate for a team room (session 18). Concept supplied by the owner (a four-agent crew:
 * Scout, Inspector, Squat Watch, Fixer); implemented here on RIPPLE's single engine with RIPPLE's own capability
 * (capabilities/pkgguard). Nothing here installs, runs or certifies a package:
 *  - Scout reads the install line and judges each package from RECORDED registry observations (metadata rules).
 *  - Inspector reports the recorded static-code verdict; a flagged package with no code reading is "not inspected", never clean.
 *  - Squat Watch keeps the room's invented-name list and raises a name that was invented before and now exists.
 *  - Fixer drafts the safe install line and the stopped-install receipt. Every risky package needs the security lead's
 *    explicit decision, bound to the exact ecosystem + name + version (a new version is a new question).
 * Observations come from `capabilities/pkgguard/observe.ts` (live, read-only) or are recorded fixtures in the sample.
 * Measured detection rates and their limits: docs/benchmarks/PACKAGE_RISK_BENCHMARK.md.
 */
const meta = z.object({
  ecosystem: z.enum(['npm', 'pypi']), name: z.string(), asOf: z.string(), firstPublished: z.string().nullable(),
  versionCount: z.number().nullable(), maxMajor: z.number().nullable(), quietDaysBefore: z.number().nullable(),
  installScript: z.boolean().nullable(), weeklyDownloads: z.number().nullable(), hasRepository: z.boolean().nullable(),
}).passthrough();
const observation = z.object({
  ecosystem: z.enum(['npm', 'pypi']), name: z.string().min(1), requestedVersion: z.string().nullable().default(null), resolvedVersion: z.string().nullable(),
  existence: z.enum(['exists', 'not-found', 'unreachable', 'version-not-found']), observedAt: z.string(), source: z.string(),
  meta: meta.nullable(),
  code: z.object({ version: z.string(), score: z.number(), verdict: z.enum(['clean', 'review', 'malicious-looking']), hits: z.array(z.object({ rule: z.string(), weight: z.number(), file: z.string(), line: z.number(), what: z.string() })).default([]), installHook: z.string().nullable(), filesScanned: z.number() }).nullable(),
  integrity: z.string().nullable().default(null),
  registryNotice: z.string().nullable().optional(),
});
const pkgKey = z.object({ ecosystem: z.enum(['npm', 'pypi']), name: z.string() });
export const planSchema = z.object({
  room: z.string().min(1),
  securityLead: z.string().email(),
  approvalLedger: z.array(pkgKey.extend({ version: z.string(), approvedBy: z.string(), at: z.string() })).default([]),
  inventedNames: z.array(pkgKey.extend({ count: z.number().int().min(1), firstSeen: z.string() })).default([]),
  reviewHistory: z.object({ asked: z.number().int().min(0), approved: z.number().int().min(0) }).default({ asked: 0, approved: 0 }),
});
export const changeSchema = z.object({
  message: z.string().min(1),
  requestedBy: z.object({ name: z.string().min(1), kind: z.enum(['human', 'agent']) }),
  postedAt: z.string(),
  observations: z.array(observation).default([]),
});
type Plan = z.infer<typeof planSchema>;
type Change = z.infer<typeof changeSchema>;
type Obs = z.infer<typeof observation>;

const index = { npm: new NameIndex('npm', referenceList('npm')), pypi: new NameIndex('pypi', referenceList('pypi')) };
const norm = (eco: string, n: string) => (eco === 'pypi' ? n.toLowerCase().replace(/[-_.]+/g, '-') : n.toLowerCase());
const slug = (eco: string, name: string, v: string | null) => `${eco}_${name}_${v ?? 'unresolved'}`.replace(/[^a-zA-Z0-9]+/g, '_');
export const approvalKey = (eco: string, name: string, v: string | null) => `approve_${slug(eco, name, v)}`;

export type PkgStatus = 'clean' | 'approved' | 'approved-now' | 'denied' | 'invented' | 'removed' | 'replace' | 'review' | 'unverified';
export interface PkgAssessment {
  ref: PackageRef; obs: Obs | null; status: PkgStatus; replacement: string | null; reasons: string[];
  metaFlagged: boolean; codeVerdict: string; key: string; reinvented: boolean;
}

/** Pure assessment of every package in the message. Used by the analyzers, the verifier and the completion check. */
export function assess(plan: Plan, change: Change, answers: AnalysisContext['answers'] = {}): PkgAssessment[] {
  const refs = parseInstalls(change.message).packages;
  return refs.map((ref) => {
    const obs = change.observations.find((o) => o.ecosystem === ref.ecosystem && norm(o.ecosystem, o.name) === norm(ref.ecosystem, ref.name) && (o.requestedVersion ?? null) === (ref.version ?? null)) ?? null;
    const version = obs?.resolvedVersion ?? ref.version ?? null;
    const key = approvalKey(ref.ecosystem, ref.name, version);
    const reinvented = plan.inventedNames.some((i) => i.ecosystem === ref.ecosystem && norm(i.ecosystem, i.name) === norm(ref.ecosystem, ref.name));
    const base = { ref, obs, replacement: null as string | null, reasons: [] as string[], metaFlagged: false, codeVerdict: obs?.code?.verdict ?? 'not inspected', key, reinvented };
    if (!obs || obs.existence === 'unreachable') return { ...base, status: 'unverified' as const, reasons: ['no registry observation recorded: unverified, not clear'] };
    if (obs.existence === 'not-found') return { ...base, status: 'invented' as const, reasons: [`${ref.name} does not exist on ${obs.source} (observed ${obs.observedAt}): likely an invented name`] };
    if (obs.existence === 'version-not-found') return { ...base, status: 'unverified' as const, reasons: [`version ${ref.version} of ${ref.name} does not exist`] };
    // A registry security placeholder is never installable as asked: replace it when it imitates a real package, else invented-like removal.
    if (obs.registryNotice) {
      const look = index[ref.ecosystem].check(ref.name).find((h) => STRONG_SQUAT.includes(h.kind));
      return { ...base, status: look ? 'replace' as const : 'removed' as const, replacement: look?.target ?? null, metaFlagged: true, reasons: [obs.registryNotice, ...(look ? [`name ${look.detail}`] : [])] };
    }
    if (plan.approvalLedger.some((l) => l.ecosystem === ref.ecosystem && norm(l.ecosystem, l.name) === norm(ref.ecosystem, ref.name) && l.version === version)) return { ...base, status: 'approved' as const, reasons: [`${ref.name}@${version} approved earlier (ledger)`] };
    const mv = obs.meta ? metadataVerdict(obs.meta as PkgMeta, index[ref.ecosystem]) : null;
    const reasons = [...(mv?.reasons ?? [])];
    if (reinvented) reasons.push('this name was invented earlier in this room and now exists: it may have been registered by someone watching for it');
    const code = obs.code?.verdict ?? null;
    if (code && code !== 'clean') reasons.push(`static code reading: ${code} (score ${obs.code!.score}; ${[...new Set(obs.code!.hits.map((h) => h.rule))].join(', ')})`);
    const flagged = !!mv?.flagged || reinvented || (code !== null && code !== 'clean');
    if (!obs.meta) reasons.push('no registry metadata recorded');
    if (flagged && !obs.code) reasons.push('flagged but its code was not read: not inspected');
    const decision = answers[key]?.value;
    if (decision === 'approve') return { ...base, status: 'approved-now' as const, metaFlagged: !!mv?.flagged, reasons: [...reasons, 'approved for this exact version by the security lead'] };
    if (decision === 'deny') return { ...base, status: 'denied' as const, metaFlagged: !!mv?.flagged, reasons: [...reasons, 'denied by the security lead'] };
    const lookalike = mv?.squat.find((h) => STRONG_SQUAT.includes(h.kind));
    if (lookalike) return { ...base, status: 'replace' as const, metaFlagged: true, replacement: lookalike.target, reasons };
    if (flagged || !obs.meta) return { ...base, status: 'review' as const, metaFlagged: !!mv?.flagged, reasons };
    return { ...base, status: 'clean' as const, reasons: ['no metadata or code rule matched (this is not a safety certification)'] };
  });
}

/** The install line Fixer proposes: allowed packages kept, lookalikes replaced by their target, everything else removed. */
export function safeInstallLine(as: PkgAssessment[]): { line: string | null; removed: string[]; replaced: string[] } {
  const keep: Record<string, string[]> = {}; const removed: string[] = []; const replaced: string[] = [];
  const add = (tool: string, spec: string) => { (keep[tool] ??= []).push(spec); };
  for (const a of as) {
    const tool = a.ref.ecosystem === 'npm' ? 'npm install' : 'pip install';
    const spec = (n: string, v: string | null) => (v ? (a.ref.ecosystem === 'npm' ? `${n}@${v}` : `${n}==${v}`) : n);
    if (a.status === 'clean' || a.status === 'approved' || a.status === 'approved-now') add(tool, spec(a.ref.name, a.obs?.resolvedVersion ?? a.ref.version ?? null));
    else if (a.status === 'replace' && a.replacement) { add(tool, a.replacement); replaced.push(`${a.ref.name} -> ${a.replacement}`); }
    else removed.push(`${a.ref.name} (${a.status})`);
  }
  const lines = Object.entries(keep).map(([t, s]) => `${t} ${s.join(' ')}`);
  return { line: lines.length ? lines.join('\n') : null, removed, replaced };
}

const pending = (as: PkgAssessment[]) => as.filter((a) => a.status === 'review' || a.status === 'unverified');
export const reviewHealth = (plan: Plan, as: PkgAssessment[]) => {
  const asked = plan.reviewHistory.asked + as.filter((a) => a.status === 'approved-now' || a.status === 'denied').length;
  const approved = plan.reviewHistory.approved + as.filter((a) => a.status === 'approved-now').length;
  const ratio = asked ? approved / asked : null;
  return { asked, approved, ratio, reflex: asked >= 10 && ratio !== null && ratio >= 0.9 };
};

export const pkggatePack: WorkflowPack = {
  tier: 'extended', system: 'engineering',
  id: 'package-gate',
  name: 'Package Gate',
  domain: 'Software Supply Chain',
  version: '1.0.0',
  description: 'Checks every npm/PyPI package an install line in the room would fetch, using recorded registry metadata and an in-memory static code reading. Invented names are removed, lookalikes replaced, risky packages wait for the security lead\'s decision on the exact version. Never installs or certifies anything.',
  labels: { baseline: 'Room Package Policy', change: 'Install Request', changeVerb: 'Check Install Line', plan: 'Room Policy & Ledger', mission: 'Install Check', blurb: 'Reads an install line, checks each package against recorded registry data and code findings, and proposes a safe install line for the security lead to approve.' },
  agentLimit: 'Reads registry data and archives in memory; never installs, runs or certifies a package',
  roles: [
    { key: 'pg_scout', name: 'Scout', kind: 'agent', responsibility: 'Finds every package in the install line and applies the metadata and lookalike-name rules to the recorded registry observation', department: 'Security', scope: 'read' },
    { key: 'pg_inspector', name: 'Inspector', kind: 'agent', responsibility: 'Reports the recorded static code reading; a flagged package without one is "not inspected"', department: 'Security', scope: 'read' },
    { key: 'pg_squat_watch', name: 'Squat Watch', kind: 'agent', responsibility: 'Keeps the room\'s invented-name list and raises any invented name that now exists', department: 'Security', scope: 'read' },
    { key: 'pg_fixer', name: 'Fixer', kind: 'agent', responsibility: 'Drafts the safe install line, the stopped-install receipt and the decisions the security lead must make', department: 'Security' },
    { key: 'pg_security_lead', name: 'Security Lead', kind: 'human', responsibility: 'The only person who may approve or deny a flagged package, one exact version at a time', department: 'Engineering' },
  ],
  roleOrder: ['pg_scout', 'pg_inspector', 'pg_squat_watch', 'pg_fixer', 'pg_security_lead'],
  roleDeps: { pg_inspector: ['pg_scout'], pg_squat_watch: ['pg_scout'], pg_fixer: ['pg_scout', 'pg_inspector', 'pg_squat_watch'] },
  planSchema, changeSchema,
  artifacts: [
    { key: 'package_findings', label: 'Package findings', department: 'Security', ownerRole: 'pg_scout', description: 'Per-package metadata, name and code findings with the observation time' },
    { key: 'invented_names', label: 'Invented package names', department: 'Security', ownerRole: 'pg_squat_watch', description: 'Names the room asked for that did not exist, with how often each came back' },
    { key: 'safe_install', label: 'Safe install line', department: 'Security', ownerRole: 'pg_fixer', description: 'The rewritten install line; posted only after the security lead approves' },
    { key: 'stop_receipt', label: 'Stopped-install receipt', department: 'Security', ownerRole: 'pg_fixer', description: 'What was stopped, who asked, and when' },
  ],
  rules: [],
  artifactEdges: [
    { from: 'package_findings', to: 'safe_install', relation: 'decides', why: 'Findings decide which packages stay, are replaced or are removed' },
    { from: 'invented_names', to: 'safe_install', relation: 'removes', why: 'Invented names are never installed' },
    { from: 'safe_install', to: 'stop_receipt', relation: 'records', why: 'Everything removed or replaced goes on the receipt' },
  ],
  decisions: [{ key: 'package_auth', label: 'Security lead approves or denies each flagged package version', ownerRole: 'pg_security_lead', gates: ['safe_install'] }],

  sample() {
    const at = '2026-11-07T10:00:00.000Z';
    const fx = 'fixture (illustrative, not a registry reading)';
    return {
      title: 'Coding agent asks to install four packages',
      plan: {
        room: '#web-app', securityLead: 'noor@harborvine.example',
        approvalLedger: [], inventedNames: [{ ecosystem: 'npm' as const, name: 'react-forms-validator-pro', count: 2, firstSeen: '2026-11-01T09:00:00.000Z' }],
        reviewHistory: { asked: 3, approved: 2 },
      },
      change: {
        message: 'Run this to set up the form page:\n```\nnpm install express expresss chalk-pretty-log react-forms-validator-pro\n```',
        requestedBy: { name: 'coding-agent', kind: 'agent' as const }, postedAt: at,
        observations: [
          { ecosystem: 'npm' as const, name: 'express', requestedVersion: null, resolvedVersion: '5.1.0', existence: 'exists' as const, observedAt: at, source: fx, integrity: null,
            meta: { ecosystem: 'npm' as const, name: 'express', asOf: at, firstPublished: '2010-12-29T19:38:25.450Z', versionCount: 280, maxMajor: 5, quietDaysBefore: 120, installScript: false, weeklyDownloads: 40000000, hasRepository: true },
            code: { version: 'inspect@1', score: 1, verdict: 'clean' as const, hits: [], installHook: null, filesScanned: 16 } },
          { ecosystem: 'npm' as const, name: 'expresss', requestedVersion: null, resolvedVersion: '1.0.2', existence: 'exists' as const, observedAt: at, source: fx, integrity: null,
            meta: { ecosystem: 'npm' as const, name: 'expresss', asOf: at, firstPublished: '2026-11-05T22:10:00.000Z', versionCount: 1, maxMajor: 1, quietDaysBefore: null, installScript: true, weeklyDownloads: 12, hasRepository: false },
            code: { version: 'inspect@1', score: 13, verdict: 'malicious-looking' as const, hits: [{ rule: 'npm_install_hook', weight: 2, file: 'package.json', line: 1, what: 'runs a script when installed' }, { rule: 'exfil_endpoint', weight: 4, file: 'setup.js', line: 3, what: 'sends data to a webhook / request-capture / out-of-band service' }, { rule: 'js_fingerprint', weight: 2, file: 'setup.js', line: 2, what: 'collects machine and user details' }, { rule: 'collect_and_send', weight: 3, file: 'setup.js', line: 2, what: 'the same file collects local data and has a way to send it' }, { rule: 'runs_at_install', weight: 2, file: 'setup.js', line: 1, what: 'the risky code runs at install time' }], installHook: 'node setup.js', filesScanned: 3 } },
          { ecosystem: 'npm' as const, name: 'chalk-pretty-log', requestedVersion: null, resolvedVersion: '0.1.0', existence: 'exists' as const, observedAt: at, source: fx, integrity: null,
            meta: { ecosystem: 'npm' as const, name: 'chalk-pretty-log', asOf: at, firstPublished: '2026-11-04T08:00:00.000Z', versionCount: 1, maxMajor: 0, quietDaysBefore: null, installScript: false, weeklyDownloads: 30, hasRepository: true },
            code: { version: 'inspect@1', score: 0, verdict: 'clean' as const, hits: [], installHook: null, filesScanned: 4 } },
          { ecosystem: 'npm' as const, name: 'react-forms-validator-pro', requestedVersion: null, resolvedVersion: null, existence: 'not-found' as const, observedAt: at, source: fx, integrity: null, meta: null, code: null },
        ],
      },
    };
  },

  detectChanges(plan: Plan, change: Change): ChangeItem[] {
    const as = assess(plan, change);
    return as.map((a) => ({ field: `package.${a.ref.ecosystem}.${a.ref.name}`, label: `${a.ref.ecosystem}: ${a.ref.name}${a.obs?.resolvedVersion ? '@' + a.obs.resolvedVersion : ''}`, before: 'requested', after: a.status, kind: 'added' as const, severity: a.status === 'clean' || a.status === 'approved' ? 'low' as const : a.status === 'invented' || a.status === 'removed' || a.status === 'replace' ? 'high' as const : 'medium' as const, note: a.reasons.join('; ') }));
  },

  applyChange(plan: Plan, change: Change, answers): Plan {
    const as = assess(plan, change, answers);
    const next = structuredClone(plan);
    for (const a of as) {
      if (a.status === 'approved-now' && a.obs?.resolvedVersion) next.approvalLedger.push({ ecosystem: a.ref.ecosystem, name: a.ref.name, version: a.obs.resolvedVersion, approvedBy: 'security lead (identity in the audit trail)', at: change.postedAt });
      if (a.status === 'invented') {
        const hit = next.inventedNames.find((i) => i.ecosystem === a.ref.ecosystem && norm(i.ecosystem, i.name) === norm(a.ref.ecosystem, a.ref.name));
        if (hit) hit.count++; else next.inventedNames.push({ ecosystem: a.ref.ecosystem, name: a.ref.name, count: 1, firstSeen: change.postedAt });
      }
    }
    const h = reviewHealth(plan, as); next.reviewHistory = { asked: h.asked, approved: h.approved };
    return next;
  },

  parseAnswer(key, text) {
    if (!key.startsWith('approve_')) return { value: text.trim() };
    const t = text.trim().toLowerCase();
    return t === 'approve' || t === 'deny' ? { value: t } : { error: 'Answer "approve" or "deny". An approval covers this exact version only.' };
  },

  analyzeRole(role: string, ctx: AnalysisContext) {
    const A = 'pkggate-analyzer';
    const plan = ctx.plan as Plan; const change = ctx.change as Change;
    const as = assess(plan, change, ctx.answers);

    if (role === 'pg_scout') {
      const o = new Out(role, `${A}-scout@1`);
      const parse = parseInstalls(change.message);
      for (const w of untrustedFindings(change.message)) o.risk(`The message itself ${w}.`);
      for (const s of parse.skipped) o.warn(`Not checked: ${s.raw} (${s.reason}).`, true);
      if (as.length === 0) return o.done('No registry package found in the message.');
      for (const a of as) {
        const line = `${a.ref.ecosystem} ${a.ref.name}${a.obs?.resolvedVersion ? '@' + a.obs.resolvedVersion : ''}: ${a.status}. ${a.reasons.join('; ')}`;
        if (a.status === 'clean' || a.status === 'approved') o.info(line); else o.risk(line);
      }
      const rows = as.map((a) => [`${a.ref.ecosystem}:${a.ref.name}`, a.obs?.resolvedVersion ?? '-', a.status, a.codeVerdict, a.obs ? `${a.obs.source}, ${a.obs.observedAt}` : 'none', a.reasons.join('; ') || '-']);
      o.draft({ kind: 'package_findings', name: 'Package findings', artifactKey: 'package_findings', content: `# Package findings\n\nRequested by **${change.requestedBy.name}** (${change.requestedBy.kind}) at ${change.postedAt}.\n\n${table(['Package', 'Version', 'Status', 'Code reading', 'Observed', 'Why'], rows)}\n\n_Metadata rules and their measured hit rates: docs/benchmarks/PACKAGE_RISK_BENCHMARK.md. "clean" means no rule matched; it is not a safety certification. Nothing was installed._` });
      o.data = { statuses: Object.fromEntries(as.map((a) => [`${a.ref.ecosystem}:${a.ref.name}`, a.status])) };
      return o.done(`${as.length} package(s): ${as.filter((a) => a.status === 'clean' || a.status === 'approved').length} clear, ${as.filter((a) => !['clean', 'approved'].includes(a.status)).length} need attention.`);
    }

    if (role === 'pg_inspector') {
      const o = new Out(role, `${A}-inspector@1`);
      for (const a of as.filter((x) => x.obs?.existence === 'exists')) {
        if (!a.obs!.code) { if (a.status !== 'clean' && a.status !== 'approved') o.warn(`${a.ref.name}: code not inspected. It stays unresolved until a person decides.`, true); continue; }
        const c = a.obs!.code;
        const t = `${a.ref.name}@${a.obs!.resolvedVersion}: ${c.verdict} (score ${c.score}, ${c.filesScanned} text files read in memory, rules ${c.version})${c.hits.length ? ': ' + [...new Set(c.hits.map((h) => h.what))].join('; ') : ''}`;
        if (c.verdict === 'clean') o.info(t); else o.risk(t);
      }
      return o.done('Static code readings reported. The archive was read as text in memory; nothing was installed or run.');
    }

    if (role === 'pg_squat_watch') {
      const o = new Out(role, `${A}-squatwatch@1`);
      const invented = as.filter((a) => a.status === 'invented');
      const reinvented = as.filter((a) => a.reinvented && a.obs?.existence === 'exists');
      for (const a of reinvented) o.risk(`${a.ref.name} was invented earlier in ${plan.room} and is now registered (${a.obs!.observedAt}). Treat it as hostile until a person decides.`);
      const list = new Map(plan.inventedNames.map((i) => [`${i.ecosystem}:${norm(i.ecosystem, i.name)}`, { ...i }]));
      for (const a of invented) { const k = `${a.ref.ecosystem}:${norm(a.ref.ecosystem, a.ref.name)}`; const e = list.get(k); if (e) e.count++; else list.set(k, { ecosystem: a.ref.ecosystem, name: a.ref.name, count: 1, firstSeen: change.postedAt }); }
      const rows = [...list.values()].sort((x, y) => y.count - x.count).map((i) => [i.ecosystem, i.name, i.count, i.firstSeen]);
      if (invented.length) o.warn(`${invented.length} invented name(s) removed from the install line and added to the watch list: ${invented.map((a) => a.ref.name).join(', ')}.`);
      o.draft({ kind: 'invented_names', name: 'Invented package names', artifactKey: 'invented_names', content: `# Invented package names: ${plan.room}\n\n${rows.length ? table(['Ecosystem', 'Name', 'Times asked', 'First seen'], rows) : 'None yet.'}\n\n_A name asked for again and again is the one an attacker is most likely to register. RIPPLE does not poll the registries on a schedule; each install check re-reads the registry for the names it contains._` });
      return o.done(`${invented.length} invented, ${reinvented.length} previously-invented name(s) now registered.`);
    }

    if (role === 'pg_fixer') {
      const o = new Out(role, `${A}-fixer@1`);
      const waiting = pending(as);
      for (const a of waiting) {
        o.ask({ key: a.key, text: `${a.ref.ecosystem} ${a.ref.name}@${a.obs?.resolvedVersion ?? 'unresolved'} needs a decision: ${a.reasons.join('; ')}. Approve this exact version or deny it? (approve/deny)`, blocking: true, assigneeRole: 'pg_security_lead', assigneeOnly: true });
      }
      const h = reviewHealth(plan, as);
      if (h.reflex) o.warn(`Review health: ${h.approved} of ${h.asked} asks ended in approve (${Math.round(h.ratio! * 100)}%). A gate that nearly always approves may have become a reflex.`, true);
      const safe = safeInstallLine(as);
      const stopped = as.filter((a) => !['clean', 'approved', 'approved-now'].includes(a.status));
      o.draft({ kind: 'stop_receipt', name: 'Stopped-install receipt', artifactKey: 'stop_receipt', content: `# Stopped-install receipt: ${plan.room}\n\nAsked by **${change.requestedBy.name}** (${change.requestedBy.kind}) at ${change.postedAt}.\n\n${stopped.length ? table(['Package', 'Outcome', 'Why'], stopped.map((a) => [`${a.ref.ecosystem}:${a.ref.name}`, a.status === 'replace' ? `replaced by ${a.replacement}` : a.status, a.reasons.join('; ')])) : 'Nothing stopped.'}\n\nReview health: ${h.approved}/${h.asked} asks approved.` });
      if (waiting.length) return o.done(`Waiting for the security lead on ${waiting.length} package(s); no install line is proposed until then.`);
      if (!safe.line) return o.done('Nothing left to install after removals.');
      o.draft({ kind: 'safe_install', name: 'Safe install line', artifactKey: 'safe_install', content: `# Safe install line: ${plan.room}\n\n\`\`\`\n${safe.line}\n\`\`\`\n\nReplaced: ${safe.replaced.join(', ') || 'none'}. Removed: ${safe.removed.join(', ') || 'none'}.\n\n**Nothing was installed.** RIPPLE proposes this line; a person runs it. Package checks are rule-based and are not a security certification.` });
      o.act({ key: 'act-post-safe-install', type: 'post_safe_install', title: `Post the safe install line to ${plan.room}`, connector: 'internal_notify', ownerRole: 'pg_fixer', consequential: true, draftKind: 'safe_install', approvalRole: 'manager', ackRoles: [], rationale: 'Every package in the line is clean, approved for its exact version, or the real package a lookalike was replaced with.', target: plan.room, effectKey: `safe-install-${change.postedAt}`, approver: { email: plan.securityLead } });
      return o.done(`Safe install line drafted (${safe.replaced.length} replaced, ${safe.removed.length} removed).`);
    }

    return new Out(role, `${A}-lead@1`).done('Human decision role: the security lead approves or denies flagged packages.');
  },

  verifyAction(action, observed, _revised, ctx) {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    if (action.type !== 'post_safe_install' || !ctx) return checks;
    const text = observed.content;
    checks.push({ name: 'states nothing was installed', passed: text.includes('Nothing was installed.'), detail: 'scope statement present in the stored line' });
    const as = assess(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers);
    const allowed = new Set<string>();
    for (const a of as) {
      if (['clean', 'approved', 'approved-now'].includes(a.status)) allowed.add(`${a.ref.ecosystem}:${norm(a.ref.ecosystem, a.ref.name)}`);
      if (a.status === 'replace' && a.replacement) allowed.add(`${a.ref.ecosystem}:${norm(a.ref.ecosystem, a.replacement)}`);
    }
    const posted = parseInstalls(text).packages;
    const bad = posted.filter((p) => !allowed.has(`${p.ecosystem}:${norm(p.ecosystem, p.name)}`));
    checks.push({ name: 'every package in the stored line is clean, approved for its exact version, or a lookalike\'s real target', passed: posted.length > 0 && bad.length === 0, detail: bad.length ? `not allowed: ${bad.map((b) => b.name).join(', ')}` : `${posted.length} package(s) re-checked from the stored text` });
    return checks;
  },

  completionChecks(ctx) {
    const as = assess(ctx.baselinePlan as Plan, ctx.change as Change, ctx.answers);
    const open = pending(as);
    return [{ key: 'packages_decided', label: 'Every flagged package was approved (exact version) or denied by the security lead', passed: open.length === 0, detail: open.length ? `waiting: ${open.map((a) => a.ref.name).join(', ')}` : `${as.length} package(s) resolved` }];
  },
};
