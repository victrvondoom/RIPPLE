import type { Fault, Patch, ResourceState } from '../types.js';

/**
 * CROSS-DOMAIN INVARIANT INTELLIGENCE (CDII) — typed model.
 * A campaign is one shared sandbox world in which several workflows (each from a domain pack) intersect through shared
 * resources, budgets, policies, evidence and time. Invariants are typed data evaluated by a closed set of evaluators
 * (invariants.ts). There is no eval, no expression language and no user code anywhere in this layer.
 */

export interface Ref { system: string; resource: string }
export const refKey = (r: Ref) => `${r.system}/${r.resource}`;
export const parseRef = (k: string): Ref => { const i = k.indexOf('/'); return { system: k.slice(0, i), resource: k.slice(i + 1) }; };
export interface FieldRef extends Ref { field: string }

// ------------------------------------------------------------------ invariants
export type InvariantType =
  | 'uniqueness' | 'capacity' | 'budget' | 'authorization' | 'temporal_order' | 'freshness'
  | 'consistency' | 'lineage' | 'mutual_exclusion' | 'recovery_safety' | 'completeness' | 'provenance' | 'pack';
export const INVARIANT_TYPE_LABELS: Record<InvariantType, string> = {
  uniqueness: 'Uniqueness: one resource cannot be reserved or consumed twice',
  capacity: 'Capacity: committed demand cannot exceed available capacity',
  budget: 'Budget: aggregate committed spending stays within the authorized limit',
  authorization: 'Authorization: valid authority must exist at execution time',
  temporal_order: 'Temporal ordering: one action must occur before another',
  freshness: 'Freshness: evidence must still be valid at the point of use',
  consistency: 'Cross-system consistency: linked resources must agree',
  lineage: 'Data lineage: downstream consumers must not rely on invalidated upstream data',
  mutual_exclusion: 'Mutual exclusion: conflicting commitments cannot overlap in time',
  recovery_safety: 'Recovery safety: a corrective action must not violate another protected invariant',
  completeness: 'Completeness: all required dependent operations must be verified',
  provenance: 'Provenance: consequential claims must be backed by attributable evidence',
  pack: 'Domain-pack evaluator (typed, contributed by a pack)',
};

export type InvariantSpec =
  | { type: 'uniqueness'; ref: Ref; holderField: string }
  | { type: 'capacity'; ref: Ref; capacityField: string; usedField: string }
  | { type: 'budget'; ref: Ref; limitField: string; spentField: string }
  | { type: 'authorization'; workflow: string; role: 'manager' | 'owner' }
  | { type: 'temporal_order'; before: { workflow: string; op: string }; after: { workflow: string; op: string } }
  | { type: 'freshness'; workflow: string; ref: Ref }
  | { type: 'consistency'; rule: 'implies'; if: FieldRef & { equals: unknown }; then: FieldRef & { equals: unknown } }
  | { type: 'consistency'; rule: 'pointer'; if: FieldRef & { equals: unknown }; pointer: FieldRef; targetSystem: string; targetField: string; equals: unknown }
  | { type: 'lineage'; upstream: Ref; compatField: string; downstream: Ref; expectsField: string }
  | { type: 'mutual_exclusion'; ref: Ref; slotsField: string }
  | { type: 'recovery_safety'; protects: string[] }
  | { type: 'completeness'; workflow: string; ops: string[] }
  | { type: 'provenance'; workflow: string }
  | { type: 'pack'; pack: string; evaluator: string; params: Record<string, unknown>; reads: Ref[] };

export type Strength = 'hard' | 'soft' | 'conditional' | 'advisory';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type ApprovalLevel = 'none' | 'manager' | 'owner';

/** Full invariant record (persisted in cd_invariants). */
export interface InvariantDef {
  key: string; version?: number; name: string; explanation: string;
  scope: 'workspace' | 'workflow' | 'resource' | 'domain' | 'cross-domain';
  owner?: string;                       // owning workflow key for workflow-scoped (local) invariants
  spec: InvariantSpec;
  requiredEvidence?: string[];          // human-readable list of the reads this invariant needs
  preconditions?: string[];
  severity: Severity; impact: string;
  validFrom?: string; validUntil?: string;
  resolutionPolicy: string;             // how conflicts on this invariant may be resolved
  approvalLevel: ApprovalLevel;
  strength: Strength;
  /** conditional strength: the invariant is hard only while this workflow is active (not cancelled). */
  conditionWorkflow?: string;
  autoRestorable: boolean;
  provenance: { source: 'policy' | 'pack' | 'plan-declaration' | 'inferred'; by: string; note?: string };
  confidence?: number; uncertainty?: string;
  dependsOn?: string[];
}

export type EvalResult = 'satisfied' | 'violated' | 'unknown' | 'not_applicable';
export interface Evaluation {
  key: string; result: EvalResult; detail: string;
  reads: string[];          // ref keys read
  participants: string[];   // workflow keys whose state or commitments contribute
  unreadable: string[];
}

