# End-to-End Verification (session 3, real output)

Replaces an earlier version whose scenario prose overstated what ran.

## Automated
```
$ npm test            ->  Test Files 16 passed (16) | Tests 132 passed (132)
$ npm run typecheck   ->  tsc --noEmit: no errors
$ npm run lint        ->  eslint src: no errors
$ npm run build       ->  vite build OK
```
Baseline at the start of the session was 14 files / 94 tests. Added: `offerroom.test.ts` (15), `switch-resilience.test.ts` (7), and a rewrite of `newpacks.test.ts` (5 -> 21) that now covers negative paths (ambiguous culprit, no breach, unprovable patch, hash mismatch, missing evidence, already-released, duplicate issue, vague issue, unmapped approver, tampered stored documents). The old `newpacks` tests asserted hard-coded strings; they were replaced because the behaviour they described was hollow, not because it was inconvenient.

## HTTP journey on a fresh server (`scripts/e2e-inherited.mjs`, port 8791)
All checks passed (61 PASS lines, 0 FAIL) for offerroom, incident-sentinel, schemacourt, clearsend, crewpilot. Per pack: the wrong person got HTTP 403 with the named-approver message (e.g. "Only Mia Chen (Candidate) can decide this approval."), the right person approved, the connector executed, the action became `verified`, and the pack-specific evidence passed (e.g. "stored patch re-run on DRIFTED fixture: zero variance 3/3 groups").
After verification each mission reported **NOT complete** (acknowledgements / reviews outstanding, and for Sentinel `recovery_measured`). That is intended.

## Not run
No browser (Playwright) journey for the five new packs; the Approvals-page badge is built and compiles but was not viewed. No real Switch server. No real model API. Connectors are local/dry-run.
