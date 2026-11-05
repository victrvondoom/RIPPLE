import { capture, dayMin, reserve, schedule, seats, setState, spend } from './packs.js';
import type { CdScenario, InvariantDef, InvariantSpec } from './types.js';

/**
 * Cross-domain scenarios: configuration, like packs. Each one seeds ONE shared Reality Lab world, a set of workflows
 * from different domain packs (each locally valid on its own evidence), the world's history and scripted concurrent
 * events. `truth` is used ONLY by the cross-domain benchmark scorer; the engine never reads it.
 */
const inv = (key: string, name: string, explanation: string, spec: InvariantSpec, o: Partial<InvariantDef> = {}): InvariantDef => ({
  key, name, explanation, scope: 'cross-domain', spec, severity: 'high', impact: 'Customer-visible double commitment or loss', resolutionPolicy: 'Constrained arbitration: hard-constraint violators are rejected; a human chooses among feasible plans; approval binds to the plan hash.',
  approvalLevel: 'manager', strength: 'hard', autoRestorable: false, provenance: { source: 'policy', by: 'workspace policy (scenario configuration)' }, confidence: 1, uncertainty: 'Evaluated from independent sandbox reads.', ...o,
});
const unit = (r: string, cls: string) => ({ system: 'inventory', resource: r, state: { holder: null, class: cls } });

