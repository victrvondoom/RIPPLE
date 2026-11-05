# Feature Preservation Inventory & Invariant Catalog

This document guarantees that **every existing capability, pack, route, page, and invariant in RIPPLE/RESOLVE is cataloged, maintained, and verified without regression**. No existing code, workflow pack, or test is deleted, broken, or disabled.

---

## 1. Existing Workflow Packs (8 Packs - 100% Preserved)

| Pack ID | Pack Name | Domain | Primary Roles | Verified Deliverable & Guardrail |
|---|---|---|---|---|
| `beo-rescue` | BEO Rescue | Hospitality & Event Catering | Coordinator, Chef, Floor Manager, Staffing Coordinator | Re-computes portions, allergen flags, staffing ratios. Verifies independent effect readback; never claims safety certification. |
| `sceneshift` | SceneShift | Film Production & Call Sheets | Script Supervisor, AD, Continuity Director, DP | Shot scene invalidation, continuity chains, department task assignment with call-sheet revision tracking. |
| `scopeguard` | ScopeGuard | Client Services & Software Agency | Account Manager, Tech Lead, PM, Finance Lead | Classifies requests against scope, allowances, and rate card. Invariant: Change orders mark items "TO BE CONFIRMED"; client messages never promise price or deadlines. |
| `invoiceguard` | InvoiceGuard | AP & Financial Invoicing | Billing Clerk, AP Auditor, Finance Controller | Reconciles line items, catches FX/variance anomalies. Invariant: Neutral wording, zero unauthorized payments, reviewer sign-off required. |
| `shiftrelay` | ShiftRelay | Healthcare & Shift Handoffs | Outgoing Nurse, Incoming Nurse, Charge Nurse | Evaluates handover discrepancies, urgency scoring, callback management. Invariant: Every unresolved item explicitly assigned. |
| `movemate` | MoveMate | Tenancy & Property Management | Tenant Advocate, Property Manager, Legal Liaison | Assesses move deadlines, lease obligations, dispute notices. Invariant: No unauthorized legal claims; disclaimers enforced. |
| `podflow` | PodFlow | Media Production & Podcasting | Audio Editor, Video Clipper, Show Host, Producer | Scores candidate clips, verifies transcript alignments. Invariant: Content flags travel with kit; no fake media processing claims. |
| `submitready` | SubmitReady | Regulatory & Compliance Filings | Compliance Officer, Lead Auditor, Submitting Agent | Requirement evaluation with evidence linking. Invariant: No requirement marked satisfied without immutable evidence. |

---

## 2. Existing Frontend Views & Pages (100% Preserved & Enhanced)

| Route / View | Component File | Description & Capabilities |
|---|---|---|
| `/studio` | `src/web/pages/WorkflowStudio.tsx` | Radial Multi-Agent Canvas with draggable agent avatars, animated data pulse wires, chained progression cards, human-in-the-loop approval callouts, live inspector panel, board view, and 3D infrastructure map. |
| `/graph` | `src/web/pages/WorkGraphPage.tsx` | Causal Directed Acyclic Graph (DAG) viewer with node telemetry, one-click scenario loaders, and live dependency inspection. |
| `/approvals` | `src/web/pages/ApprovalsPage.tsx` | Human-in-the-loop review and approval queue with in-place decision modals, question answering, role filters, and audit history. |
| `/people` | `src/web/pages/PeopleAgents.tsx` | Multi-agent team directory, human persona roles, tool permission sandboxes, execution count, and agent run telemetry. |
| `/evidence` | `src/web/pages/EvidencePage.tsx` | Forensic Evidence Ledger with inspector modals, pass/fail status filters, outcome breakdown, and evidence dossier export. |
| `/packs` | `src/web/pages/PacksPage.tsx` | Domain pack catalog with domain filter tabs, sequential agent handoff pipeline previews, and scenario inspectors. |
| `/settings` | `src/web/pages/SettingsPage.tsx` | Live audit trail from `audit_events`, active session security privileges, connector outbox inspector, and tenant configuration. |
| Root Shell | `src/web/App.tsx` | Top-level shell with one-click Demo Login for 6 personas (`maya@`, `luis@`, `priya@`, `dan@`, `sam@`, `vera@`), mission picker, and navigation. |

---

## 3. Existing Server API Routes (100% Preserved)

| HTTP Method | Route | Handler / Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Session authentication with scrypt hashing, rate limiting, and session cookies. |
| `POST` | `/api/auth/logout` | Session revocation. |
| `GET` | `/api/auth/me` | Current user profile, role, and workspace context. |
| `GET` | `/api/packs` | List installed workflow packs with schemas and role mappings. |
| `GET` | `/api/packs/:id` | Pack manifest details and sample scenario. |
| `POST` | `/api/packs/:id/demo` | Create an instant live demo mission with sample baseline and change event. |
| `GET` | `/api/missions` | Workspace missions snapshot. |
| `POST` | `/api/missions` | Create new mission with pack selection and initial baseline. |
| `GET` | `/api/missions/:id` | Full mission read-model snapshot (`buildSnapshot`). |
| `POST` | `/api/missions/:id/change` | Record change event and trigger impact analysis. |
| `POST` | `/api/missions/:id/answers` | Submit human answers to blocking questions. |
| `POST` | `/api/missions/:id/approvals/:aid` | Grant or reject approval with role authorization. |
| `POST` | `/api/missions/:id/actions/:aid/execute` | Execute action through idempotent connectors. |
| `POST` | `/api/missions/:id/actions/:aid/verify` | Independently read back action effects and record evidence. |
| `POST` | `/api/missions/:id/complete` | Complete mission via `evaluateCompletion()`. |
| `POST` | `/api/missions/:id/work-items/:wid/status` | Update work item status with dependency check. |
| `GET` | `/api/workspace/audit` | Live workspace audit log feed. |
| `GET` | `/api/workspace/agent-telemetry` | Multi-agent execution counts, latencies, and tool usage metrics. |

---

## 4. Existing Database Tables & Schema Invariants (100% Preserved)

All tables strictly enforce tenant scoping via `workspace_id`:
- `workspaces`
- `users`
- `sessions`
- `missions`
- `artifacts`
- `baselines`
- `change_events`
- `graph_nodes`
- `dependencies`
- `work_items`
- `agent_roles`
- `agent_runs`
- `rooms`
- `messages`
- `questions`
- `approvals`
- `actions`
- `evidence`
- `outcomes`
- `connectors`
- `audit_events`

---

## 5. Architectural Invariants (Non-Negotiable)

1. **State Machine Invariant:** All mission state transitions occur strictly through `Engine.transition()`, validated against allowed transitions in `engine/states.ts` and logged to `audit_events`.
2. **Independently Observed Evidence:** An action is NEVER marked `verified` based on an agent's self-reported claim. `Engine.verifyAction()` independently queries connector `observe()` to read back byte-exact state.
3. **Human Authority Gate:** Consequential actions (re-allocations, disputes, client notifications, legal letters, rollbacks, schema migrations) strictly require explicit human approvals by authorized roles.
4. **Tenant Query Discipline:** Every database query includes `WHERE workspace_id = ?`. Cross-tenant data leaks are impossible.
5. **Idempotency Keys:** Every action generates a SHA-256 idempotency key `sha256(ws | mission | effectKey | payloadHash)` preventing duplicate side effects.
6. **No Regressions:** Existing tests in `tests/*.test.ts` must pass without modification.

