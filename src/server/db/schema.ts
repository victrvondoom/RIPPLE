// Single authoritative schema. Every tenant-owned row carries workspace_id; all queries go through Repo, which scopes by it.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','manager','member','viewer')),
  department TEXT, title TEXT, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pack_id TEXT NOT NULL, title TEXT NOT NULL,
  state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', plan_source TEXT NOT NULL DEFAULT 'form',
  current_baseline_version INTEGER NOT NULL DEFAULT 0, change_seq INTEGER NOT NULL DEFAULT 0,
  analysis_rev INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  content TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, generated_by TEXT NOT NULL,
  baseline_version INTEGER, change_seq INTEGER, analysis_rev INTEGER, owner_role TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, version INTEGER NOT NULL,
  plan TEXT NOT NULL, plan_hash TEXT NOT NULL, note TEXT NOT NULL, approved_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (mission_id, version));
CREATE TABLE IF NOT EXISTS change_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, seq INTEGER NOT NULL,
  baseline_version INTEGER NOT NULL, source TEXT NOT NULL, description TEXT NOT NULL, input TEXT NOT NULL,
  items TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (mission_id, seq));
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('change','artifact','task','department','owner','decision','action','evidence')),
  key TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', data TEXT NOT NULL DEFAULT '{}',
  UNIQUE (mission_id, analysis_rev, key));
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  from_node TEXT NOT NULL, to_node TEXT NOT NULL, relation TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  node_key TEXT, title TEXT NOT NULL, detail TEXT NOT NULL, department TEXT NOT NULL, owner_user_id TEXT,
  role_key TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, due TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_roles (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pack_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, responsibility TEXT NOT NULL, user_id TEXT, UNIQUE (workspace_id, pack_id, key));
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  role_key TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, mode TEXT NOT NULL, external_id TEXT,
  name TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, room_id TEXT NOT NULL, kind TEXT NOT NULL,
  sender_kind TEXT NOT NULL, sender_key TEXT NOT NULL, sender_name TEXT NOT NULL, to_key TEXT, body TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', ref_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  key TEXT NOT NULL, asked_by_role TEXT NOT NULL, assignee_user_id TEXT, text TEXT NOT NULL, blocking INTEGER NOT NULL,
  status TEXT NOT NULL, answer TEXT, answer_value TEXT, answered_by TEXT, created_at TEXT NOT NULL, answered_at TEXT,
  assignee_only INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mission_id, key));
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
  title TEXT NOT NULL, rationale TEXT NOT NULL, required_role TEXT NOT NULL, status TEXT NOT NULL,
  baseline_version INTEGER NOT NULL, change_seq INTEGER NOT NULL, analysis_rev INTEGER NOT NULL,
  decided_by TEXT, decision_note TEXT, decided_at TEXT, created_at TEXT NOT NULL,
  approver_user_id TEXT, approver_label TEXT, separate_from_requester INTEGER NOT NULL DEFAULT 0, expires_at TEXT);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL, connector TEXT NOT NULL, owner_role TEXT NOT NULL, owner_user_id TEXT, consequential INTEGER NOT NULL,
  artifact_id TEXT, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL, stale_reason TEXT, baseline_version INTEGER NOT NULL, change_seq INTEGER NOT NULL, analysis_rev INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, result TEXT, executed_at TEXT, created_at TEXT NOT NULL, quiet_hours TEXT);
CREATE TABLE IF NOT EXISTS acknowledgements (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, action_id TEXT NOT NULL,
  user_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT, acked_at TEXT, UNIQUE (action_id, user_id));
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, action_id TEXT, kind TEXT NOT NULL,
  check_name TEXT NOT NULL, passed INTEGER NOT NULL, detail TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  verifier TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
  criteria TEXT NOT NULL, unresolved TEXT NOT NULL, new_baseline_version INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}', fail_next INTEGER NOT NULL DEFAULT 0, UNIQUE (workspace_id, key));
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT, actor_kind TEXT NOT NULL, actor TEXT NOT NULL,
  type TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS causal_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, parent_event_id TEXT,
  cause_type TEXT NOT NULL, lifecycle_state TEXT NOT NULL, summary TEXT NOT NULL, actor TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0, observed_state TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT, created_at TEXT NOT NULL);
-- Orchestrator task graph: one row per role execution (or re-analysis) inside an analysis revision.
CREATE TABLE IF NOT EXISTS workflow_tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  pass INTEGER NOT NULL, role_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('analysis','reanalysis')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','reused','failed','interrupted','timed_out','cancelled','rejected')),
  fingerprint TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', requested_by TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]', reused_from TEXT, run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
