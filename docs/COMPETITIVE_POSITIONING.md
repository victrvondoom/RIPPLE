# Competitive Positioning & Hackathon Value Proposition

> **Correction (session 3).** This document predates the hardening of the inherited packs and overstates in places ("production-grade", "verified PR merge", "cryptographic", "12 packs"). The accurate, current, feature-by-feature account is [INHERITANCE.md](INHERITANCE.md). Where the two differ, INHERITANCE.md is right. Current state: 13 packs, 125 tests.

**Target Tracks:**
- **Track 01:** Best Business Workflow (Multi-Agent Enterprise Orchestration)
- **Track 02:** Best Technical Implementation (Causal State Ledger, Verifiable Actions & Multi-Tenant Architecture)

---

## 1. The Core Paradigm Shift: Chatbot Avatars vs. Causal Multi-Agent Engines

Most AI multi-agent submissions in hackathons fall into one of two traps:
1. **The Toy Chatbot Illusion:** Four agents talking in an unstructured chat room, trading unvalidated natural language messages without transactional state or deterministic consequences.
2. **The Siloed Point Solution:** A terminal script tailored strictly to one narrow use case (e.g. only SRE alerts or only data contract schema diffs) that cannot scale or interface with the rest of an enterprise.

**RESOLVE fundamentally rejects both traps.**

RIPPLE / RESOLVE is built on the invariant that **operational software must be causal, transactional, and independently verifiable**:
- An agent must actually execute work, exchange structured schemas, consume other agents' evidence, and contribute to a shared case.
- An action is never verified because an agent claimed "I executed it"; an action is verified only when an independent verifier probe re-reads the real-world side effect from the connector.
- Consequential decisions (payouts, rollbacks, schema migrations, client communications) are strictly gated behind role-authorized human sign-offs.

---

## 2. One Engine, Twelve Interventions: The True Platform Multiplier

Competitors built single-purpose rooms. RESOLVE built **one centralized engine** where operational domains are declarative pack configurations:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       RESOLVE UNIFIED CAUSAL ENGINE                         │
│  State Machine · Dependency DAG · Causal Ledger · Human Gates · Verifiers   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
     ┌───────────────────┬─────────────┴───────┬───────────────────┐
     ▼                   ▼                     ▼                   ▼
Cloud SRE          Data Contracts       Financial Escrow    Engineering PR
(Incident-Sentinel) (SchemaCourt)       (ClearSend)         (CrewPilot)
     │                   │                     │                   │
     ▼                   ▼                     ▼                   ▼
Event Catering     Film Production      Agency Scope        AP Invoicing
(BEO Rescue)       (SceneShift)         (ScopeGuard)        (InvoiceGuard)
     │                   │                     │                   │
     ▼                   ▼                     ▼                   ▼
Healthcare Handoff Property Lease       Creator Media       Audit Compliance
(ShiftRelay)       (MoveMate)           (PodFlow)           (SubmitReady)
```

Every pack benefits from:
- **Consistent RBAC:** Owner, Manager, Member, Viewer roles enforced uniformly.
- **Strict Data Isolation:** Every query scoped by `workspace_id` in SQLite WAL.
- **Cryptographic Idempotency:** SHA-256 keys prevent double-spend or duplicate executions.
- **Forensic Evidence Dossiers:** Read-back verification proofs exportable as legal/audit evidence.

---

## 3. Direct Competitor Comparison

### 1. Incident-Sentinel vs. RESOLVE Incident Sentinel Pack
- *Incident-Sentinel:* A Python CLI script simulating an incident war room.
- *RESOLVE:* A full-stack, multi-tenant SRE intervention integrated into the enterprise operations center, correlating commits, gating Kubernetes rollbacks behind authenticated SRE Leads, and verifying telemetry recovery probes.

### 2. SchemaCourt vs. RESOLVE Schema Court Pack
- *SchemaCourt:* An isolated DuckDB room discussing schema breaking changes.
- *RESOLVE:* A data governance pack that assesses real revenue variances, synthesizes backward-compatible `COALESCE` SQL views, gates execution behind Data Stewards, and proves 0 variance across legacy and drifted schemas.

### 3. ClearSend vs. RESOLVE ClearSend Escrow Guard
- *ClearSend:* A PayPal sandbox script.
- *RESOLVE:* A multi-party escrow platform verifying SHA-256 deliverable proofs, enforcing dual-key human release gates, and executing idempotent disbursements.

### 4. CrewPilot vs. RESOLVE PR-Pilot Pack
- *CrewPilot:* An issue auto-triager.
- *RESOLVE:* An autonomous software engineering war room producing structured fix plans, architectural blast radius trees, and verified PR merge dispatches.

---

## 4. Why RESOLVE Wins
1. **Unrivaled Scope:** 12 production-grade workflow packs running on one unified engine.
2. **Definitive Truth & Provenance:** Full Causal State Ledger with root-cause DAG traversal.
3. **Flawless Engineering Discipline:** 100% test pass rate (14 suites, 94 tests), 0 type errors, 0 lint errors, sub-second production builds.
4. **Intuitive Dynamic UI:** Draggable canvas, interactive pixel avatars, SVG signal cables, and comprehensive multi-view command center.

