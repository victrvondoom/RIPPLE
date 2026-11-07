import type { ZodType } from 'zod';

export type MissionState =
  | 'draft' | 'baseline_ready' | 'analyzing' | 'blocked' | 'awaiting_approval'
  | 'executing' | 'verifying' | 'recovery_required' | 'completed' | 'failed' | 'cancelled';

export interface RoleDef {
  key: string; name: string; kind: 'agent' | 'human'; responsibility: string; department?: string;
  /** Session 16 tool scope. 'read' = analyse and report only (its output may not carry actions). Default 'act'. */
  scope?: 'read' | 'act';
}
export interface ChangeItem {
  field: string; label: string; before: unknown; after: unknown; kind: 'modified' | 'added' | 'removed';
  severity: 'high' | 'medium' | 'low'; note?: string;
}
/** Declarative dependency model: which pack artifacts exist, and what a changed field propagates to. */
export interface ArtifactDef { key: string; label: string; department: string; ownerRole: string; description: string }
export interface DependencyRule { id: string; trigger: (item: ChangeItem) => boolean; to: string; relation: string; why: string }
export interface ArtifactEdge { from: string; to: string; relation: string; why: string }
export interface DecisionDef { key: string; label: string; ownerRole: string; gates: string[] /* artifact keys */ }

