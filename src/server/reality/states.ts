import { EngineError } from '../engine/types.js';

/**
 * Explicit state machine for consequential operations and the reality workflows that contain them.
 * Rules encoded here (tested in tests/reality.test.ts):
 *  - Tool success never moves an operation straight to VERIFIED: EXECUTING may only go to OBSERVATION_PENDING,
 *    EXECUTION_UNKNOWN, FAILED (or a workflow-level PARTIALLY_COMPLETED / REQUIRES_HUMAN). VERIFIED is reachable only
 *    from VERIFICATION_PENDING, i.e. after an independent read happened.
 *  - A timeout is not a failure: EXECUTING -> EXECUTION_UNKNOWN, which must be reconciled (read back) before anything else.
 *  - A verified result can become stale (VERIFIED -> RECONCILIATION_REQUIRED) when a later observation disagrees.
 */
export type RState =
  | 'PLANNED' | 'AUTHORIZATION_PENDING' | 'AUTHORIZED' | 'EXECUTING' | 'EXECUTION_UNKNOWN' | 'OBSERVATION_PENDING'
  | 'VERIFICATION_PENDING' | 'VERIFIED' | 'FAILED' | 'PARTIALLY_COMPLETED' | 'RECONCILIATION_REQUIRED' | 'RECOVERING'
  | 'RECOVERED' | 'REQUIRES_HUMAN' | 'CANCELLED';

export const TERMINAL: RState[] = ['VERIFIED', 'RECOVERED', 'CANCELLED'];

const T: Record<RState, RState[]> = {
  PLANNED: ['AUTHORIZATION_PENDING', 'CANCELLED'],
  AUTHORIZATION_PENDING: ['AUTHORIZED', 'REQUIRES_HUMAN', 'CANCELLED'],
  AUTHORIZED: ['EXECUTING', 'AUTHORIZATION_PENDING', 'REQUIRES_HUMAN', 'CANCELLED'],
  EXECUTING: ['OBSERVATION_PENDING', 'EXECUTION_UNKNOWN', 'FAILED', 'PARTIALLY_COMPLETED', 'RECONCILIATION_REQUIRED', 'REQUIRES_HUMAN', 'VERIFICATION_PENDING', 'AUTHORIZATION_PENDING'],
  EXECUTION_UNKNOWN: ['OBSERVATION_PENDING', 'FAILED', 'REQUIRES_HUMAN', 'RECONCILIATION_REQUIRED'],
  OBSERVATION_PENDING: ['VERIFICATION_PENDING', 'EXECUTION_UNKNOWN', 'FAILED', 'REQUIRES_HUMAN', 'RECONCILIATION_REQUIRED', 'EXECUTING'],
  VERIFICATION_PENDING: ['VERIFIED', 'FAILED', 'RECONCILIATION_REQUIRED', 'PARTIALLY_COMPLETED', 'REQUIRES_HUMAN', 'EXECUTING'],
  VERIFIED: ['RECONCILIATION_REQUIRED'],
  FAILED: ['EXECUTING', 'RECOVERING', 'REQUIRES_HUMAN', 'CANCELLED', 'RECONCILIATION_REQUIRED'],
  PARTIALLY_COMPLETED: ['RECONCILIATION_REQUIRED', 'REQUIRES_HUMAN'],
  RECONCILIATION_REQUIRED: ['RECOVERING', 'REQUIRES_HUMAN', 'VERIFICATION_PENDING', 'CANCELLED'],
  RECOVERING: ['RECOVERED', 'FAILED', 'REQUIRES_HUMAN', 'VERIFICATION_PENDING'],
  RECOVERED: ['RECONCILIATION_REQUIRED'],
  REQUIRES_HUMAN: ['RECOVERING', 'AUTHORIZATION_PENDING', 'AUTHORIZED', 'CANCELLED', 'RECONCILIATION_REQUIRED', 'EXECUTING'],
  CANCELLED: [],
};

export function canMove(from: RState, to: RState) { return from === to || (T[from] ?? []).includes(to); }
export function assertMove(from: RState, to: RState) {
  if (!canMove(from, to)) throw new EngineError(409, 'invalid_transition', `Invalid reality transition ${from} -> ${to}.`);
}
export const R_STATES = Object.keys(T) as RState[];