-- ===== Reality Gap Engine (session 7). Every row is workspace-scoped. =====
-- A reality workflow is one consequential, multi-system operation with an execution contract (intent, steps, invariants).
CREATE TABLE IF NOT EXISTS rw_workflows (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scenario TEXT NOT NULL, family TEXT NOT NULL, title TEXT NOT NULL,
  intent TEXT NOT NULL, contract TEXT NOT NULL, plan_version INTEGER NOT NULL DEFAULT 1, plan_hash TEXT NOT NULL,
  state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', declared_status TEXT, observed_status TEXT,
  controls TEXT NOT NULL, baseline TEXT NOT NULL, source TEXT NOT NULL, bench_run_id TEXT, seed TEXT NOT NULL,
  fault_state TEXT NOT NULL DEFAULT '{}', authz_overrides TEXT NOT NULL DEFAULT '{}', collab_mode TEXT NOT NULL DEFAULT 'local',
  collab_note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rw_operations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, step_key TEXT NOT NULL, kind TEXT NOT NULL,
  system TEXT NOT NULL, resource TEXT NOT NULL, agent TEXT NOT NULL, label TEXT NOT NULL, patch TEXT NOT NULL,
  consequential INTEGER NOT NULL, reversibility TEXT NOT NULL, idempotency_key TEXT, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, declared TEXT NOT NULL DEFAULT '{}', tool_response TEXT, before_obs TEXT, after_obs TEXT,
  verifier TEXT NOT NULL DEFAULT '[]', classification TEXT, approval_ids TEXT NOT NULL DEFAULT '[]', parent_op_id TEXT, gap_id TEXT,
  causal_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rw_handoffs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, task_id TEXT NOT NULL, from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  deliveries INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, acked_at TEXT, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS rw_observations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, operation_id TEXT, purpose TEXT NOT NULL,
  system TEXT NOT NULL, resource TEXT NOT NULL, observer TEXT NOT NULL, available INTEGER NOT NULL, state TEXT,
  state_hash TEXT, updated_by TEXT, policy TEXT NOT NULL, observed_at TEXT NOT NULL, valid_until TEXT,
  invalidated_at TEXT, invalidated_reason TEXT);
CREATE TABLE IF NOT EXISTS rw_approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, subject TEXT NOT NULL, subject_hash TEXT NOT NULL,
  plan_version INTEGER NOT NULL, user_id TEXT, user_name TEXT NOT NULL, role_at_decision TEXT NOT NULL, channel TEXT NOT NULL,
  status TEXT NOT NULL, invalid_reason TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rw_gaps (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, class TEXT NOT NULL, subject TEXT NOT NULL,
  severity TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL, agents TEXT NOT NULL, systems TEXT NOT NULL,
  expected TEXT NOT NULL, declared TEXT NOT NULL, observed TEXT NOT NULL, evidence TEXT NOT NULL, confidence REAL NOT NULL,
  uncertainty TEXT NOT NULL, blast_radius TEXT NOT NULL, predecessors TEXT NOT NULL, investigation TEXT NOT NULL,
  hypothesis TEXT NOT NULL, approval_required TEXT NOT NULL, causal_id TEXT, detected_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE (workflow_id, class, subject));
CREATE TABLE IF NOT EXISTS rw_recovery_plans (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, gap_ids TEXT NOT NULL, options TEXT NOT NULL,
  recommended TEXT, chosen TEXT, objections TEXT NOT NULL, plan_hash TEXT NOT NULL, basis TEXT NOT NULL, status TEXT NOT NULL,
  result TEXT, causal_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS rw_passports (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, operation_id TEXT, status TEXT NOT NULL,
  body TEXT NOT NULL, body_hash TEXT NOT NULL, created_at TEXT NOT NULL);
-- Controlled sandbox "external systems" (clearly labelled; NOT production integrations). One isolated environment per workflow.
CREATE TABLE IF NOT EXISTS lab_resources (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, system TEXT NOT NULL, resource TEXT NOT NULL,
  state TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT NOT NULL, lag TEXT, updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, system, resource));
