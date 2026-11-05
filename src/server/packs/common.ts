import type { Finding, QuestionSpec, WorkItemSpec, DraftSpec, ActionSpec, RoleResult } from '../engine/types.js';

export const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
export const money = (n: number, cur = 'USD') => `${cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur + ' '}${Math.round(n).toLocaleString('en-US')}`;
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Small builder so analyzers read as domain logic, not plumbing. */
export class Out {
  findings: Finding[] = []; questions: QuestionSpec[] = []; workItems: WorkItemSpec[] = []; drafts: DraftSpec[] = []; actions: ActionSpec[] = [];
  data: Record<string, unknown> = {};
  constructor(public roleKey: string, public analyzer: string) {}
  info(text: string) { this.findings.push({ severity: 'info', text }); return this; }
  warn(text: string, review = false) { this.findings.push({ severity: 'warning', text, needsHumanReview: review || undefined }); return this; }
  risk(text: string) { this.findings.push({ severity: 'risk', text, needsHumanReview: true }); return this; }
  ask(q: QuestionSpec) { this.questions.push(q); return this; }
  work(w: WorkItemSpec) { this.workItems.push(w); return this; }
  draft(d: Omit<DraftSpec, 'ownerRole'>) { this.drafts.push({ ...d, ownerRole: this.roleKey }); return this; }
  act(a: ActionSpec) { this.actions.push(a); return this; }
  done(summary: string): RoleResult { return { roleKey: this.roleKey, summary, findings: this.findings, questions: this.questions, workItems: this.workItems, drafts: this.drafts, actions: this.actions, analyzer: this.analyzer, data: this.data }; }
}
export const roleName = (roles: { key: string; name: string }[], k: string) => roles.find((r) => r.key === k)?.name ?? k;
