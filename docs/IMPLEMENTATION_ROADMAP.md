# Implementation Roadmap: RESOLVE Multi-Agent Operations Studio

This roadmap details the engineering execution plan for expanding RIPPLE/RESOLVE into the centralized, multi-domain, causal operations platform.

---

## Phase 1: Baseline Preservation & Architecture Integrity (COMPLETED)
- [x] Unify directory structure directly under `SWITCH/` (eliminated nested directory redundancies).
- [x] Verify 100% test pass rate across all 13 test files (89 tests).
- [x] Document existing features and invariants in `docs/FEATURE_PRESERVATION_INVENTORY.md`.
- [x] Analyze competitor architectures and gap analysis in `docs/COMPETITIVE_GAP_ANALYSIS.md`.

---

## Phase 2: Causal State Ledger & Graph Infrastructure
- [ ] **Database Schema Extension (`src/server/db/schema.ts`):**
  - Add `causal_events` table tracking `id`, `workspace_id`, `mission_id`, `parent_event_id`, `cause_type`, `observed_state`, `confidence`, `idempotency_key`, `created_at`.
  - Add explicit lifecycle state enum tracking: `PLANNED`, `AUTHORIZED`, `EXECUTING`, `EXECUTION_UNKNOWN`, `OBSERVED`, `VERIFICATION_PENDING`, `VERIFIED`, `FAILED`, `RECOVERING`, `RECOVERED`, `REQUIRES_HUMAN`.
- [ ] **Causal Service (`src/server/engine/causal.ts`):**
  - Record causal nodes whenever an anomaly is detected, approval requested, rollback executed, or probe verified.
  - Implement ancestor/descendant graph traversal for root-cause provenance.
  - Expose causal graph query endpoints via `/api/missions/:id/causal-graph`.

---

## Phase 3: Pack Integration (Incident-Sentinel, SchemaCourt, CrewPilot, ClearSend, OfferRoom)
- [ ] **Incident Sentinel Pack (`src/server/packs/sentinel/index.ts`):**
  - Anomaly detection (HTTP 500 spike, p99 latency surge).
  - Git commit correlation (v2.14.0 culprit isolation).
  - Blast radius & human rollback authorization gate (`sre_lead`).
  - Dual-probe verification (error rate drop back to baseline).
  - Incident post-mortem generator (`INC-8924.md`).
- [ ] **Schema Court Pack (`src/server/packs/schemacourt/index.ts`):**
  - Data contract drift detector (dropped `discount_cents` column).
  - Dual-fixture SQL runner calculating revenue variance.
  - `COALESCE` patch proposal with `@maya_data` authorization gate.
  - Verification: 0 revenue variance across legacy & drifted fixtures.
- [ ] **ClearSend Financial Guard Pack (`src/server/packs/clearsend/index.ts`):**
  - 3-party escrow lifecycle (create → fund → submit → verify → release).
  - Milestone verification with SHA-256 evidence hashing.
  - Dual human approval gate (Client + Escrow Auditor).
  - Idempotent funds release with read-back verification.
- [ ] **CrewPilot PR & Issue Triage Pack (`src/server/packs/crewpilot/index.ts`):**
  - Issue classification & structured fix plan generator.
  - Codebase blast radius calculation.
  - Requester-only approval gate.
- [ ] **Career Sentinel / OfferRoom Pack (`src/server/packs/offerroom/index.ts`):**
  - Candidate profile ingestion & role matching.
  - Truth-guard verification preventing unverified resume claims.
- [ ] **Registry & Seed Integration:**
  - Register all new packs in `src/server/packs/registry.ts`.
  - Add seed personas (`maya_data@`, `sre_lead@`, `escrow_auditor@`) and demo missions in `src/server/db/seed.ts`.

---

## Phase 4: Workflow Studio & Multi-Agent UI Experience
- [ ] **Radial Orbit Canvas:** Draggable specialist agents, central "You" node with live status, glowing SVG data pulse wires, chained progression cards, approval callout bubbles.
- [ ] **Flow Graph Canvas (Playground Mode):** Multi-agent node graph inspired by the 5th reference image with configurable models, prompts, temperature, inputs/outputs, and interconnecting cables.
- [ ] **Causal Graph & Timeline Explorer:** Visual representation of causal event chains (`Anomaly → Root Cause → Human Approval → Rollback → Verified Normalcy`).
- [ ] **Live Interactive Inspector:** Deep inspection of agent connections, tools, prompt guidance, live tasks, outputs, and telemetry.

---

## Phase 5: Verification, Test Coverage & Final Documentation
- [ ] Add unit & integration tests for all new packs in `tests/sentinel.test.ts`, `tests/schemacourt.test.ts`, `tests/clearsend.test.ts`, `tests/crewpilot.test.ts`.
- [ ] Run complete test suite (`npm test`) and typecheck (`npm run typecheck`).
- [ ] Author remaining Hackathon deliverables:
  - `docs/IMPLEMENTATION_REPORT.md`
  - `docs/END_TO_END_VERIFICATION.md`
  - `docs/COMPETITIVE_POSITIONING.md`
  - `docs/DEMO_RUNBOOK.md`
- [ ] Rebuild production bundle and verify running server at `http://localhost:8787`.