export const CD_SCENARIOS: CdScenario[] = [
  // ===================================================================== Scenario 1
  {
    id: 'cd-booking-payment-inventory',
    title: 'Booking × Payment × Inventory — the double-sold weekend',
    story: 'A corporate retreat, a wedding booking and the wedding deposit each pass their own checks. The wedding was planned on a stale inventory read; the deposit was captured against a suite the retreat already holds; both events need the same AV kit and together overflow the grand hall.',
    packs: ['travel', 'inventory', 'payments'],
    initial: [
      unit('suite-301', 'suite'), unit('suite-305', 'suite'), unit('av-kit-2', 'av-kit'), unit('av-kit-4', 'av-kit'),
      { system: 'bookings', resource: 'grand-hall', state: { capacity: 120, used: 0 } }, { system: 'bookings', resource: 'terrace', state: { capacity: 80, used: 0 } },
      { system: 'bookings', resource: 'retreat', state: { status: 'draft' } }, { system: 'bookings', resource: 'wedding', state: { status: 'draft' } },
      { system: 'payments', resource: 'dep-wedding', state: { status: 'authorized', captured_cents: 0, for: null } }, { system: 'ledger', resource: 'wedding-deposit', state: { posted: false } },
    ],
    workflows: [
      { key: 'retreat', pack: 'travel', title: 'Corporate retreat booking', intent: 'Hold Suite 301 and AV kit 2, seat 80 in the grand hall, confirm the retreat.', owner: 'maya', approvedBy: 'maya',
        ops: [reserve('r1', 'Hold Suite 301 for the retreat', 'inventory', 'suite-301', 'retreat', { claim: 'Suite 301 is held for the corporate retreat' }), reserve('r0', 'Hold AV kit 2 for the retreat', 'inventory', 'av-kit-2', 'retreat'), seats('r2', 'Seat 80 retreat guests in the grand hall', 'bookings', 'grand-hall', 80, 'retreat'), setState('r3', 'Confirm the retreat', 'bookings', 'retreat', { status: 'confirmed' })],
        localInvariants: [inv('retreat-suite', 'A confirmed retreat holds its suite', 'If the retreat is confirmed, Suite 301 must be held by the retreat.', { type: 'consistency', rule: 'implies', if: { system: 'bookings', resource: 'retreat', field: 'status', equals: 'confirmed' }, then: { system: 'inventory', resource: 'suite-301', field: 'holder', equals: 'retreat' } }, { scope: 'workflow', owner: 'retreat' })] },
      { key: 'wedding', pack: 'travel', title: 'Wedding party booking', intent: 'Hold Suite 301 and AV kit 2, seat 60 in the grand hall, confirm the wedding.', owner: 'maya', approvedBy: 'maya',
        stalePlanningEvidence: [{ system: 'inventory', resource: 'suite-301' }, { system: 'inventory', resource: 'av-kit-2' }],
        ops: [reserve('w1', 'Hold Suite 301 for the wedding', 'inventory', 'suite-301', 'wedding'), reserve('w2', 'Hold AV kit 2 for the wedding', 'inventory', 'av-kit-2', 'wedding'), seats('w3', 'Seat 60 wedding guests in the grand hall', 'bookings', 'grand-hall', 60, 'wedding', { flex: { alternates: ['bookings/terrace'] } }), setState('w4', 'Confirm the wedding', 'bookings', 'wedding', { status: 'confirmed' })] },
      { key: 'deposit', pack: 'payments', title: 'Wedding deposit capture', intent: 'Capture the $2,400 wedding deposit for the wedding suite and post it to the ledger.', owner: 'maya', approvedBy: 'maya', declaredLinks: ['wedding'],
        ops: [capture('p1', 'Capture $2,400 wedding deposit (for Suite 301)', 'dep-wedding', 240000, 'suite-301', { claim: 'Deposit captured: Suite 301 is secured for the wedding', asserts: [{ ref: 'inventory/suite-301', field: 'holder', equals: 'wedding' }] }), setState('p2', 'Post the deposit to the ledger', 'ledger', 'wedding-deposit', { posted: true })] },
    ],
    history: [{ workflow: 'retreat', op: 'r1' }, { workflow: 'retreat', op: 'r0' }, { workflow: 'deposit', op: 'p1' }],
    sharedInvariants: [
      inv('uniq-suite-301', 'Suite 301 has one holder', 'A room-night can be held by exactly one party.', { type: 'uniqueness', ref: { system: 'inventory', resource: 'suite-301' }, holderField: 'holder' }, { severity: 'critical' }),
      inv('uniq-suite-305', 'Suite 305 has one holder', 'A room-night can be held by exactly one party.', { type: 'uniqueness', ref: { system: 'inventory', resource: 'suite-305' }, holderField: 'holder' }, { severity: 'critical' }),
      inv('uniq-av-kit-2', 'AV kit 2 has one holder', 'One AV kit cannot be in two events.', { type: 'uniqueness', ref: { system: 'inventory', resource: 'av-kit-2' }, holderField: 'holder' }, { severity: 'critical' }),
      inv('uniq-av-kit-4', 'AV kit 4 has one holder', 'One AV kit cannot be in two events.', { type: 'uniqueness', ref: { system: 'inventory', resource: 'av-kit-4' }, holderField: 'holder' }, { severity: 'critical' }),
      inv('cap-grand-hall', 'Grand hall seats ≤ 120', 'Seats committed across all events cannot exceed the fire-code capacity.', { type: 'capacity', ref: { system: 'bookings', resource: 'grand-hall' }, capacityField: 'capacity', usedField: 'used' }),
      inv('cap-terrace', 'Terrace seats ≤ 80', 'Seats committed across all events cannot exceed the terrace capacity.', { type: 'capacity', ref: { system: 'bookings', resource: 'terrace' }, capacityField: 'capacity', usedField: 'used' }),
      inv('deposit-points-to-held-unit', 'A captured wedding deposit references a suite the wedding holds', 'Money taken for a unit must correspond to a unit the paying party actually holds (payments ↔ inventory).', { type: 'consistency', rule: 'pointer', if: { system: 'payments', resource: 'dep-wedding', field: 'status', equals: 'captured' }, pointer: { system: 'payments', resource: 'dep-wedding', field: 'for' }, targetSystem: 'inventory', targetField: 'holder', equals: 'wedding' }, { severity: 'critical', impact: 'Customer charged for a room they cannot have' }),
      inv('ledger-after-confirm', 'Deposit is posted only after the wedding is confirmed', 'The ledger posting (payments) must come after the booking confirmation (bookings).', { type: 'temporal_order', before: { workflow: 'wedding', op: 'w4' }, after: { workflow: 'deposit', op: 'p2' } }, { severity: 'medium', impact: 'Revenue recognised for an unconfirmed event' }),
      inv('recovery-safety', 'Resolutions must not break the retreat', 'No resolution may break an invariant that already held for another party.', { type: 'recovery_safety', protects: ['retreat-suite', 'uniq-suite-301', 'uniq-av-kit-2'] }),
    ],
    resolutionApprover: 'maya',
    truth: { expectedPatterns: ['resource_collision', 'constraint_collision', 'cross_domain_partial_commit', 'contradictory_declarations', 'temporal_evidence_invalidation', 'split_authority', 'hidden_shared_constraint'], hiddenShared: 2, dependencyInvalidations: 0, unsafeAsPlanned: true, staleOps: ['wedding:w1', 'wedding:w2'], protectedInvariants: ['retreat-suite'], feasible: true, unknownDecisions: 0 },
  },
  // ===================================================================== Scenario 2
  {
    id: 'cd-deploy-lineage-analytics',
    title: 'Deployment × Data Lineage × Analytics — green deploy, broken consumers',
    story: 'orders-api v2 passed its own health checks and is live; its pending step publishes the orders contract as v2-only. The revenue dashboard still expects v1 and last verified itself before the deploy. A backfill job already depends on v2. The obvious fix — roll back — would break the backfill.',
    packs: ['release', 'data'],
    initial: [
      { system: 'deploy', resource: 'orders-api', state: { version: 'v1', serves: ['orders.v1'], compat_view: null } },
      { system: 'health', resource: 'orders-api', state: { error_rate: 0.002 } },
      { system: 'warehouse', resource: 'orders-contract', state: { schema_version: 'orders.v1', compatible_with: ['orders.v1'] } },
      { system: 'analytics', resource: 'revenue-dashboard', state: { expects_schema: 'orders.v1', status: 'live', verified_against: 'orders.v1' } },
      { system: 'analytics', resource: 'backfill-job', state: { expects_schema: 'orders.v2', status: 'queued' } },
    ],
    workflows: [
      { key: 'release-v2', pack: 'release', title: 'orders-api v2 release', intent: 'Deploy orders-api v2 and publish the orders contract v2.', owner: 'maya', approvedBy: 'maya',
        ops: [{ ...setState('d1', 'Deploy orders-api v2', 'deploy', 'orders-api', { version: 'v2', serves: ['orders.v2'] }), reversibility: 'compensable', compensate: { label: 'Roll orders-api back to v1', patch: { set: { version: 'v1', serves: ['orders.v1'] } } }, claim: 'orders-api v2 deployed and healthy' },
          { ...setState('d2', 'Publish orders contract v2 (v2-only)', 'warehouse', 'orders-contract', { schema_version: 'orders.v2', compatible_with: ['orders.v2'] }), effect: { kind: 'publish' }, flex: { alternates: ['deploy/orders-api'] } }],
        localInvariants: [inv('release-health', 'orders-api local health check', 'The release workflow\'s own gate: error rate below 2%.', { type: 'pack', pack: 'release', evaluator: 'health_ok', params: { ref: 'health/orders-api', max: 0.02 }, reads: [{ system: 'health', resource: 'orders-api' }] }, { scope: 'workflow', owner: 'release-v2', provenance: { source: 'pack', by: 'release pack evaluator health_ok' } })] },
      { key: 'revenue-dashboard', pack: 'data', title: 'Revenue dashboard refresh', intent: 'Refresh and re-verify the revenue dashboard against the orders contract.', owner: 'maya',
        stalePlanningEvidence: [{ system: 'deploy', resource: 'orders-api' }],
        ops: [setState('a1', 'Refresh the revenue dashboard', 'analytics', 'revenue-dashboard', { status: 'refreshed' })] },
      { key: 'backfill', pack: 'data', title: 'Orders history backfill (v2)', intent: 'Backfill order history in the v2 format.', owner: 'maya', approvedBy: 'maya',
        ops: [setState('b1', 'Start the v2 backfill', 'analytics', 'backfill-job', { status: 'running' }), setState('b2', 'Complete the v2 backfill', 'analytics', 'backfill-job', { status: 'complete' })] },
    ],
    history: [{ workflow: 'release-v2', op: 'd1' }, { workflow: 'backfill', op: 'b1' }],
    sharedInvariants: [
      inv('lineage-dashboard', 'Dashboard reads a contract it understands', 'The revenue dashboard expects a schema the published orders contract still honours.', { type: 'lineage', upstream: { system: 'warehouse', resource: 'orders-contract' }, compatField: 'compatible_with', downstream: { system: 'analytics', resource: 'revenue-dashboard' }, expectsField: 'expects_schema' }, { severity: 'critical', impact: 'Finance reads wrong revenue numbers' }),
      inv('lineage-backfill', 'Backfill reads a schema the API serves', 'The v2 backfill reads orders-api; the API must keep serving v2 while the backfill runs.', { type: 'lineage', upstream: { system: 'deploy', resource: 'orders-api' }, compatField: 'serves', downstream: { system: 'analytics', resource: 'backfill-job' }, expectsField: 'expects_schema' }, { severity: 'critical', impact: 'Backfill corrupts history', strength: 'conditional', conditionWorkflow: 'backfill' }),
      inv('recovery-safety', 'Resolutions must not break other consumers', 'No corrective action may break a lineage invariant that already held.', { type: 'recovery_safety', protects: ['lineage-backfill', 'lineage-dashboard'] }),
    ],
    resolutionApprover: 'maya',
    truth: { expectedPatterns: ['dependency_invalidation', 'temporal_evidence_invalidation', 'hidden_shared_constraint', 'recovery_collateral'], hiddenShared: 2, dependencyInvalidations: 1, unsafeAsPlanned: true, staleOps: ['revenue-dashboard:a1'], protectedInvariants: ['lineage-backfill'], feasible: true, unknownDecisions: 0 },
  },
  // ===================================================================== Scenario 3
  {
    id: 'cd-budget-procurement-scheduling',
    title: 'Budget × Procurement × Scheduling — three yeses, one budget',
    story: 'A laptop purchase, a contractor crew and a team offsite are each within the Q4 operations budget on their own. Nobody references anybody else. Together they overspend Q4 by $9,000, and the crew and the offsite both need the crew lead on day 12.',
    packs: ['finance', 'scheduling', 'travel'],
    initial: [
      { system: 'budget', resource: 'ops-q4', state: { limit_cents: 5_000_000, spent_cents: 2_000_000 } },
      { system: 'budget', resource: 'ops-q1', state: { limit_cents: 5_000_000, spent_cents: 0 } },
      { system: 'procurement', resource: 'po-laptops', state: { status: 'draft' } },
      { system: 'scheduling', resource: 'crew-lead', state: { slots: [], slot_count: 0 } },
      { system: 'scheduling', resource: 'sow-crew', state: { status: 'draft' } },
      { system: 'bookings', resource: 'offsite-venue', state: { status: 'draft' } },
    ],
    workflows: [
      { key: 'laptops', pack: 'finance', title: 'Laptop refresh purchase', intent: 'Commit $18,000 from Q4 ops and issue the laptop PO.', owner: 'maya', approvedBy: 'maya',
        ops: [spend('o1', 'Commit $18,000 from ops-q4', 'ops-q4', 1_800_000, { flex: { alternates: ['budget/ops-q1'] } }), setState('o2', 'Issue the laptop purchase order', 'procurement', 'po-laptops', { status: 'issued' })] },
      { key: 'crew', pack: 'scheduling', title: 'Contractor crew scheduling', intent: 'Commit $12,000 from Q4 ops, book the crew lead on day 12 and sign the SOW.', owner: 'tess', approvedBy: 'tess',
        ops: [spend('s1', 'Commit $12,000 from ops-q4', 'ops-q4', 1_200_000), schedule('s2', 'Book crew lead day 12 08:00–16:00', 'crew-lead', 'crew', [dayMin(12, 8), dayMin(12, 16)], { flex: { windows: [[dayMin(13, 8), dayMin(13, 16)]] } }), setState('s3', 'Sign the crew SOW', 'scheduling', 'sow-crew', { status: 'signed' })] },
      { key: 'offsite', pack: 'travel', title: 'Team offsite', intent: 'Commit the $9,000 venue deposit from Q4 ops, have the crew lead host day 12, confirm the venue.', owner: 'maya', approvedBy: 'maya',
        ops: [spend('e1', 'Commit $9,000 venue deposit from ops-q4', 'ops-q4', 900_000), schedule('e2', 'Crew lead hosts the offsite day 12 09:00–17:00', 'crew-lead', 'offsite', [dayMin(12, 9), dayMin(12, 17)]), setState('e3', 'Confirm the offsite venue', 'bookings', 'offsite-venue', { status: 'confirmed' })] },
    ],
    sharedInvariants: [
      inv('budget-ops-q4', 'Q4 operations budget ≤ $50,000', 'Aggregate committed spending on ops-q4 stays within the authorized limit.', { type: 'budget', ref: { system: 'budget', resource: 'ops-q4' }, limitField: 'limit_cents', spentField: 'spent_cents' }, { approvalLevel: 'owner', severity: 'critical', impact: 'Unauthorized overspend' }),
      inv('budget-ops-q1', 'Q1 operations budget ≤ $50,000', 'Aggregate committed spending on ops-q1 stays within the authorized limit.', { type: 'budget', ref: { system: 'budget', resource: 'ops-q1' }, limitField: 'limit_cents', spentField: 'spent_cents' }, { approvalLevel: 'owner' }),
      inv('excl-crew-lead', 'The crew lead is in one place at a time', 'Calendar commitments on the crew lead cannot overlap.', { type: 'mutual_exclusion', ref: { system: 'scheduling', resource: 'crew-lead' }, slotsField: 'slots' }, { severity: 'high', impact: 'A commitment to a person that cannot be kept' }),
    ],
    resolutionApprover: 'sam',
    truth: { expectedPatterns: ['constraint_collision', 'temporal_collision', 'hidden_shared_constraint', 'split_authority'], hiddenShared: 3, dependencyInvalidations: 0, unsafeAsPlanned: true, staleOps: [], protectedInvariants: [], feasible: true, unknownDecisions: 0 },
  },
  // ===================================================================== Scenario 4
  {
    id: 'cd-recovery-concurrent',
    title: 'Recovery × Concurrent workflow — the compensation that would steal a unit',
    story: 'Order 41 captured payment and held console unit 9, then its shipment failed. Its own plan proposes the textbook compensation: release unit 9 and refund. Before that compensation runs, a separate exchange workflow transfers unit 9 to order 77. The old compensation would now take the unit from a different customer.',
    packs: ['inventory', 'payments'],
    initial: [
      { system: 'payments', resource: 'pay-41', state: { status: 'authorized', captured_cents: 0, refunded_cents: 0 } },
      { system: 'inventory', resource: 'unit-9', state: { holder: null, class: 'console' } },
      { system: 'shipping', resource: 'shp-41', state: { status: 'none' } },
      { system: 'orders', resource: 'order-77', state: { status: 'exchange-pending' } },
    ],
    workflows: [
      { key: 'order-41', pack: 'inventory', title: 'Order 41 fulfilment', intent: 'Hold unit 9, capture $480, ship it.', owner: 'maya', approvedBy: 'maya',
        ops: [
          reserve('f1', 'Hold console unit 9 for order 41', 'inventory', 'unit-9', 'order-41'),
          capture('f2', 'Capture $480 for order 41', 'pay-41', 48000, 'unit-9'),
          setState('f3', 'Ship order 41', 'shipping', 'shp-41', { status: 'shipped' }),
          { key: 'c1', label: 'Compensation: release unit 9 back to stock', system: 'inventory', resource: 'unit-9', patch: { set: { holder: null } }, effect: { kind: 'release', holder: 'order-41' }, reversibility: 'reversible', expect: [{ field: 'holder', equals: null }], isCompensation: true },
          { key: 'c2', label: 'Compensation: refund $480 for order 41', system: 'payments', resource: 'pay-41', patch: { set: { status: 'refunded' }, inc: { captured_cents: -48000, refunded_cents: 48000 } }, effect: { kind: 'compensate', amount: 48000 }, reversibility: 'irreversible', expect: [{ field: 'status', equals: 'refunded' }], isCompensation: true },
        ] },
      { key: 'exchange-77', pack: 'inventory', title: 'Order 77 exchange', intent: 'Transfer unit 9 to order 77 and mark the exchange allocated.', owner: 'tess', approvedBy: 'tess',
        ops: [
          { ...reserve('x1', 'Transfer unit 9 to order 77', 'inventory', 'unit-9', 'order-77'), patch: { set: { holder: 'order-77' } }, scheduled: true },
          { ...setState('x2', 'Mark exchange 77 allocated', 'orders', 'order-77', { status: 'allocated' }), scheduled: true },
        ] },
    ],
    history: [{ workflow: 'order-41', op: 'f1' }, { workflow: 'order-41', op: 'f2' }, { workflow: 'order-41', op: 'f3', fail: 'unavailable' }],
    events: [
      { at: 'before_resolution', kind: 'workflow_op', workflow: 'exchange-77', op: 'x1', label: 'Concurrent workflow: exchange-77 transfers unit 9 to order 77 (it does not consult this arbitration)' },
      { at: 'before_resolution', kind: 'workflow_op', workflow: 'exchange-77', op: 'x2', label: 'Concurrent workflow: exchange-77 marks order 77 allocated' },
    ],
    sharedInvariants: [
      inv('pay-iff-shipped', 'A capture for order 41 implies a shipment', 'Money captured in payments must correspond to goods shipped by the carrier (payments ↔ shipping).', { type: 'consistency', rule: 'implies', if: { system: 'payments', resource: 'pay-41', field: 'status', equals: 'captured' }, then: { system: 'shipping', resource: 'shp-41', field: 'status', equals: 'shipped' } }, { severity: 'critical', impact: 'Customer charged, nothing shipped' }),
      inv('exchange-holds-unit', 'An allocated exchange holds its unit', 'If exchange 77 is allocated, unit 9 must be held by order 77.', { type: 'consistency', rule: 'implies', if: { system: 'orders', resource: 'order-77', field: 'status', equals: 'allocated' }, then: { system: 'inventory', resource: 'unit-9', field: 'holder', equals: 'order-77' } }, { severity: 'critical', owner: 'exchange-77', impact: 'A different customer loses their unit' }),
      inv('uniq-unit-9', 'Unit 9 has one holder', 'One console unit, one holder.', { type: 'uniqueness', ref: { system: 'inventory', resource: 'unit-9' }, holderField: 'holder' }, { severity: 'critical' }),
      inv('recovery-safety', 'Recovery must not harm the exchange', 'A corrective action for order 41 must not break an invariant of another workflow.', { type: 'recovery_safety', protects: ['exchange-holds-unit', 'uniq-unit-9'] }),
    ],
    resolutionApprover: 'maya',
    truth: { expectedPatterns: ['cross_domain_partial_commit', 'hidden_shared_constraint', 'temporal_evidence_invalidation', 'recovery_collateral', 'contradictory_declarations'], hiddenShared: 1, dependencyInvalidations: 0, unsafeAsPlanned: true, staleOps: ['order-41:c1'], protectedInvariants: ['exchange-holds-unit'], feasible: true, unknownDecisions: 0 },
  },
  // ===================================================================== Control: no intersection (false-positive check)
  {
    id: 'cd-control-independent',
    title: 'Control — two workflows that genuinely do not intersect',
    story: 'A search-api release and a gala booking share no resource, budget, evidence or time window. A correct engine must find nothing and let both run.',
    packs: ['release', 'travel'],
    initial: [
      { system: 'deploy', resource: 'search-api', state: { version: 'v3' } }, { system: 'health', resource: 'search-api', state: { error_rate: 0.001 } },
      unit('suite-410', 'suite'), { system: 'bookings', resource: 'gala', state: { status: 'draft' } },
    ],
    workflows: [
      { key: 'search-release', pack: 'release', title: 'search-api v4 release', intent: 'Deploy search-api v4.', owner: 'maya', approvedBy: 'maya',
        ops: [setState('s1', 'Deploy search-api v4', 'deploy', 'search-api', { version: 'v4' })],
        localInvariants: [inv('search-health', 'search-api local health check', 'Error rate below 2%.', { type: 'pack', pack: 'release', evaluator: 'health_ok', params: { ref: 'health/search-api', max: 0.02 }, reads: [{ system: 'health', resource: 'search-api' }] }, { scope: 'workflow', owner: 'search-release', provenance: { source: 'pack', by: 'release pack evaluator health_ok' } })] },
      { key: 'gala', pack: 'travel', title: 'Gala suite booking', intent: 'Hold Suite 410 and confirm the gala.', owner: 'maya', approvedBy: 'maya',
        ops: [reserve('g1', 'Hold Suite 410 for the gala', 'inventory', 'suite-410', 'gala'), setState('g2', 'Confirm the gala', 'bookings', 'gala', { status: 'confirmed' })] },
    ],
    sharedInvariants: [inv('uniq-suite-410', 'Suite 410 has one holder', 'One room-night, one holder.', { type: 'uniqueness', ref: { system: 'inventory', resource: 'suite-410' }, holderField: 'holder' })],
    resolutionApprover: 'maya',
    truth: { expectedPatterns: [], hiddenShared: 0, dependencyInvalidations: 0, unsafeAsPlanned: false, staleOps: [], protectedInvariants: [], feasible: true, unknownDecisions: 0 },
  },
  // ===================================================================== Unknown observation
  {
    id: 'cd-unknown-ledger',
    title: 'Unknown state — the budget ledger cannot be read',
    story: 'A monitor purchase and a temp-staff SOW both draw on Q4 ops and together would exceed it. After both were planned, the budget ledger read API becomes unreadable. Unknown must never be treated as "within budget".',
    packs: ['finance', 'scheduling'],
    initial: [
      { system: 'budget', resource: 'ops-q4', state: { limit_cents: 3_000_000, spent_cents: 1_000_000 } },
      { system: 'procurement', resource: 'po-monitors', state: { status: 'draft' } }, { system: 'scheduling', resource: 'sow-temp', state: { status: 'draft' } },
    ],
    workflows: [
      { key: 'monitors', pack: 'finance', title: 'Monitor purchase', intent: 'Commit $12,000 from Q4 ops and issue the PO.', owner: 'maya', approvedBy: 'maya',
        ops: [spend('m1', 'Commit $12,000 from ops-q4', 'ops-q4', 1_200_000), setState('m2', 'Issue the monitor PO', 'procurement', 'po-monitors', { status: 'issued' })] },
      { key: 'temps', pack: 'scheduling', title: 'Temp staff SOW', intent: 'Commit $9,000 from Q4 ops and sign the temp SOW.', owner: 'tess', approvedBy: 'tess',
        ops: [spend('t1', 'Commit $9,000 from ops-q4', 'ops-q4', 900_000), setState('t2', 'Sign the temp SOW', 'scheduling', 'sow-temp', { status: 'signed' })] },
    ],
    faults: [{ kind: 'observe_unavailable', system: 'budget', reads: 1000, label: 'budget ledger read API unavailable (after planning)' }],
    sharedInvariants: [inv('budget-ops-q4', 'Q4 operations budget ≤ $30,000', 'Aggregate committed spending stays within the authorized limit.', { type: 'budget', ref: { system: 'budget', resource: 'ops-q4' }, limitField: 'limit_cents', spentField: 'spent_cents' }, { approvalLevel: 'owner', severity: 'critical' })],
    resolutionApprover: 'sam',
    truth: { expectedPatterns: ['unknown_state', 'hidden_shared_constraint'], hiddenShared: 1, dependencyInvalidations: 0, unsafeAsPlanned: true, staleOps: [], protectedInvariants: [], feasible: true, unknownDecisions: 1 },
  },
];
export const cdScenarioById = (id: string) => CD_SCENARIOS.find((s) => s.id === id);
