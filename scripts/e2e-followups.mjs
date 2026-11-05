// Pack-specific follow-up updates driven through the UI. Readiness packs (MoveMate, SubmitReady) must be completed with
// evidence-backed progress, which the user supplies as a NEW submission (revision history keeps the previous one).
async function approveAndExecute(mgr, { state }) {
  await mgr.getByRole('tab', { name: /Approvals & actions/ }).click();
  await state(mgr, 'Awaiting approval');
  for (let g = 0; g < 10; g++) { const b = mgr.getByRole('button', { name: 'Approve', exact: true }); if (!(await b.count())) break; await b.first().click(); await mgr.waitForTimeout(400); }
  for (let g = 0; g < 12; g++) { const b = mgr.getByRole('button', { name: 'Execute now' }); if (!(await b.count())) break; await b.first().click(); await mgr.waitForTimeout(600); }
  await state(mgr, 'Verifying');
}
async function submitJson(mgr, key, value, { shot }) {
  await mgr.getByRole('button', { name: /Start from previous submission/ }).click();
  await mgr.getByRole('button', { name: 'Edit as JSON' }).first().click();
  await mgr.getByLabel(`${key} (JSON)`).fill(JSON.stringify(value, null, 2));
  await shot(mgr, '10b-followup-form');
  await mgr.getByRole('button', { name: /& analyse/ }).click();
}
export default {
  movemate: async (mgr, h) => {
    const ids = ['ob_internet', 'ob_meter', 'ob_bills', 'ob_clean', 'ob_inspection', 'ob_keys', 'ob_deposit', 'ob_mail'];
    const ev = ['ob_internet', 'ob_meter', 'ob_bills', 'ob_clean', 'ob_keys'];
    const updates = [...ids.map((id) => ({ obligationId: id, status: 'done', ...(id === 'ob_keys' ? { ownerId: 'b' } : {}) })), ...ev.map((id) => ({ obligationId: id, addEvidence: { kind: 'photo', ref: `${id}-evidence.jpg` } }))];
    await submitJson(mgr, 'updates', updates, h); h.step('Follow-up check-in submitted through the UI: all 8 obligations done with 5 evidence items (new revision; prior submission kept in history)');
    await approveAndExecute(mgr, h); h.step('Follow-up actions approved, executed and verified (identical landlord email carried over, not re-sent)');
  },
  submitready: async (mgr, h) => {
    const ev = (ref, extra = {}) => ({ kind: 'file', ref, verified: true, title: 'Orbit: Adaptive Routing', teamName: 'Team Orbit', ...extra });
    const updates = [{ deliverableId: 'd_report', status: 'complete', addEvidence: ev('report-final.pdf') }, { deliverableId: 'd_slides', status: 'complete', addEvidence: ev('slides-final.pdf') }, { deliverableId: 'd_video', status: 'complete', ownerId: 'm4', addEvidence: ev('https://video.example/orbit-demo', { kind: 'link' }) }, { deliverableId: 'd_cites', status: 'complete', addEvidence: ev('citations.bib') }, { deliverableId: 'd_peer', status: 'complete', addEvidence: ev('peer-eval.pdf') }];
    await mgr.getByRole('button', { name: /Start from previous submission/ }).click();
    await mgr.getByRole('button', { name: 'Edit as JSON' }).first().click();
    await mgr.getByLabel('updates (JSON)').fill(JSON.stringify(updates, null, 2));
    await mgr.getByLabel('citations (JSON)').fill(JSON.stringify([{ id: 'c2', source: 'Stanford routing study (2022)', usedIn: ['d_report', 'd_slides'], verified: true }]));
    await h.shot(mgr, '10b-followup-form'); await mgr.getByRole('button', { name: /& analyse/ }).click();
    await mgr.getByRole('tab', { name: /Tasks & questions/ }).click(); await mgr.getByText(/not applicable/i).first().waitFor();
    const q = mgr.locator('form', { hasText: 'Submit answer' }).first(); await q.getByLabel('Answer').fill('yes - instructor confirmed by email'); await q.getByRole('button', { name: 'Submit answer' }).click(); await mgr.waitForTimeout(1200);
    h.step('Follow-up progress update (all deliverables evidenced) submitted through the UI; not-applicable claim confirmed by a human answer');
    await approveAndExecute(mgr, h); h.step('Follow-up actions approved, executed and verified');
  },
};
