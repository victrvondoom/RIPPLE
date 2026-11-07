# RECLAIM + RESOLVE + REDEEM → RIPPLE: integration report (session 13, 2026-11-06)

This one file covers the audit and final deliverables listed in the integration brief: repository inventory, feature extraction map, duplicate systems, dependency compatibility, unified architecture, sequence, blockers and risks, feature preservation, test evidence and unfinished work. Every status below comes from code or from a command that was actually run.

## 1. Repository inventory (read from code, not READMEs)

| | RIPPLE (target) | RECLAIM | RESOLVE | REDEEM |
|---|---|---|---|---|
| Location | `Downloads/SWITCH` | `Downloads/current going on hackathons work/OPEN AGENT HACKATHON/Open-Agent/reclaim` (git: victrvondoom/Open-Agent) | `Downloads/RESEOLVE` (victrvondoom/Resolve) | `Downloads/redeem` (victrvondoom/Redeem) |
| Language | TypeScript (64 .ts, 33 .tsx) | Python 247 .py + Next.js frontend | Python 183 .py + static JS | Python 151 .py + Next.js (`apps/web`) |
| Backend | Hono, `node:sqlite` | FastAPI, LangGraph, Gemini | stdlib HTTP + SQLite (`src/inbox_store.py`) | FastAPI, SQLAlchemy, Alembic (`apps/api/app`) |
| Persistence | SQLite, workspace-scoped | Supabase, Qdrant, Neo4j, Redis (`backend/requirements.txt`) | SQLite + Maildir | SQLite / Postgres (`config.py`) |
| Orchestrator | `engine/engine.ts`, `engine/orchestrator.ts` | `agents/orchestrator/*.py` (LangGraph supervisor) | `src/supervisor.py`, `brief_mission.py` | `orchestration/engine.py` (1,046 lines) + `taskgraph.py` |
| Approvals / verification | content-hash approvals, `verifyAction` read-back | Review Agent (LLM) | `send_broker.py` digest-bound approvals + read-back | digest approvals, `verify_action`, reconcile |
| Tests (count of test files) | 29 vitest files | 13 | 92 | many (pytest + Playwright) |

Not used: `Downloads/vultr/resolve` (a different "financial operations control plane" product) and `RESOLVE-AI-main`. REDEEM already contained partial ports of RECLAIM (`apps/api/app/reclaim/`) and RESOLVE (`apps/api/app/resolve/`). The RECLAIM port was taken from there because REDEEM made it deterministic (BM25, no Gemini).

## 2. Feature extraction map

| Feature | Source file | Decision | Now in RIPPLE | Status |
|---|---|---|---|---|
| Commitment extraction, deadline resolution, ownership | RESOLVE `src/inbox_intel.py` | ADAPT (port) | `src/server/capabilities/resolve/commitments.ts` | **VERIFIED** (unit + mission tests) |
| Exact-content send broker (digest approval, idempotent key, read-back, never resend) | RESOLVE `src/send_broker.py` | REUSE RIPPLE's equivalent | engine content-hash approvals, `effectKey` idempotency, `observe()` read-back, EXECUTION_UNKNOWN; recipient/subject checks in the pack's `verifyAction` | **VERIFIED** (tamper test fails verification) |
| Gmail / SMTP / Maildir connectors | RESOLVE `gmail_adapter.py`, `local_mail.py` | FUTURE | none (RIPPLE uses dry-run `.eml` outbox) | NOT IMPLEMENTED |
| BM25 regulatory retrieval with provenance and authority tiers | REDEEM `reclaim/kb.py` (from RECLAIM `services/evidence_scoring.py`) | ADAPT (port) | `capabilities/reclaim/knowledge.ts` + `corpus.json` (28 airline/banking rows) | **VERIFIED** |
| Deterministic citation verification | RECLAIM `services/citation_verification.py` | ADAPT (port) | `verifyClaim`, `checkCitations` | **VERIFIED** (forged citation rejected) |
| Gemini specialist agents (airline, banking, …) | RECLAIM `agents/domain_agents/*` | DO NOT INTEGRATE (LLM prompt wrappers; no key; nondeterministic) | — | NOT IMPLEMENTED |
| Telecom / e-commerce / health corpora | RECLAIM `knowledge/` | FUTURE | — | NOT IMPLEMENTED |
| Intake safety (OTP / payment / clinical refusals, scam clarify) | REDEEM `policy/safety.py` | ADAPT (port) | `capabilities/redeem/intake.ts` `evaluateIntent` | **VERIFIED** |
| Scam indicators | REDEEM `policy/payment_safety.py` | ADAPT (port) | `scanForScam` | **VERIFIED** |
| Confirmed memory (facts proposed until the consumer confirms) | REDEEM `memory/extract.py`, `memory/service.py` | ADAPT (subset: refund mode, contact method) | `mapAnswer` + assignee-only question | **VERIFIED** |
| Encrypted memory vault | REDEEM `security/vault.py` | FUTURE | — | NOT IMPLEMENTED |
| Voice (Bolna) | REDEEM `voice/` | FUTURE (credential-blocked in REDEEM too) | — | NOT IMPLEMENTED |
| Prompt-injection detection | all four | single implementation | RIPPLE `packs/untrusted.ts` + RESOLVE `INJECTION_RE` | **VERIFIED** |

## 3. Duplicate systems, and the one kept