// ------------------------------------------------------------------ operations, commitments, workflows
export type EffectKind = 'reserve' | 'consume' | 'spend' | 'schedule' | 'modify' | 'release' | 'publish' | 'compensate';
export interface OpDef {
  key: string; label: string; system: string; resource: string;
  patch: Patch;
  effect: { kind: EffectKind; amount?: number; holder?: string; window?: [number, number]; field?: string };
  reversibility: 'reversible' | 'compensable' | 'irreversible';
  compensate?: { label: string; patch: Patch };
  expect: { field: string; equals: unknown }[];
  /** Flexibility a domain pack may use to propose alternatives (never applied without arbitration + approval). */
  flex?: { minAmount?: number; alternates?: string[]; windows?: [number, number][]; substituteClass?: string };
  claim?: string;            // what the executing agent declares when its tool call returns
  approvalLevel?: ApprovalLevel;
  /** a proposed compensating step of a failed workflow (part of its own plan) */
  isCompensation?: boolean;
  /** world facts the executing agent declares once its tool call returns (checked against independent reads) */
  asserts?: { ref: string; field: string; equals: unknown }[];
  /** run by its own workflow's schedule as a concurrent event — outside any arbitration in this campaign */
  scheduled?: boolean;
}
export interface Commitment { workflow: string; op: string; ref: string; kind: EffectKind; amount: number; holder?: string; window?: [number, number] }

export interface WorkflowDef {
  key: string; pack: string; title: string; intent: string; owner: string;
  ops: OpDef[];
  approvedBy?: string;        // user handle; the scripted approval is bound to the plan hash computed at planning time
  /** planning-time evidence that is OLDER than the world history (observed before the history happened). */
  stalePlanningEvidence?: Ref[];
  /** explicit, declared dependencies on other workflows (anything else shared is "hidden") */
  declaredLinks?: string[];
  localInvariants?: InvariantDef[];
}

/** A scripted event at a lifecycle point of the campaign (labelled; recorded in the causal ledger). */
export interface CampaignEvent {
  at: 'before_resolution';    // B4: after a resolution is approved, before it executes. Baselines: before the naive continuation.
  kind: 'workflow_op' | 'external';
  workflow?: string; op?: string;           // workflow_op: a concurrent workflow (outside this arbitration) executes one of its ops
  ref?: Ref; patch?: Patch; actor?: string; // external
  label: string;
}

export type Pattern =
  | 'resource_collision' | 'constraint_collision' | 'temporal_collision' | 'dependency_invalidation' | 'recovery_collateral'
  | 'split_authority' | 'cross_domain_partial_commit' | 'hidden_shared_constraint' | 'contradictory_declarations' | 'temporal_evidence_invalidation'
  | 'unknown_state';
export const PATTERN_LABELS: Record<Pattern, string> = {
  resource_collision: 'A · Resource collision',
  constraint_collision: 'B · Constraint collision',
  temporal_collision: 'C · Temporal collision',
  dependency_invalidation: 'D · Dependency invalidation',
  recovery_collateral: 'E · Recovery collateral damage',
  split_authority: 'F · Split authority',
  cross_domain_partial_commit: 'G · Cross-domain partial commit',
  hidden_shared_constraint: 'H · Hidden shared constraint',
  contradictory_declarations: 'I · Contradictory declarations',
  temporal_evidence_invalidation: 'J · Temporal evidence invalidation',
  unknown_state: 'Unknown state (cannot be evaluated)',
};

export interface CdScenario {
  id: string; title: string; story: string; packs: string[];
  initial: { system: string; resource: string; state: ResourceState }[];
  workflows: WorkflowDef[];
  sharedInvariants: InvariantDef[];
  /** the world's history: ops executed (in this order) while the campaign is set up. `fail` marks a step that failed. */
  history?: { workflow: string; op: string; fail?: 'unavailable' }[];
  events?: CampaignEvent[];
  /** faults activated after planning and history (labelled; sandbox only) */
  faults?: Fault[];
  /** who approves resolutions in scripted (benchmark) runs */
  resolutionApprover: string;
  /** Ground truth for the scorer ONLY (never read by the engine). */
  truth: {
    expectedPatterns: Pattern[];
    hiddenShared: number;
    dependencyInvalidations: number;
    unsafeAsPlanned: boolean;     // executing every workflow as planned violates a hard invariant
    staleOps: string[];           // ops whose decision basis is invalidated before they would run
    protectedInvariants: string[]; // invariants owned by workflows other than the one being repaired (collateral)
    feasible: boolean;
    unknownDecisions: number;     // decision points where a required read is unreadable
  };
}

// ------------------------------------------------------------------ domain packs
export interface PlanAction {
  workflow: string; op: string;
  kind: 'execute' | 'cancel' | 'compensate' | 'modify' | 'add';
  override?: { resource?: string; patch?: Patch; label?: string; expect?: { field: string; equals: unknown }[]; effect?: OpDef['effect'] };
  newOp?: OpDef;
  note?: string;
}
export interface AltContext {
  invariant: InvariantDef; evaluation: Evaluation;
  read: (ref: string) => ResourceState | undefined;   // simulated state of the plan being repaired
  world: string[];                                    // every resource key of the world (observed)
  workflows: { key: string; pack: string; ops: OpDef[]; status: Record<string, string> }[];
  actions: PlanAction[];                              // the plan being repaired
}
export interface Alternative { id: string; label: string; rationale: string; actions: PlanAction[]; replaces?: { workflow: string; op: string }[] }

export interface PackEvaluator { (params: Record<string, unknown>, read: (ref: string) => ResourceState | undefined): { ok: boolean; detail: string } }

export interface DomainPack {
  id: string; label: string; domain: string; description: string;
  systems: { system: string; label: string; agent: string }[];
  resourceTypes: { type: string; system: string; fields: string[]; description: string }[];
  evaluators?: Record<string, PackEvaluator>;
  /** Proposes alternatives for a violated invariant. Must only return actions on its own systems. */
  alternatives?(ctx: AltContext): Alternative[];
  /** A pack-specific "naive" recovery (e.g. roll back) offered to arbitration so its consequences are simulated, not assumed. */
  recoveries?(ctx: { workflows: AltContext['workflows']; read: AltContext['read'] }): Alternative[];
}
