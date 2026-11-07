# Inheritance ledger: what RIPPLE took from five hackathon projects

Authoritative and current as of session 3, plus the session-4 moa frontend entry below. Sources were read in full from the folders added to this repo
(`Incident-Sentinel-main`, `CrewPilot-main`, `SchemaCourt-main`, `clearsend-room-main`, `offerroom-main`, all MIT) and, for the frontend,
from `~/Downloads/vultr/moa-main` (moa, Cal Hacks; source: https://github.com/petersenmatthew/moa).
"Verified" below means covered by a test or e2e run listed in [END_TO_END_VERIFICATION.md](END_TO_END_VERIFICATION.md).

## Session 17: nine ideas (OpsRoom, Kite, Hermit, Shipyard, Gatekeeper, Rupiverse)
| Source | Taken into RIPPLE | Where |
|---|---|---|
| OpsRoom | Read-only role cannot propose actions | `engine/orchestrator.ts`, `packs/sentinel/pack.ts` |
| Kite | Two-sided must-block / must-allow verification, fail-closed; interim-then-permanent with `blockedUntil` | `capabilities/verify/twosided.ts`, `packs/sentinel/pack.ts` |
| Hermit | Quiet-hours window on actions (off by default) | `engine/quiet.ts`, `engine/engine.ts` |
| Shipyard | Approval expiry with sweep; deploy gate that blocks only new critical CVEs (supplied evidence, no scan) | `engine/engine.ts`, `packs/depgate/pack.ts` |
| Gatekeeper | Repeat suppression; placeholder-aware secrets; clean copy; agent-instruction file classifier; more dangerous commands | `engine/repeat.ts`, `packs/untrusted.ts` |
| Rupiverse | Cached value reconciled with its recomputed value, gap shown, never overwritten | `capabilities/reconcile/derived.ts`, `api/dashboards.ts` (seal check) |
| Not taken | Rupiverse's merchant autocomplete, search highlight, tree-aware filter and flow-type constraint (not built this round); Hermit's presence and bedtime detection (device signals); Kite's scanners, web discovery and GitHub PR automation (they call external systems, which the dry-run rule forbids). | see discovery notes |

## Session 16: four reference folders (`switch-notary-main`, `gatekeeper-master`, `shipyard-main`, plus the survey of the rest)
| Source | Taken into RIPPLE | Where | Not taken (and why) |
|---|---|---|---|
| Gatekeeper (`agent_guard.py`) | Hidden text in Unicode Tag characters decoded to ASCII; bidi overrides; zero-width runs; secrets pasted into rooms; destructive commands. All flags for humans, never clearances. | `packs/untrusted.ts`, `engine.ts` (inbound Switch flag) | Live package-registry polling (`squat_watch.py`): network access breaks the local dry-run rule. |
| Shipyard (`policy.py`) | Second-person approval: the submitter may not decide the approval. | `engine/types.ts` (`separateFromRequester`), `engine.ts` `decideApproval`, billing refund and credit | SBOM/CVE gate and read-only shell allowlist: no scanner or shell is run by RIPPLE. |
| switch-notary (`ledger.rs`, `notary-verify`) | Signed, portable receipt over the audit chain head; offline-style verification with the trusted key supplied out of band. | `api/receipt.ts`, `app.ts` routes | Rust judge and claim-vs-evidence verdicts (`unverified` vs `contradicted`): would need a claims contract for packs; recorded as future work. |
| Already present (survey was wrong) | Hash chain over the audit log and ledger seals. | `api/dashboards.ts` | nothing new |
| Surveyed, not built | UNSEEN digest-bound approvals and supersede lineage; kite two-sided verification and interim/permanent pairs; hermit role lease; data-room numeric grounding gate; showrunner canon invariants; BizOwl briefdesk; BangSayur commerce; Release Desk; bug-to-pr reproduction evidence. | see `progress.md` Session 16 | Recorded with target files and sizes; none claimed as integrated. |

## Two generic engine additions (all packs can use them)
| Addition | Why | Where |
|---|---|---|
| `ActionSpec.approver {role \| email}`: only that person may decide the approval; unresolved => nobody can (fail-closed) | The competitors' signature rules are *who*-specific: "only the requester approves" (CrewPilot), "recipient can never approve their own release" (ClearSend), "only the candidate decides" (OfferRoom). RIPPLE only had manager/owner *level*. | `engine/types.ts`, `engine.ts` (`resolveApprover`, `decideApproval`), `approvals.approver_*` columns + migration, badge in Approvals page |
| `QuestionSpec.assigneeOnly`: managers cannot answer someone else's question | A required human review must not be answerable by the candidate. | `questions.assignee_only` + migration |

Gotcha found while building: `seed.ts` maps people by role **key across all packs**. Role keys must be globally unique (OfferRoom's first `human_reviewer` resolved to InvoiceGuard's reviewer, now `resume_reviewer`).

## Per project

### moa → web frontend (session 4)
Source: `moa-main` (Next.js 16 + Tailwind/shadcn, "mixture of accountant agents", Cal Hacks). Earlier sessions had already taken moa's *patterns* by reference (first-run "tiny team" onboarding, Studio home panel, pixel avatars, the radial studio canvas). Session 4 ported the one piece that was missing: the **front door**.
Inherited (ported to RIPPLE's Vite/React + plain-CSS stack): the pixel-meadow landing scene (dithered sky bands, drifting clouds, crossing birds, stepped ridges, trees, wheat — seeded, deterministic), and the **roaming crew**: seven pixel avatars wander the meadow, say short decorative greetings, and can be picked up, dragged (squirm + lean physics) and dropped (gravity + squash landing). All `px*`/`pxl*` keyframes were ported with `prefers-reduced-motion` honoured. `src/web/components/MeadowScene.tsx`, `Landing.tsx`, styles at the end of `styles.css`.
Adapted, not copied: moa's crew (`agent.compute`, `agent.finance`…) became RIPPLE avatars (crown/detective/chef/wizard/piggy/scholar/engineer); the wordmark/tagline/footer are RIPPLE's honest copy (deterministic analyzers, dry-run connectors, Switch postponed); the real login form renders unchanged over the scene so all flows/e2e selectors are untouched; a visible credit line links back to moa.
Not inherited: moa's entire in-app UI (Canvas/Board/Audit/contracts/investigations pages, workspace panels, shadcn component library, Tailwind design system, SWR data layer) — RIPPLE's app already renders the equivalent read models from the one engine, and a wholesale re-skin would replace working, engine-backed pages with moa's demo-specific ones; the YouTube demo player and repo links (moa's content); their Next.js app framework itself.
Verified: real-browser check (`docs/evidence/landing-meadow*.png`) — landing renders (wordmark, 1 scene SVG, 7 walkers), login over the meadow succeeds, zero browser console errors. Decorative only: the scene represents no engine state.
### OfferRoom → `packs/offerroom/` (new; was only "planned")
Inherited (ported to TypeScript): 137-skill-style taxonomy + aliases + implied skills; explainable fit score (45/10/15/20/10 weights, thin-evidence, wrong-field and on-site caps, gap plans); **truth guard** (invented skills, numbers, entries, untraceable bullets); deterministic auto-tailor; resume critique; mock-interview plan and rubric grader (`career.ts`); Mentor sign-off labelled advice-only; optional/required human review; never submits applications.
Stricter here: truth guard is re-run by the verifier on the stored document (tamper test fails verification); candidate-only approval (named approver, even the owner is refused); required review is an assignee-only blocking question bound to the exact resume fingerprint; weak fit needs the candidate's explicit "yes".
Not inherited: MCP server (32 tools), job-board scrapers (Greenhouse/Lever/Ashby/Remotive), PDF/DOCX rendering, resume PDF import, SQLite application tracker/follow-ups/digest, scheduler, five separate Switch agents with ROOM_PROTOCOL. Mock-interview grading is ported and unit-tested but not yet wired to a room/UI.

### Incident-Sentinel → `packs/sentinel/`
Inherited: SLO-breach triage, deploy/commit correlation, blast radius, human approval before rollback, rollback target = previous stable, post-mortem draft.
Stricter: culprit is *computed* (deploy proximity, commit in alert, endpoints touched); ambiguity is a blocking human question; no breach / no correlating deploy => no rollback; only the on-call SRE in the plan approves; **recovery is not claimed until a human records a measured post-rollback error rate within the SLO**.
Deliberately not inherited: their `mcp_sentinel_tools.execute_rollback` returns `"status": "SUCCESS"` when the infrastructure API is unreachable (a fabricated success); the simulator, FastMCP server, terminal demo, Docker files and Switch YAML template. RIPPLE calls no cluster or monitoring system.

### SchemaCourt → `packs/schemacourt/`
Inherited: facts-vs-proposal separation, human approval before model change, **dual-fixture verification**, decision record.
Stricter: the model is actually executed (in-memory SQLite) on legacy and drifted fixtures; the patch is derived by rewriting the SQL, proven on both fixtures before it is proposed, and the verifier re-extracts and re-runs the *stored* patch; model SQL must be one read-only SELECT.
Not inherited: DuckDB/Parquet 100k-row fixtures (RIPPLE uses small fixtures carried in the plan), Streamlit dashboard, videos. Fixtures are samples, not production data.

### ClearSend Room → `packs/clearsend/`
Inherited: escrow lifecycle, "no money moves without a named human yes", deliverables are untrusted data, recipient can't approve own release, 1.2% FX spread + 2.5% fee quote, fail-closed verification (no evidence = criterion not met).
Stricter: a release is proposed only if hash matches, every criterion has recorded evidence, reserve covers it, milestone not already released and approver is not the payee; verifier re-checks all of it on the stored voucher.
Not inherited: PayPal sandbox orders/payouts/refunds, Upstash Redis store, HMAC role links, rate limits, Idempotency-Key HTTP layer, flight search/booking, LLM verifier, Next.js dashboard, CLI. **RIPPLE moves no money.** FX rate is plan-supplied and labelled, never live.

### CrewPilot → `packs/crewpilot/` and `collab/switch.ts`
Inherited: structured triage (category/severity/difficulty/summary/plan), issue text is untrusted data, duplicate rejection, clarification for vague issues, requester-only approval, no code/GitHub writes.
Stricter: triage is deterministic and tested (reporter's suggested severity shown, not trusted); approval bound to the reporter's identity; verifier re-triages.
Switch client behaviours ported into `collab/switch.ts` (**mock-tested only**, see `tests/switch-resilience.test.ts`): reconnect with same connection id + `Last-Event-ID`, server heartbeat interval, `evicted`/`gap` handling, message-id de-duplication, ignore own posts, only real `message` frames.
Not inherited: Python SSE agent, agent registration CLI, LLM triage (OpenAI/Anthropic/Groq), GitHub issue fetching. Their README says a live Discord→Switch→Groq run was verified; **we could not and did not verify that**.

## Still true
Switch integration has never been run against a real Switch server. Connectors are local/dry-run. Heuristics (fit score, triage, correlation) are simple and unvalidated on real data. Fixtures/demo data are synthetic.