| System | Duplicates found | Kept |
|---|---|---|
| Mission orchestrator / state machine | RECLAIM LangGraph supervisor, RESOLVE `supervisor.py`, REDEEM `orchestration/engine.py` | **RIPPLE `Engine` only.** The ported modules are pure functions with no state, no loop and no I/O. |
| Approvals | RESOLVE `send_broker`, REDEEM digest approvals | RIPPLE approvals (bound to change/analysis version and content hash; `ActionSpec.approver` = the consumer) |
| Verification / recovery | RESOLVE read-back, REDEEM `verify_action` + reconcile | RIPPLE `verifyAction` + EXECUTION_UNKNOWN recovery. The domain checks come from the pack. |
| Auth / tenancy | three different implementations | RIPPLE sessions + `workspace_id` on every row |
| Injection filter | four regex sets | RIPPLE `untrusted.ts` (RESOLVE regex added for mailbox exfiltration) |
| UI | three Next.js / static apps | RIPPLE React UI. The pack appears through the existing generic pages; no new dashboard. |

## 4. Dependency compatibility

The sources are Python and RIPPLE is TypeScript. That rules out "reuse as-is", and a Python sidecar would have meant running a second engine, which the owner ruled out ("one centralised system"). So the deterministic logic was **ported** and the Python originals serve as the specification. No new npm dependency was added. RECLAIM's Supabase, Qdrant, Neo4j, Redis and Gemini were not brought over.

## 5. Unified architecture (as built)

```
Consumer report ──► RIPPLE Engine (one mission, one state machine, one ledger)
                     │ roleOrder: cr_intake → cr_commitments → cr_rights → cr_drafting
                     ├─ cr_intake       uses capabilities/redeem   (safety, proposed facts, confirmed refund mode)
                     ├─ cr_commitments  uses capabilities/resolve  (who promised what, by when, exact sentence)
                     ├─ cr_rights       uses capabilities/reclaim  (retrieval + provenance + citation grounding + evidence gaps)
                     └─ cr_drafting     airline follow-up + bank dispute + case file + consumer update
                     ▼
     approvals bound to the consumer (Asha) ─► email_outbox / document_store (dry-run) ─► verifyAction read-back
                     ▼
     completion only via evaluateCompletion; outcome stays "awaiting organisation response" until the consumer confirms a refund
Switch: one room per mission (switch-core 0.31.0); RIPPLE posts handoffs to ripple-intake/-commitments/-rights/-drafting, findings, approval requests, decisions, verification results.
```

Cross-organisation link: the airline's written refund promise (RESOLVE) counts as merchant-correspondence evidence for the bank dispute (RECLAIM evidence coverage) and is quoted word for word in both letters.

## 6. Test evidence (real output, this session)

- `npx tsc --noEmit` → clean. `npx eslint src tests scripts` → clean.
- `npx vitest run` → **29 files, 240 tests passed** (225 before + 15 in `tests/consumer.test.ts`). `tests/dashboards.test.ts` now expects 37 catalogued projects instead of 34, because RECLAIM, RESOLVE and REDEEM were added.
- `npx tsx scripts/switch-live.ts` (real Switch) → 9/9 PASS. Evidence: `docs/evidence/switch-live-2026-11-06.json`.
- `node scripts/e2e-consumer-switch.mjs` (real RIPPLE server + real Switch) → **E2E PASSED**, 16 checks. 403 when Maya tries to answer or approve for the consumer; three actions verified; mission completed; the Switch room held 49 messages including `handoff` 8, `finding` 8, `approval_request` 3, `decision` 3 and `status` 5, addressed to all four role agents. Evidence: `docs/evidence/e2e-consumer-switch-2026-11-06.json`.
- Not run this session: the existing Playwright e2e scripts (`scripts/e2e*.mjs`), the source repos' own test suites, and browser screenshots of the new pack.

## 7. Feature preservation

No page, route, API, pack or nav destination was removed. Every existing test still passes unmodified, except the catalog count in `tests/dashboards.test.ts` (34 → 37). The Switch adapter change is opt-in (`SWITCH_INTERNAL_ONLY`), and the mock tests are unchanged and pass.

## 8. Blockers, risks, unfinished work

1. **Mattermost bridge not running** (Docker Desktop is off), so rooms are agent-only and humans act in the RIPPLE UI, not in chat. Next step: start Docker and Mattermost from Switch Console, unset `SWITCH_INTERNAL_ONLY`, re-run both scripts.
2. **Role agents do not reason inside Switch.** They are registered Switch identities, and handoffs are addressed to them. The analysis runs in RIPPLE's deterministic analyzers. The live check shows a second agent can post with its own key and RIPPLE receives it, but no always-on role-agent process exists yet.
3. Approving in the chat room: messages from Switch are advisory by design (AGENTS.md console rules). Approval inside chat would need Mattermost-user to RIPPLE-user identity mapping plus confirmation, and that is not built.
4. Connectors are dry-run. Nothing was emailed to an airline or bank, and no provider response or refund is real.
5. The corpus is 28 authored-guide passages (airlines + banking only), not official regulator text. Citations are flagged for human review.
6. The ported deadline parser uses a fixed UTC offset (the original supports IANA zones). "Within N working days" is counted as N calendar days.
7. Not ported: Gmail OAuth, REDEEM voice (Bolna), OCR, encrypted vault, and RECLAIM's LLM agents and other domains.