export interface QuestionSpec {
  key: string; text: string; blocking: boolean; assigneeRole: string;
  /** When true ONLY the person mapped to `assigneeRole` may answer (managers cannot answer on their behalf). Fail-closed if the role is unmapped. */
  assigneeOnly?: boolean;
}
export interface WorkItemSpec {
  key: string; title: string; detail: string; department: string; roleKey: string; kind: 'task' | 'review' | 'decision';
  artifactKey?: string; due?: string;
  /** Work-item keys that must be done before this one can be marked done (enforced by the engine). */
  dependsOn?: string[];
  /** Key of another work item whose completion is explicit evidence for this one (auto-satisfied, audited). */
  satisfiedBy?: string;
}
export interface DraftSpec { kind: string; name: string; content: string; ownerRole: string; artifactKey?: string }
export interface ActionSpec {
  key: string; type: string; title: string; connector: string; ownerRole: string; consequential: boolean;
  draftKind: string; approvalRole: 'manager' | 'owner'; ackRoles: string[]; rationale: string; target: string;
  /** Identity of the real-world effect. Same effectKey + same content hash => same effect (idempotent). */
  effectKey: string;
  /**
   * Optional who-specific gate ON TOP of `approvalRole`: only this person may decide the approval
   * (e.g. "only the requester approves", "only the data steward signs off").
   * `role` = the person mapped to that pack role in the workspace; `email` = one specific workspace user.
   * Fail-closed: if nobody resolves, nobody can approve and the approval says so.
   */
  approver?: { role?: string; email?: string };
  /**
   * Session 16 four-eyes rule (inherited from Shipyard's second-person approval): the person who SUBMITTED the change
   * may not decide this approval, whatever else the approver gate allows. Fail-closed and enforced in decideApproval.
   */
  separateFromRequester?: boolean;
  /**
   * Obligation dependencies (fail-closed, enforced by the engine at execution time): this action may run only after
   * the listed actions (by key, same analysis revision) are VERIFIED and the listed work items (by key) are DONE.
   * Example: "do not tell the customer about a refund until Finance's refund is verified and Engineering confirmed the fix".
   */
  blockedUntil?: { actions?: string[]; workItems?: string[] };
  /**
   * Session 16 quiet hours (inherited from Hermit's bedtime gate): execution is refused, and nothing changes state, while the
   * current UTC hour is inside the window. The window may wrap midnight (e.g. fromHour 22, toHour 6).
   */
  quietHours?: { fromHour: number; toHour: number };
  /**
   * Session 16 approval expiry (inherited from Shipyard's approval TTL): the approval expires this many minutes after it is
   * requested. An expired approval cannot be decided, and the sweep moves its action back to stale.
   */
  approvalTtlMinutes?: number;
  /**
   * Session 21: the case room (topology key) in which this approval must be decided. With competition mode on
   * (RIPPLE_SWITCH_REQUIRED=1) a decision is accepted ONLY from an authenticated person in that Switch room.
   */
  decisionRoom?: string;
  /** Session 21 two-person control: a SECOND, distinct person (mapped to this role) must also approve the exact payload. */
  coApprover?: { role: string };
  /** Session 21 separation of duties: the person who executes may not be one of the people who approved. */
  separateExecutor?: boolean;
  /** Session 21: refuse execution until the independent verifier issued a PASS receipt for the current revision. */
  requiresVerifierPass?: boolean;
}
/** A record that enters a case's evidence manifest (Merkle-committed, selectively disclosable). */
export interface EvidenceRecord { id: string; kind: string; source: string; room: string; content: string }
/** A fact an earlier case left behind (session 21 evidence-based memory). */
export interface MemoryItem {
  id: string; subject: string; kind: string; fact: string; data: Record<string, unknown>;
  status: 'recorded' | 'hypothesis' | 'superseded'; confidence: number; ownerRole: string | null;
  sourceMissionId: string; sourceRef: string; policyVersion: string | null; recordedAt: string;
}
export interface MemorySpec { subject: string; kind: string; fact: string; data?: Record<string, unknown>; ownerRole?: string; confidence?: number; policyVersion?: string; sourceRef: string }
/** What the independent verifier may read: approved payloads, approvals and connector READ-BACKS. Never an executor's report. */
export interface VerifierInput {
  baselinePlan: any; change: any; answers: AnalysisContext['answers'];
  actions: { key: string; type: string; status: string; payload: any; payloadHash: string; recomputedPayloadHash: string; idempotencyKey: string; recomputedIdempotencyKey: string; observed: { found: boolean; count: number; content: string } | null; executedBy: string | null }[];
  approvals: { actionKey: string; slot: number; status: string; decidedBy: string | null; decidedVia: string | null; approverUserId: string | null; payloadHash: string | null; decisionAccepted: boolean | null }[];
  requesterUserId: string | null;
  switchRequired: boolean;
}
export interface Finding { severity: 'info' | 'warning' | 'risk'; text: string; needsHumanReview?: boolean }
/** An agent asking the orchestrator to re-analyse another role. Honoured only if that role's inputs actually changed. */
export interface RoleRequest { roleKey: string; reason: string }
export interface RoleResult {
  roleKey: string; summary: string; findings: Finding[]; questions: QuestionSpec[]; workItems: WorkItemSpec[];
  drafts: DraftSpec[]; actions: ActionSpec[]; analyzer: string /* e.g. rule-engine@1 */;
  data?: Record<string, unknown>;
  /** Optional agent-to-agent request channel (orchestrator routes it; see engine/orchestrator.ts). */
  requests?: RoleRequest[];
  /** Session 21: room-scoped documents this role writes in ITS room (e.g. the evidence manifest). */
  documents?: { name: string; description: string; content: string }[];
  /** Session 21: cross-room handoffs carrying only claims + evidence references (never raw records) to another role's room. */
  handoffs?: { to: string; summary: string; claims: string[]; evidenceRefs?: string[] }[];
}
export interface AnalysisContext {
  today: string;
  plan: any;                       // approved baseline plan
  change: any;                     // raw change input
  items: ChangeItem[];
  answers: Record<string, { text: string; value?: any }>;
  revisedPlan: any;                // plan with change (+answers) applied, NOT yet baseline
  results: Record<string, RoleResult>; // results of roles earlier in roleOrder
  impacted: { artifacts: string[]; departments: string[] };
  /** Session 21: facts earlier completed cases left behind for the same subject (with status and source). */
  memory?: MemoryItem[];
  /** Session 21: the human-typeable case reference (RPL-XXXXXX). */
  caseRef?: string;
}
export interface CompletionCheck { key: string; label: string; passed: boolean; detail: string }

