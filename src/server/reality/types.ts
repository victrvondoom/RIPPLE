/** Types shared by the Reality Gap Engine, the sandbox lab, scenarios and the RIGOR benchmark. */

export type Patch = { set?: Record<string, unknown>; inc?: Record<string, number>; expect?: Record<string, unknown> };
export type ResourceState = Record<string, unknown>;
export type Reader = (system: string, resource: string) => ResourceState | undefined;

/** Deterministic fault injection. Every fault is labelled and stored on the workflow so a run is reproducible. */
export type FaultKind =
  | 'timeout_after_commit'   // effect applied, caller sees a timeout (lost response)
  | 'timeout_before_commit'  // no effect, caller sees a timeout
  | 'false_success'          // tool returns success, nothing changed
  | 'unavailable'            // mutate refused, system unreadable for `reads` observations
  | 'observe_unavailable'    // reads fail `reads` times (mutations unaffected)
  | 'delayed_consistency'    // effect applied, reads return the previous state `reads` times
  | 'handoff_duplicate'      // hand-off delivered twice
  | 'handoff_lost'           // receiving agent restarts before acknowledging
  | 'compensation_fails';    // compensating write has no effect
export interface Fault { kind: FaultKind; step?: string; system?: string; times?: number; reads?: number; label: string; /** observe faults: only after a write attempt to the system */ afterWrite?: boolean }

/** Something that happens in the outside world, independent of the agents (cancellation, drift, a rogue write). */
export interface ExternalEvent {
  /** Applied right before (`before`) or right after (`after`) the given step executes. */
  before?: string; after?: string;
  kind: 'mutate' | 'demote' | 'amend_plan' | 'message';
  system?: string; resource?: string; patch?: Patch; actor?: string;
  user?: string; role?: string; amend?: Record<string, unknown>; body?: string; label: string;
}

export interface Precondition { system: string; resource: string; field: string; equals: unknown; label: string }
export interface StepExpect { field: string; equals: unknown; label: string }

export interface StepDef {
  key: string; label: string; system: string; resource: string; agent: string;
  patch: Patch; consequential: boolean;
  reversibility: 'reversible' | 'compensable' | 'irreversible';
  compensate?: { label: string; patch: Patch };
  /** What an independent read must show after the step (post-condition). */
  expect: StepExpect[];
  precondition?: Precondition;
  /** Agent's own declaration once its tool call returns success (e.g. a payments agent announcing "order completed"). */
  claim?: string;
  /** Step must only run after every invariant of the earlier steps is independently verified (e.g. customer confirmation). */
  afterInvariants?: boolean;
}

export interface InvariantDef { id: string; label: string; eval: (read: Reader) => { ok: boolean; detail: string } }

export interface ScriptedApproval { user: string; subject: 'plan' | 'recovery'; channel?: 'structured' | 'message'; planVersion?: 'current' | 'previous' }

export interface Scenario {
  id: string; family: string; familyLabel: string; title: string; intent: string;
  initial: { system: string; resource: string; state: ResourceState }[];
  steps: StepDef[];
  invariants: InvariantDef[];
  approval: { role: 'manager' | 'owner'; twoPerson?: boolean };
  faults: Fault[];
  events?: ExternalEvent[];
  approvals: ScriptedApproval[];
  /** Ground truth for scoring only (never read by the engine while it runs). */
  truth: {
    achievable: boolean;          // can a correct system reach all invariants?
    partialCommit?: boolean;      // the fault produces a partial commit
    shouldRefuse?: boolean;       // a correct system must refuse to execute (bad authorization / stale evidence)
    expectedGaps: string[];       // gap classes a correct detector should raise
  };
  showcase?: boolean;
}

export interface Controls {
  independentVerification: boolean; readBackOnError: boolean; guardedWrites: boolean; durableHandoffs: boolean;
  approvalGate: boolean; approvalPlanBinding: boolean; twoPersonRule: boolean; roleCheck: boolean;
  structuredApprovalsOnly: boolean; evidenceFreshness: boolean; reconciliation: boolean; recoveryPlanner: boolean;
  gateFinalSteps: boolean;
}

