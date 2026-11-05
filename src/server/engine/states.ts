import type { MissionState } from './types.js';
import { EngineError } from './types.js';

/** Explicit, validated transition table. Anything not listed is rejected. */
export const TRANSITIONS: Record<MissionState, MissionState[]> = {
  draft: ['baseline_ready', 'cancelled'],
  baseline_ready: ['analyzing', 'cancelled'],
  analyzing: ['blocked', 'awaiting_approval', 'failed', 'cancelled'],
  blocked: ['analyzing', 'cancelled'],
  awaiting_approval: ['executing', 'analyzing', 'blocked', 'cancelled'],
  executing: ['verifying', 'recovery_required', 'awaiting_approval', 'analyzing', 'cancelled'],
  verifying: ['completed', 'executing', 'recovery_required', 'awaiting_approval', 'analyzing', 'cancelled'],
  recovery_required: ['executing', 'verifying', 'analyzing', 'failed', 'cancelled'],
  completed: ['baseline_ready'],        // a completed mission can accept a later change via the new baseline
  failed: ['analyzing', 'cancelled'],
  cancelled: [],
};

export const STATE_LABEL: Record<MissionState, string> = {
  draft: 'Draft', baseline_ready: 'Baseline ready', analyzing: 'Analyzing', blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval', executing: 'Executing', verifying: 'Verifying',
  recovery_required: 'Recovery required', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};

export function assertTransition(from: MissionState, to: MissionState) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new EngineError(409, 'invalid_transition', `Mission cannot move from "${from}" to "${to}".`);
  }
}