export interface WorkflowPack {
  id: string; name: string; domain: string; version: string; description: string;
  roles: RoleDef[]; roleOrder: string[];
  planSchema: ZodType; changeSchema: ZodType;
  artifacts: ArtifactDef[]; rules: DependencyRule[]; artifactEdges: ArtifactEdge[]; decisions: DecisionDef[];
  sample(): { title: string; plan: any; change: any };
  parsePlanText?(text: string): unknown;
  detectChanges(plan: any, change: any, answers?: AnalysisContext['answers']): ChangeItem[];
  applyChange(plan: any, change: any, answers: AnalysisContext['answers']): any;
  analyzeRole(roleKey: string, ctx: AnalysisContext): RoleResult;
  /** Validate/normalize a human answer to a pack question. */
  parseAnswer?(key: string, text: string, plan: any): { value?: any; error?: string };
  /** Pack-specific verification of a connector result beyond generic checks. Returns extra evidence checks. */
  verifyAction?(action: { type: string; payload: any }, observed: { content: string }, revisedPlan: any, ctx?: { baselinePlan: any; change: any; answers: AnalysisContext['answers'] }): { name: string; passed: boolean; detail: string }[];
  /** Pack-specific completion criteria (engine adds the generic ones). Receives the real current plan state. */
  completionChecks?(ctx: CompletionContext): CompletionCheck[];
  /** Domain wording for generic UI labels. */
  labels?: PackLabels;
  /**
   * Registry tier (session 19). 'core' packs form the default registry; every other pack is 'extended'. Packs are
   * discovered from src/server/packs/<folder>/pack.ts, so a pack registers itself by existing: there is no central list
   * for a merge to lose.
   */
  tier?: 'core' | 'extended';
  /** Capability system whose dashboard workspace shows this pack (catalog.ts). Declared by the pack itself. */
  system?: 'engineering' | 'incident' | 'commerce' | 'knowledge' | 'personal' | 'creative' | 'data';
  /** Session 18: what this pack's agents are forbidden to do, shown on the People & Agents page (replaces a pack-id switch in the UI). */
  agentLimit?: string;
  /**
   * Orchestrator input declaration per role. A role is re-run only when its fingerprint (its declared inputs +
   * the outputs of `roleDeps`) differs from the last run; otherwise its previous result is reused.
   * Defaults: inputs = {change, items, answers, revisedPlan}; deps = every earlier role in roleOrder.
   */
  roleInputs?(roleKey: string, ctx: AnalysisContext): unknown;
  roleDeps?: Record<string, string[]>;
  /**
   * Session 15 (Level 3): optional declaration of a dynamically provisioned Switch case topology.
   * Pure configuration — the engine executes it generically through the collab boundary (only the Switch
   * adapter can run it); packs never run Switch protocol calls themselves. See collab/port.ts.
   */
  switchCaseTopology?: import('../collab/port.js').SwitchCaseTopology;
  /**
   * Session 21 (flagship): the case room topology. Declaring it makes the pack SWITCH-NATIVE: in competition mode
   * (RIPPLE_SWITCH_REQUIRED=1) its missions run only on a verified Switch fabric and its approvals are decided only in
   * the declared Switch decision rooms by authenticated people.
   */
  caseRooms?: import('../collab/port.js').CaseRoomsTopology;
  /** Session 21: records that enter the case evidence manifest (Merkle-committed; disclosed selectively). */
  evidenceRecords?(plan: any, change: any): EvidenceRecord[];
  /**
   * Session 21: an INDEPENDENT verifier, separate from the proposing roles. It receives only approved payloads, approval
   * rows and connector read-backs (VerifierInput), recomputes its own checks, and its verdict gates completion.
   * Each failed check names the role that owns the fix (the work order).
   */
  independentVerifier?: { roleKey: string; verify(input: VerifierInput): { name: string; passed: boolean; detail: string; ownerRole?: string; fix?: string }[] };
  /** Session 21: facts a COMPLETED case leaves for later cases (only completed, verified cases write memory). */
  memoryFacts?(ctx: CompletionContext): MemorySpec[];
}

export interface CompletionContext { baselinePlan: any; revisedPlan: any; change: any; answers: AnalysisContext['answers']; today: string }
export interface PackLabels { baseline: string; change: string; changeVerb: string; plan: string; mission: string; blurb: string }

export class EngineError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
