# RIPPLE implementation report — sessions 10–11 (2026-11-05)

What was built against the "100× competitive evolution" directive, what was proven, and what was not. Earlier sessions are in `progress.md`.

## 1. Preserved (nothing removed or regressed)
- Every page, route, API, pack, connector and test that existed before is still there. The nav gained entries; none were removed.
- Now: **28 test files / 225 tests, all passing** (`npx vitest run`). `tsc --noEmit` and `eslint src tests scripts` are clean, and `vite build` succeeds.
- Three pages that showed static or synthetic content now run on live data, keeping the same layout and classes: How it works, Case Review, and the Studio home panel.

## 2. New, working capabilities
| Capability | Where | Proven by |
|---|---|---|
| Four dashboards (Mission Control, Operations Workbench, Trust & Evidence, Knowledge & Decisions) on recorded data only | `src/server/api/dashboards.ts`, `src/web/pages/dash/*` | `tests/dashboards.test.ts`, browser |
| Capability catalog: 34 catalogued capabilities → 7 systems, honest integration status | `src/server/capabilities/catalog.ts` | `tests/dashboards.test.ts` |
| Tamper-evident audit ledger: sha256 chain plus seals; editing a sealed row is detected | `dashboards.ts` (`auditChain`, `sealLedger`, `verifySeals`) | test (tampered row → `intact: false`) |
| Portable verification receipts bound to action, payload hash, baseline/change and approver | `GET /api/dash/trust/receipts/:id` | test |
| Separation-of-duties re-check from the ledger | `trust()` | test (0 violations) |
| Decision memory with validity (valid / applied / superseded), contradictions, outdated items, responsibility | `knowledge()` | test |
| **Switch room / console** on every page: talk to RIPPLE, propose → human confirm → Engine method under that user's role | `src/server/console/*`, `src/web/components/SwitchRoom.tsx` | `tests/console.test.ts`, browser |
| Two-tier interpreter: deterministic parser first; optional `claude-opus-5-5` only for unrecognised phrasing, schema-validated, can never confirm | `src/server/console/intents.ts` | test (injected fetch) |
| On/off Switch connection that reports what it observed (`not_configured` / `unreachable` / `connected` / `disconnected`); Switch messages are advisory only | `SwitchConsole.toggle`, `fromSwitch` | test vs mock bridge |
| **Flagship: Revenue Recovery pack** (see §3) | `src/server/packs/revenue/*`, `src/server/connectors/warehouse.ts` | `tests/revenue.test.ts`, browser |

## 3. Flagship workflow: upstream field change → verified recovery
A deploy (`checkout-api 9f2c1ab7`) renames `amount_cents` to `amount_minor`. `revenue_daily` silently under-reports against the independent finance ledger.

1. **Observer** reads the labelled warehouse sandbox. Revenue is under-reported, and the post-deploy rows read NULL.
2. **Deploy Investigator** proposes H1 (field rename). **Pipeline Investigator** disagrees and proposes H2 (ingestion lag) and H3 (units bug).
3. **Memory Keeper** retrieves standing decision DEC-2026-014 ("keep an alias for one release") and flags it as contradicted. It also retrieves precedent INC-2026-071.
4. **Adversarial Reviewer** tests each hypothesis's predictions against the observed data. H1 is confirmed. H2 is refuted (row counts match). H3 is refuted (the values are NULL, not mis-scaled). Evidence decides, not confidence.
5. The **Incident Commander** (a human) chooses `hotfix` or `rollback` in chat. The question key is bound to a fingerprint of the root cause.
6. Each operation (mapping fix, recompute, finance notice, postmortem) is approved on its exact payload by the named commander.
7. **Scripted fault, part of the workflow:** the recompute commits, the response is lost, and the status endpoint is unreadable once. RIPPLE records `EXECUTION_UNKNOWN` (not success, not failure) and repeats nothing. The mission moves to `recovery_required`.
8. **Recovery:** the next execute reads back first, finds the effect and does **not** write again (attempts = 1). It then verifies independently:
   - business invariant: view = ledger;
   - every day reconciles;
   - the view is fresh;
   - exactly one effect.
9. Mission completes through `evaluateCompletion` ("complete mission" in chat). The causal ledger shows `EXECUTION_UNKNOWN → OBSERVED → VERIFIED`.

Reproduced in a real browser (Chrome, fresh DB, port 8794) entirely by typing in the Switch room. The run ended with "Mission completed" and How it works showing "Invariant held: view $1,307.40 vs ledger $1,307.40". No app console errors.

## 4. Genuine vs simulated integrations
- **Genuine, local:** SQLite persistence, auth, tenant scoping, the file-backed connectors (real files written and read back), the warehouse sandbox (real per-mission state file and read-back).
- **Simulated, labelled:** the warehouse is a deterministic sandbox, not a production warehouse. Email is dry-run. The lost-response fault is scripted and labelled in the approved document.
- **Switch:**
  - Not connected in this environment. Switch 0.31.0 is installed and enrolled on this machine, but it is stopped (Docker Desktop is not running; nothing listens on 52041–52043).
  - The adapter and the console's connected mode are tested only against a mock of the documented protocol.
  - The UI says "Switch not configured · local console".
- **Model:** the `claude-opus-5-5` fallback has not been called against the live API (no key configured).

## 5. Demo runbook (flagship)
1. `npm run start`, open http://localhost:8787 and sign in as Maya (Manager).
2. Open the Switch room (button bottom-right, Ctrl+K, or `#/switch`). Type the following, confirming each proposal with `yes`:
   1. `start demo revenue-recovery`
   2. `list questions`
   3. `answer 1: hotfix`
   4. `approve 1 because evidence reviewed`, four times
   5. `execute 1`. Repeat for each action: the recompute reports **Outcome UNKNOWN**, and running it once more shows **Recovered … NOT repeated**.
   6. `complete mission`
3. Show the results:
   - **Case Review:** all criteria met, recompute attempts = 1.
   - **Trust & Evidence:** receipts and the read-back failure record.
   - **Knowledge & Decisions:** the commander's choice.
   - **How it works:** the invariant held.

## 6. Known limitations / not done
1. Real Switch communication is unverified (see §4). To connect:
   - start Switch Console (and Docker Desktop);
   - register a RIPPLE agent;
   - set `SWITCH_BRIDGE_URL`, `SWITCH_AGENT_ID`, `SWITCH_AGENT_API_KEY` and `SWITCH_SELF_NAME`;
   - restart, then turn the switch on.
2. Only one of the three showcase verticals is built end to end (software/data change → verified recovery). The conflict→correction and policy-controlled business-action verticals rely on existing packs (BEO, InvoiceGuard, Escrow Release) and the Knowledge dashboard. They are not new end-to-end slices.
3. There is no visual cross-domain workflow composer, no generic policy DSL (policy stays role/approver rules in the engine), and no GitHub/telemetry ingestion.
4. The ledger hash chain is computed on read. Seals detect edits but are not externally anchored or signed.
5. Workflow Studio still runs its labelled synthetic GPU-billing scenario (server-backed via `/api/studio/*`).
6. The Playwright e2e scripts were not run. Browser checks were manual through the Chrome tools.