export const CONTROL_LABELS: Record<keyof Controls, string> = {
  independentVerification: 'Independent post-action read-back verification',
  readBackOnError: 'Read back before deciding a timeout/error outcome',
  guardedWrites: 'Idempotency keys + conditional (compare-and-set) writes',
  durableHandoffs: 'Durable hand-offs (dedupe, lease, redelivery after restart)',
  approvalGate: 'Human approval required for consequential operations',
  approvalPlanBinding: 'Approval bound to plan version/hash (and expiry)',
  twoPersonRule: 'Two distinct approvers where the policy requires it',
  roleCheck: 'Approver role re-checked at execution time',
  structuredApprovalsOnly: 'Only authenticated structured approvals count (message text never does)',
  evidenceFreshness: 'Mutable evidence re-observed before a consequential step; unknown is never treated as available',
  reconciliation: 'Cross-system invariant reconciliation after execution',
  recoveryPlanner: 'Counterfactual recovery planning + guarded recovery execution',
  gateFinalSteps: 'Customer-facing confirmation only after invariants are verified',
};

const ALL_ON: Controls = Object.fromEntries(Object.keys(CONTROL_LABELS).map((k) => [k, true])) as unknown as Controls;
const ALL_OFF: Controls = Object.fromEntries(Object.keys(CONTROL_LABELS).map((k) => [k, false])) as unknown as Controls;

/** Transparent baselines for RIGOR. Same runner, same scenarios; only these switches differ. */
export const BASELINES: Record<string, { label: string; description: string; controls: Controls }> = {
  'B1-single-agent': {
    label: 'B1 · Single agent, tool-calling, no verification',
    description: 'One agent calls each tool, trusts the response, retries errors blindly, accepts any approval it reads (including text in messages).',
    controls: { ...ALL_OFF, approvalGate: true },
  },
  'B2-handoffs-no-reconciliation': {
    label: 'B2 · Multi-agent hand-offs, no durable reconciliation',
    description: 'Specialist agents with structured approvals and role checks, but in-memory hand-offs, no idempotency, no read-back and no reconciliation.',
    controls: { ...ALL_OFF, approvalGate: true, roleCheck: true, structuredApprovalsOnly: true },
  },
  'B3-approval-no-verification': {
    label: 'B3 · Multi-agent with governed approval, no post-action verification',
    description: 'Durable hand-offs, idempotency, plan-bound two-person approvals and role checks — but tool responses are trusted and nothing is reconciled afterwards.',
    controls: { ...ALL_OFF, approvalGate: true, approvalPlanBinding: true, twoPersonRule: true, roleCheck: true, structuredApprovalsOnly: true, guardedWrites: true, durableHandoffs: true },
  },
  'B4-resolve-full': {
    label: 'B4 · RIPPLE with the full Reality Integrity layer',
    description: 'Every control on: governed approvals, durable hand-offs, guarded writes, evidence freshness, read-back on error, independent verification, reconciliation and counterfactual recovery.',
    controls: ALL_ON,
  },
};
export const FULL_CONTROLS = ALL_ON;

export type GapClass =
  | 'no_op' | 'partial_commit' | 'duplicate_effect' | 'stale_completion' | 'conflicting_completion'
  | 'unauthorized_mutation' | 'lost_handoff' | 'delayed_consistency' | 'unknown_outcome' | 'compensation_failure'
  | 'invariant_violation' | 'authorization_invalid' | 'stale_evidence';

export const GAP_LABELS: Record<GapClass, string> = {
  no_op: 'No-op: reported done, nothing changed',
  partial_commit: 'Partial commit across systems',
  duplicate_effect: 'Duplicate effect',
  stale_completion: 'Stale completion (was true, no longer is)',
  conflicting_completion: 'Conflicting completion claims',
  unauthorized_mutation: 'Unauthorized mutation',
  lost_handoff: 'Lost hand-off',
  delayed_consistency: 'Delayed consistency (not yet converged)',
  unknown_outcome: 'Unknown outcome',
  compensation_failure: 'Compensation failure',
  invariant_violation: 'Intended outcome not reached',
  authorization_invalid: 'Authorization invalid (execution prevented)',
  stale_evidence: 'Stale or unknown evidence (execution prevented)',
};