CREATE TABLE IF NOT EXISTS lab_effects (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, seq INTEGER NOT NULL, system TEXT NOT NULL,
  resource TEXT NOT NULL, op_key TEXT NOT NULL, idem_key TEXT, actor TEXT NOT NULL, patch TEXT NOT NULL, applied INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
-- RIGOR benchmark: every metric is computed from these rows.
CREATE TABLE IF NOT EXISTS bench_runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, seed TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, baselines TEXT NOT NULL, scenarios TEXT NOT NULL, metrics TEXT, code_version TEXT NOT NULL,
  created_by TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS bench_cases (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, scenario TEXT NOT NULL, family TEXT NOT NULL,
  baseline TEXT NOT NULL, faults TEXT NOT NULL, seed TEXT NOT NULL, workflow_id TEXT NOT NULL, declared TEXT NOT NULL,
  truth TEXT NOT NULL, counts TEXT NOT NULL, duration_ms REAL NOT NULL, created_at TEXT NOT NULL);
-- ===== Cross-Domain Invariant Intelligence (session 9). Every row is workspace-scoped. =====
-- A campaign is one shared Reality Lab world (lab_resources keyed by the campaign id) in which several workflows from
-- different domain packs intersect. Observations, approvals, arbitration plans and passports reuse rw_observations,
-- rw_approvals, rw_recovery_plans and rw_passports (workflow_id = campaign or cross-domain workflow id).
CREATE TABLE IF NOT EXISTS cd_campaigns (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scenario TEXT NOT NULL, title TEXT NOT NULL, story TEXT NOT NULL,
  state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', baseline TEXT NOT NULL, controls TEXT NOT NULL, source TEXT NOT NULL,
  bench_run_id TEXT, seed TEXT NOT NULL, fault_state TEXT NOT NULL DEFAULT '{}', events_done TEXT NOT NULL DEFAULT '[]',
  round INTEGER NOT NULL DEFAULT 0, causal_root TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cd_workflows (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, wf_key TEXT NOT NULL, pack TEXT NOT NULL,
  domain TEXT NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL, owner TEXT NOT NULL, plan TEXT NOT NULL, plan_hash TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT '{}', declared_links TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '',
  local_status TEXT, global_status TEXT, declared TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, wf_key));
CREATE TABLE IF NOT EXISTS cd_ops (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, workflow_id TEXT NOT NULL, op_key TEXT NOT NULL,
  kind TEXT NOT NULL, label TEXT NOT NULL, system TEXT NOT NULL, resource TEXT NOT NULL, agent TEXT NOT NULL, spec TEXT NOT NULL,
  status TEXT NOT NULL, idempotency_key TEXT, approval_id TEXT, plan_hash TEXT, basis_ok INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  tool_response TEXT, after_obs TEXT, verifier TEXT NOT NULL DEFAULT '[]', origin TEXT NOT NULL DEFAULT 'plan', last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cd_invariants (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, inv_key TEXT NOT NULL, version INTEGER NOT NULL,
  type TEXT NOT NULL, name TEXT NOT NULL, explanation TEXT NOT NULL, scope TEXT NOT NULL, owner_workflow TEXT, systems TEXT NOT NULL,
  resources TEXT NOT NULL, required_evidence TEXT NOT NULL, preconditions TEXT NOT NULL, spec TEXT NOT NULL, severity TEXT NOT NULL,
  impact TEXT NOT NULL, valid_from TEXT, valid_until TEXT, resolution_policy TEXT NOT NULL, approval_level TEXT NOT NULL,
  strength TEXT NOT NULL, auto_restorable INTEGER NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL, uncertainty TEXT NOT NULL,
  depends_on TEXT NOT NULL, last_result TEXT, last_eval TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, inv_key, version));
CREATE TABLE IF NOT EXISTS cd_findings (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, finding_key TEXT NOT NULL, pattern TEXT NOT NULL,
  title TEXT NOT NULL, workflows TEXT NOT NULL, operations TEXT NOT NULL, domains TEXT NOT NULL, resources TEXT NOT NULL,
  invariant_key TEXT, intended TEXT NOT NULL, declared TEXT NOT NULL, observed TEXT NOT NULL, evidence TEXT NOT NULL,
  predecessors TEXT NOT NULL, severity TEXT NOT NULL, blast_radius TEXT NOT NULL, confidence REAL NOT NULL, uncertainty TEXT NOT NULL,
  explanation TEXT NOT NULL, recommendation TEXT NOT NULL, blocks INTEGER NOT NULL, approval_required TEXT NOT NULL,
  hypothesis INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, round INTEGER NOT NULL, causal_id TEXT, detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, resolved_at TEXT, UNIQUE (campaign_id, finding_key));
-- Cross-Domain Reality Graph: typed nodes and typed edges. Every edge carries provenance and the causal_events id that produced it.
CREATE TABLE IF NOT EXISTS cd_nodes (
  id TEXT NOT NULL, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, type TEXT NOT NULL, ref_id TEXT, label TEXT NOT NULL,
  domain TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, PRIMARY KEY (campaign_id, id));
CREATE TABLE IF NOT EXISTS cd_edges (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, from_node TEXT NOT NULL, to_node TEXT NOT NULL,
  rel TEXT NOT NULL, provenance TEXT NOT NULL, evidence_id TEXT, causal_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (campaign_id, from_node, to_node, rel));
-- ===== Dashboards + Switch Console (session 10). Every row is workspace-scoped. =====
-- Ledger seal: the hash-chain head over the first N audit events at sealing time. Re-verification recomputes the chain.
CREATE TABLE IF NOT EXISTS ledger_seals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, upto INTEGER NOT NULL, head TEXT NOT NULL, sealed_by TEXT NOT NULL, created_at TEXT NOT NULL, last_rowid INTEGER);
-- Switch console: per-workspace on/off switch and the conversation log. 'switch' rows are advisory messages that arrived from a Switch room.
CREATE TABLE IF NOT EXISTS console_state (
  workspace_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'off', detail TEXT NOT NULL DEFAULT '',
  room_external_id TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS console_messages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT, author TEXT NOT NULL CHECK (author IN ('user','ripple','switch')),
  author_name TEXT NOT NULL, body TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_console_msgs ON console_messages(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cd_wf ON cd_workflows(workspace_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_cd_ops ON cd_ops(workspace_id, campaign_id, workflow_id);
CREATE INDEX IF NOT EXISTS idx_cd_find ON cd_findings(workspace_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_cd_edges ON cd_edges(workspace_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_rw_ops ON rw_operations(workspace_id, workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rw_gaps ON rw_gaps(workspace_id, status, detected_at);
CREATE INDEX IF NOT EXISTS idx_bench_cases ON bench_cases(workspace_id, run_id);
CREATE INDEX IF NOT EXISTS idx_lab_eff ON lab_effects(workspace_id, workflow_id, seq);
CREATE INDEX IF NOT EXISTS idx_wf_tasks_mission ON workflow_tasks(workspace_id, mission_id, analysis_rev, created_at);
CREATE INDEX IF NOT EXISTS idx_causal_mission ON causal_events(workspace_id, mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_mission ON audit_events(workspace_id, mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msgs_mission ON messages(workspace_id, mission_id, created_at);
-- Session 19: Squat Watch state (one row per invented package name per room; workspace-scoped).
CREATE TABLE IF NOT EXISTS pkg_watch (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room TEXT NOT NULL, ecosystem TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL, observed_version TEXT, checked_at TEXT NOT NULL, registered_seen_at TEXT, last_mission_id TEXT,
  UNIQUE (workspace_id, room, ecosystem, name));
-- Session 21 (flagship, Switch-native case operations). Every table is workspace-scoped.
CREATE TABLE IF NOT EXISTS switch_people (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, switch_name TEXT NOT NULL, chat_username TEXT,
  sender_id TEXT NOT NULL, source TEXT NOT NULL, pinned_by TEXT, pinned_at TEXT NOT NULL,
  UNIQUE (workspace_id, sender_id));
CREATE TABLE IF NOT EXISTS switch_observed_senders (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT, room_id TEXT, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
  roster_type TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, sender_id));
CREATE TABLE IF NOT EXISTS switch_decisions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, approval_id TEXT, message_id TEXT NOT NULL,
  room_id TEXT, room_external_id TEXT, room_key TEXT, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, sender_kind TEXT,
  on_behalf_of TEXT, received_by TEXT, verb TEXT NOT NULL, case_ref TEXT NOT NULL, approval_ref TEXT NOT NULL, quoted_hash TEXT,
  outcome TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', user_id TEXT, body_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, message_id));
CREATE TABLE IF NOT EXISTS room_documents (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, room_id TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, author_role TEXT, external_doc_id TEXT,
  read_back_hash TEXT, mode TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  from_role TEXT NOT NULL, to_role TEXT NOT NULL, from_room TEXT, to_room TEXT, digest TEXT NOT NULL, summary TEXT NOT NULL,
  message_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pack_id TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
  fact TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, confidence REAL NOT NULL, owner_role TEXT,
  source_mission_id TEXT NOT NULL, source_ref TEXT NOT NULL, policy_version TEXT, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS case_receipts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, kind TEXT NOT NULL, analysis_rev INTEGER NOT NULL,
  result TEXT NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, merkle_root TEXT NOT NULL, issued_by TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS impact_routes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id TEXT NOT NULL, analysis_rev INTEGER NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL);
`;
