# RIPPLE — one change, every consequence

RIPPLE is a centralized workflow & intervention system. When something changes after a plan was approved, RIPPLE diffs it against the approved **baseline**, walks a shared **dependency graph** to find every impacted artifact/department/owner, has role-based **agents** analyze their slice and hand work to the right **humans**, proposes drafts and **actions**, executes only what a human **approves**, **verifies** the result from observable evidence, and completes a mission only when explicit criteria are met.

**Eight workflow packs run on the same engine, in one workspace** (all implemented, each with tests and a real-browser journey):

| Pack | Domain | The change/request it analyses |
|---|---|---|
| BEO Rescue (flagship) | Event Operations | client changes guests / menu needs / service time |
| SceneShift | Creative Production | script revision after scenes were shot |
| ScopeGuard | Agency Operations | client request vs approved scope → change order (no price/date promises) |
| InvoiceGuard | Financial Reconciliation | invoice vs quote, milestones, acceptance, worklog evidence (never pays) |
| ShiftRelay | Field Operations | shift handover vs open job board; acknowledged transfer |
| MoveMate | Personal Administration | move-out deadlines, bills, inspection, deposit evidence (no legal conclusions) |
| PodFlow | Creator Production | episode transcript → approved clips, captions, content kit (text only; no media processing) |
| SubmitReady | Education Workflows | rubric ↔ deliverables ↔ verified evidence → readiness |

Switch integration is **postponed**: the app runs in a clearly labelled LOCAL collaboration mode; the adapter has only been tested against a mock.

**Hackathon status (Flip the Switch):** see [docs/HACKATHON_COMPLIANCE.md](docs/HACKATHON_COMPLIANCE.md) for an honest requirement-by-requirement checklist. A draft, untested Switch Console room template is in `switch/ripple-room.template.yaml`.

## Quick start
```bash
npm install
npm run start        # http://localhost:8787
```
Sign in as `maya@harborvine.example` / `ripple-demo` (manager). Workflow Packs → *Demo + analyse* creates a labelled demo mission for any pack. Follow `docs/DEMO.md`.

## What is real vs. not (read this)
| Area | Status |
|---|---|
| Mission engine, state machine, baselines, versioned changes, impact graph, approvals, idempotent actions, stale detection, recovery, evidence, completion gate | Real, persisted in SQLite, covered by tests |
| Role "agents" | **Rule-based analyzers** (deterministic) exchanging real persisted handoffs. Not LLMs. Model use is optional and limited to wording of the client email (`ANTHROPIC_API_KEY`); that path is only guard-tested with a mocked fetch. |
| Switch | **Postponed.** Adapter implemented from the official protocol docs; **never run against a real Switch server**. Default is a clearly labelled **LOCAL mode**. See `docs/SWITCH.md`. |
| Connectors | Local file outbox / dry-run. **Nothing is actually emailed, posted, paid, uploaded or submitted.** Verification reads the file back. |
| Security | Auth, role checks, workspace scoping, validation, CSRF checks, audit, export/delete are implemented and tested; this is **not** a production-hardened system. |

## Layout
`src/server` (engine, packs, collab, connectors, api, db) · `src/web` (React) · `tests` · `docs` · `scripts`. See `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/SWITCH.md`, `progress.md`.

## Evidence
`docs/evidence/` (BEO/SceneShift run + `test-output.txt`) and `docs/evidence/packs/` (one log + screenshots per pack journey, and the cross-domain journey).
