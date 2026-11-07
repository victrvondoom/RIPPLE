# Where each incoming idea lives (session 19)
One engine, one data model: each idea is placed in the domain pack that owns it. "Built" means implemented, tested and run; nothing here claims a live Switch/Mattermost/Telegram run.

| Idea (source) | Domain / pack | Status |
|---|---|---|
| Fixline: report → known-issue dedupe → failing repro → locked test → fix → different-vendor review → lead approval → customer reply | `fixline-bugfix` (Customer Support Engineering, system "commerce") | **Built** |
| Pharmacy recall desk: failed-batch list → stock match → look-alike batch questions → EN/HI draft notices → QA Head stop-sale → shelf checks | `recall-desk` (Pharmacy Compliance, system "commerce") | **Built** |
| Flipside: sealed agent session, one disclosed step, proof / PROOF_FAIL | `flipside-review` (system "engineering") | Built (session 18) |
| CrewPilot triage/repro/review, ClearSend escrow, Deploy gate (SBOM/CVE) | `crewpilot`, `clearsend`, `deploy-gate` | Already existed |
| Dual-control ChatOps (rollback, flag, replay, secret rotation; recorded second person, NIST CM-3(1)/AC-5) | `incident-sentinel`; four-eyes + approver gates already exist in the engine | Not built: needs ChatOps action types in sentinel |
| Shipyard: tickets from a sentence/events/PRs, briefings, incidents with follow-ups, repeats join the open ticket | `incident-sentinel` (+ commitments capability) | Not built |
| Room: root cause from past incidents (BM25/embedding retrieval, cite evidence ids, RAG vs no-RAG label) | `incident-sentinel` using `capabilities/reclaim/knowledge.ts` | Not built (no incident corpus bundled) |
| Relayed-agent injection (a buried "refund $999" in a message relayed by another agent) | `packs/untrusted.ts` + billing pack | Not built (existing scan covers hidden text, secrets, agent-directed phrases only) |
| Vaaradhi: evidence agent, breaker agent from another vendor, shipper that obeys only `ship PR-n` and refuses on BROKEN/UNSURE | would be a release pack beside `deploy-gate` | Not built |

## Limits of what was built
- Fixline and recall desk run no tests, read no photos, merge nothing and contact no store; repro/test/review results and shelf reads are evidence supplied in the change. Merge and stop-sale records are dry-run entries.
- Fixline's "different vendor" rule compares vendor strings supplied by the agents; RIPPLE cannot prove which model wrote or reviewed a change.
- The recall look-alike rule folds O/0, I/L/1, S/5, B/8, Z/2, G/6 only. It flags; a person decides.
- Hindi text is a short draft for pharmacist review, not a vetted translation.
- Sample data is synthetic. Not exercised on real Switch, Mattermost or Telegram.
