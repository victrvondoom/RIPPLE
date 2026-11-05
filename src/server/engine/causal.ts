import { Db, uid, nowIso, type Row } from '../db/db.js';

export type CausalLifecycleState =
  | 'PLANNED'
  | 'AUTHORIZED'
  | 'EXECUTING'
  | 'EXECUTION_UNKNOWN'
  | 'OBSERVED'
  | 'VERIFICATION_PENDING'
  | 'VERIFIED'
  | 'FAILED'
  | 'RECOVERING'
  | 'RECOVERED'
  | 'REQUIRES_HUMAN'
  // Reality Gap Engine states (session 7)
  | 'AUTHORIZATION_PENDING'
  | 'OBSERVATION_PENDING'
  | 'PARTIALLY_COMPLETED'
  | 'RECONCILIATION_REQUIRED'
  | 'CANCELLED'
  | 'FAULT_INJECTED';

export type CauseType =
  | 'telemetry_anomaly'
  | 'schema_drift'
  | 'code_change'
  | 'contract_deviation'
  | 'human_decision'
  | 'agent_inference'
  | 'action_execution'
  | 'verification_probe'
  | 'system_recovery'
  | 'reality_gap'
  | 'governance'
  | 'agent_handoff'
  | 'fault_injection';

export interface CausalEvent {
  id: string;
  workspace_id: string;
  mission_id: string;
  parent_event_id: string | null;
  cause_type: CauseType;
  lifecycle_state: CausalLifecycleState;
  summary: string;
  actor: string;
  confidence: number;
  observed_state: Record<string, unknown>;
  idempotency_key?: string | null;
  created_at: string;
}

export interface CausalEdge {
  from: string;
  to: string;
  relation: string;
}

export interface CausalGraphResult {
  nodes: CausalEvent[];
  edges: CausalEdge[];
  summary: {
    totalEvents: number;
    verifiedNodes: number;
    recoveringNodes: number;
    requiresHuman: number;
    rootCauses: number;
  };
}

/** Record an immutable causal link in the causal state ledger. */
export function recordCausalEvent(
  db: Db,
  input: {
    workspaceId: string;
    missionId: string;
    parentEventId?: string | null;
    causeType: CauseType;
    lifecycleState: CausalLifecycleState;
    summary: string;
    actor: string;
    confidence?: number;
    observedState?: Record<string, unknown>;
    idempotencyKey?: string | null;
  }
): CausalEvent {
  const id = uid('cau');
  const created_at = nowIso();
  const row: CausalEvent = {
    id,
    workspace_id: input.workspaceId,
    mission_id: input.missionId,
    parent_event_id: input.parentEventId ?? null,
    cause_type: input.causeType,
    lifecycle_state: input.lifecycleState,
    summary: input.summary,
    actor: input.actor,
    confidence: input.confidence ?? 1.0,
    observed_state: input.observedState ?? {},
    idempotency_key: input.idempotencyKey ?? null,
    created_at,
  };

  db.insert('causal_events', {
    id: row.id,
    workspace_id: row.workspace_id,
    mission_id: row.mission_id,
    parent_event_id: row.parent_event_id,
    cause_type: row.cause_type,
    lifecycle_state: row.lifecycle_state,
    summary: row.summary,
    actor: row.actor,
    confidence: row.confidence,
    observed_state: JSON.stringify(row.observed_state),
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
  });

  return row;
}

/** Retrieve the entire causal graph for a mission with derived edges and summary telemetry. */
export function getCausalGraph(db: Db, workspaceId: string, missionId: string): CausalGraphResult {
  const rows = db.all<Row>(
    'SELECT * FROM causal_events WHERE workspace_id=? AND mission_id=? ORDER BY created_at ASC',
    workspaceId,
    missionId
  );

  const nodes: CausalEvent[] = rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    mission_id: r.mission_id,
    parent_event_id: r.parent_event_id,
    cause_type: r.cause_type as CauseType,
    lifecycle_state: r.lifecycle_state as CausalLifecycleState,
    summary: r.summary,
    actor: r.actor,
    confidence: Number(r.confidence),
    observed_state: typeof r.observed_state === 'string' ? JSON.parse(r.observed_state || '{}') : r.observed_state,
    idempotency_key: r.idempotency_key,
    created_at: r.created_at,
  }));

  const edges: CausalEdge[] = [];
  const nodeMap = new Map<string, CausalEvent>();
  for (const n of nodes) nodeMap.set(n.id, n);

  for (const n of nodes) {
    if (n.parent_event_id && nodeMap.has(n.parent_event_id)) {
      edges.push({
        from: n.parent_event_id,
        to: n.id,
        relation: `caused_by_${nodeMap.get(n.parent_event_id)!.cause_type}`,
      });
    }
  }

  const rootCauses = nodes.filter((n) => !n.parent_event_id).length;
  const verifiedNodes = nodes.filter((n) => n.lifecycle_state === 'VERIFIED').length;
  const recoveringNodes = nodes.filter((n) => n.lifecycle_state === 'RECOVERING').length;
  const requiresHuman = nodes.filter((n) => n.lifecycle_state === 'REQUIRES_HUMAN').length;

  return {
    nodes,
    edges,
    summary: {
      totalEvents: nodes.length,
      verifiedNodes,
      recoveringNodes,
      requiresHuman,
      rootCauses,
    },
  };
}

/** Trace upstream root-cause chain starting from any event. */
export function traceRootCause(db: Db, workspaceId: string, eventId: string): CausalEvent[] {
  const chain: CausalEvent[] = [];
  let currentId: string | null = eventId;

  while (currentId) {
    const row = db.get<Row>(
      'SELECT * FROM causal_events WHERE id=? AND workspace_id=?',
      currentId,
      workspaceId
    );
    if (!row) break;
    const item: CausalEvent = {
      id: row.id,
      workspace_id: row.workspace_id,
      mission_id: row.mission_id,
      parent_event_id: row.parent_event_id,
      cause_type: row.cause_type as CauseType,
      lifecycle_state: row.lifecycle_state as CausalLifecycleState,
      summary: row.summary,
      actor: row.actor,
      confidence: Number(row.confidence),
      observed_state: typeof row.observed_state === 'string' ? JSON.parse(row.observed_state || '{}') : row.observed_state,
      idempotency_key: row.idempotency_key,
      created_at: row.created_at,
    };
    chain.push(item);
    currentId = item.parent_event_id;
  }

  return chain.reverse();
}

