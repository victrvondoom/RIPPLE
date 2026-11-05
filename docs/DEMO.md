# Demo script (BEO Rescue) — ~6 minutes
Start: `scripts/fresh-server.sh` (throw-away DB) or `npm run start`. Browser: http://localhost:8787. All passwords `ripple-demo`.

1. **Maya (manager)** → Missions → New mission → *Load sample plan* → Create. State: Draft.
2. Approve & save baseline v1 → *Baseline ready*.
3. Enter client change → *Load sample change* (120→145, service 18:30→19:30, vegan meals, count blank) → Submit.
4. Mission is **Blocked**: the banner says why (vegan count unknown). No actions exist yet. Look at *Collaboration room*: LOCAL-mode banner, handoffs Change → Kitchen → Procurement → Service → Event Manager, the Kitchen Agent's blocking question.
5. Overview → answer `18` → re-analysis → **Awaiting approval** (5 approvals).
6. *Impact graph*: click "Guest count" to highlight the 40+ downstream nodes. *Agent findings*: allergen conflict flagged for **human review**; Plant Pantry lead-time risk; teardown vs curfew; venue capacity 140 < 145; staffing +2 servers/+1 kitchen/+1 bartender. *Drafts*: revised BEO, kitchen, procurement, staffing, client email (provenance + hash shown).
7. *Approvals & actions*: read exact content, approve each. (Optional stale demo: before executing, submit a second change on the Baseline tab — queued actions turn **stale** and cannot run.)
8. **Sam (owner)** → Settings → arm "fail next execution" on Email outbox. Maya executes all: the supplier email **fails** → **Recovery required**. *Retry (recovery)* → verified. Audit tab shows the failure and retry.
9. **Luis / Priya / Dan** each open the mission → Approvals & actions → *Acknowledge receipt*; Luis marks the vegan-recipe allergen review done.
10. Maya → Evidence & outcome → *Complete mission* is **refused** while Priya's procurement review is open; Priya marks it done; Maya completes → **Completed**, baseline v2 (145 guests, 18 vegan), outcome record lists unresolved items (e.g. venue capacity).
11. Missions → New mission → pack **SceneShift** → sample → baseline → change: same engine, different domain.
`node scripts/e2e.mjs` automates all of this in Chromium and writes screenshots to `docs/evidence/`.

---
# Demo scripts for the other packs (≈3 min each; all passwords `ripple-demo`)
Fast path for any pack: sign in as `maya@`, **Workflow Packs → "Demo + analyse"** (labelled sample data), or **Missions → New mission** to enter your own JSON plan then **Baseline & change → Load sample / Start from previous submission**.

| Pack | Sign in as | What to show |
|---|---|---|
| ScopeGuard | maya (manager), sam (owner) | 7 requested items: booking flow, Stripe, Pricing/Team pages, contact tweak, revision, "feel premium". Blocked on the vague one → answer "out of scope". Read the change order draft ("TO BE CONFIRMED"), client message (no price/date). Maya cannot approve the change order; **sam** can. Execute; verification lists "no price quoted". |
| InvoiceGuard | maya, ravi | Invoice ₹48,000 vs milestone ₹40,000: unmatched line, unaccepted deliverable D4, 32h vs 30h evidenced, rate over cap. Neutral clarification draft; reconciliation record says no payment initiated. Complete evidence request → linked "attach evidence" item auto-completes. |
| ShiftRelay | tess (supervisor), omar, jo | Handover omits J-104 → blocked → answer as Jo/Maya. Critical J-102 (SLA, missing part, callback). Tess approves; Omar and Jo and Tess acknowledge; Omar confirms the callback; unresolved repairs stay in the outcome. |
| MoveMate | nina, leo | 12 days to lease end: internet needs 10 days' notice (at risk), keys unowned (blocking → "Leo"), uncertain lease clauses flagged "not legal advice". Meter reading task satisfies two other tasks. Completion is refused until a second check-in (Start from previous submission → Edit as JSON) shows every obligation done with evidence. |
| PodFlow | cleo | Transcript text only (banner everywhere). Candidates with claim flags; approve "1,4"; kit with platform limits and FLAG lines; media check + claim reviews gate completion; uploads stay open. |
| SubmitReady | mia, ben | Rubric R1–R8: one verified, others incomplete/uncertain, title mismatch flagged, N/A claim needs human "yes". Follow-up update with verified evidence → 96/96 points → complete. |
| Cross-domain | maya | Control Center: filter by domain/status/owner/approval/blocked/recent across all 8 domains; Approvals shows manager- and owner-level items in one queue. |
Automated equivalents: `scripts/e2e-packs.mjs <pack>`, `scripts/e2e-crossdomain.mjs`.

## Orchestration canvas (session 5)
1. Sign in as Maya (manager) and open Missions, then "Meridian Labs Gala [demo]" (or create one from the BEO pack).
2. Submit the sample change. Open the **Orchestration** tab: five agent nodes appear around the Mission Orchestrator, all done. The mission is blocked on the vegan-count question.
3. Answer "18" in the Overview or Tasks tab. Revisit Orchestration: the Change agent shows Reused (its inputs did not change); Kitchen, Procurement, Service and the Event Manager re-ran.
4. Select a node to see its task, why it ran, its dependencies, findings, artifacts and messages.
5. Pause all agents, then resume (audited). Approve an approval card, or reject with a note.
