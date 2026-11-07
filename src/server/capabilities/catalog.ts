/**
 * RIPPLE capability catalog: 37 source projects (34 + RECLAIM, RESOLVE, REDEEM) → 7 capability systems → 4 dashboards → 1 mission engine.
 *
 * This file is CONFIGURATION, not behaviour. It records which source project contributes which capability,
 * which existing workflow pack (if any) already delivers part of that capability today, and whether the
 * project's source code is present in this repository. Nothing here claims a source project is integrated:
 * `integration` is 'pack-backed' only when an implemented RIPPLE pack exercises the capability, otherwise
 * 'catalogued' (idea recorded, not ported) or 'pending' (insufficient information to classify).
 */
export type SystemId = 'engineering' | 'incident' | 'commerce' | 'knowledge' | 'personal' | 'creative' | 'data';

export interface CapabilitySystem { id: SystemId; no: string; name: string; short: string; promise: string; workspace: string }
export interface SourceProject {
  id: string; name: string; system: SystemId; contributes: string[];
  /** repo folder holding the original source, when it was supplied */
  folder?: string;
  integration: 'pack-backed' | 'catalogued' | 'pending';
  note?: string;
}
export interface ScenarioStep { label: string; stage: 'intake' | 'analysis' | 'approval' | 'execute' | 'verify' | 'complete' }
export interface Scenario { id: string; title: string; systems: SystemId[]; projects: string[]; packs: string[]; steps: ScenarioStep[] }

export const SYSTEMS: CapabilitySystem[] = [
  { id: 'engineering', no: '01', name: 'Engineering Assurance & Release', short: 'Engineering', workspace: 'Engineering & releases', promise: 'Agents investigate, change, test and prepare releases, but never certify their own work.' },
  { id: 'incident', no: '02', name: 'Incident & Critical Operations', short: 'Incidents', workspace: 'Incidents & infrastructure', promise: 'Detect, investigate, choose a recovery, authorise it, execute it and verify the real outcome.' },
  { id: 'commerce', no: '03', name: 'Business, Customer & Commerce Operations', short: 'Commerce', workspace: 'Customer support & commerce', promise: 'Requests, orders, commitments and documents are checked against policy and prior promises before anything is sent.' },
  { id: 'knowledge', no: '04', name: 'Organizational Intelligence & Decision Integrity', short: 'Knowledge', workspace: 'Decisions & memory', promise: 'What was decided, why, by whom, on what evidence, and whether it is still valid.' },
  { id: 'personal', no: '05', name: 'Personal Planning & Opportunity Operations', short: 'Personal', workspace: 'Personal missions', promise: 'Separate personal mission templates on one user-owned planning framework.' },
  { id: 'creative', no: '06', name: 'Creative Production & Content Operations', short: 'Creative', workspace: 'Creative production', promise: 'Briefs, canon, revisions and approvals without losing continuity.' },
  { id: 'data', no: '07', name: 'Data Governance & Constraint-Based Planning', short: 'Data', workspace: 'Data & governance', promise: 'Schema and contract changes are impact-checked, planned against constraints and verified after execution.' },
];

/** Implemented RIPPLE packs → the capability system whose workspace they appear in. */
export const PACK_SYSTEM: Record<string, SystemId> = {
  'crewpilot': 'engineering', 'deploy-gate': 'engineering',
  'incident-sentinel': 'incident', 'shiftrelay': 'incident',
  'beo-rescue': 'commerce', 'run-of-show': 'commerce', 'scopeguard': 'commerce', 'invoiceguard': 'commerce', 'clearsend': 'commerce',
  'movemate': 'personal', 'submitready': 'personal', 'offerroom': 'personal',
  'sceneshift': 'creative', 'podflow': 'creative',
  'schemacourt': 'data', 'revenue-recovery': 'data',
  'consumer-resolution': 'commerce', 'billing-dispute': 'commerce',
};

const P = (id: string, name: string, system: SystemId, contributes: string[], extra: Partial<SourceProject> = {}): SourceProject =>
  ({ id, name, system, contributes, integration: 'catalogued', ...extra });

export const PROJECTS: SourceProject[] = [
  // 01 Engineering Assurance & Release (9)
  P('countersign', 'Countersign', 'engineering', ['Proposer / verifier / approver separation']),
  P('switch-notary', 'Switch Notary', 'engineering', ['Portable verification receipts'], { folder: 'switch-notary-main' }),
  P('unseen', 'UNSEEN', 'engineering', ['Independent reproduction of the reported failure'], { folder: 'unseen-main' }),
  P('preflight', 'Preflight', 'engineering', ['Preview / release-readiness checks']),
  P('gatekeeper', 'Gatekeeper', 'engineering', ['Security and package screening'], { folder: 'gatekeeper-master' }),
  P('shipyard', 'Shipyard', 'engineering', ['Permission-gated deployment'], { folder: 'shipyard-main' }),
  P('release-desk', 'Release Desk', 'engineering', ['Release notes, commands and release plan'], { folder: 'CommunityAI-main', note: 'Same project as CommunityAI.' }),
  P('bug-to-pr', 'Bug to PR Room', 'engineering', ['Bug report → isolated fix proposal'], { folder: 'bug-to-pr-room-main', integration: 'pack-backed', note: 'Issue triage is exercised today by the CrewPilot pack.' }),
  P('agentqa', 'AgentQA Network', 'engineering', ['QA execution and test-integrity evidence']),
  // 02 Incident & Critical Operations (4)
  P('opsroom', 'OpsRoom', 'incident', ['AWS operations incident workflow'], { folder: 'OpsRoom-main', integration: 'pack-backed', note: 'Incident lifecycle exercised by the Incident-Sentinel pack.' }),
  P('groundlink', 'GroundLink', 'incident', ['Satellite telemetry anomaly specialist pack']),
  P('incidentroom', 'IncidentRoom', 'incident', ['Incident coordination room'], { integration: 'pack-backed', note: 'Coordination via Incident-Sentinel mission rooms.' }),
  P('kite', 'Kite', 'incident', ['Operational recovery alternatives'], { folder: 'kite-main' }),
  // 03 Business, Customer & Commerce (6 + Bangsayur, reclassified from its README)
  P('deskpilot', 'DeskPilot', 'commerce', ['Support request classification and policy lookup']),
  P('bizowl', 'BizOwl Brief Desk', 'commerce', ['Funding / investor brief workflow'], { folder: 'bizowl-brief-desk-main' }),
  P('orderroom', 'OrderRoom', 'commerce', ['Order change against credit and inventory']),
  P('shopops', 'ShopOps Room', 'commerce', ['Inventory and fulfilment operations']),
  P('promise-to-proof', 'Promise to Proof', 'commerce', ['Customer commitment tracking with proof'], { integration: 'pack-backed', note: 'Commitment-safe client messages exercised by ScopeGuard and BEO Rescue.' }),
  P('tableline', 'Tableline', 'commerce', ['Uncertainty-aware availability control (never book an unverified slot)']),
  P('bangsayur', 'Bangsayur', 'commerce', ['Group-chat order intake, daily totals, delivery routes, unpaid-bill follow-up'], { folder: 'bangsayur-main', note: 'Classified from its README: a Switch group-chat agent for a neighbourhood vegetable seller.' }),
  // Consumer-resolution sources (session 13). Code was PORTED to TypeScript under src/server/capabilities/{reclaim,resolve,redeem};
  // the original Python repositories live outside this folder and were not modified. See progress.md.
  P('reclaim', 'RECLAIM', 'commerce', ['Regulatory retrieval with provenance', 'Deterministic citation verification', 'Evidence coverage per dispute'], { integration: 'pack-backed', note: 'BM25 knowledge base + citation checks ported (airlines/banking corpus rows only); exercised by the consumer-resolution pack. LLM specialist agents NOT ported.' }),
  P('resolve', 'RESOLVE', 'commerce', ['Commitment extraction from email threads', 'Deadline resolution that never invents a date', 'Exact recipient/subject/body read-back checks'], { integration: 'pack-backed', note: 'inbox_intel.py ported; send_broker guarantees map onto the RIPPLE engine (content-bound approvals, idempotency, read-back). Gmail/SMTP connectors NOT ported.' }),
  P('redeem', 'REDEEM', 'commerce', ['Consumer intake safety (OTP/payment/clinical refusals)', 'Scam indicators', 'Confirmed memory (facts proposed until the consumer confirms)'], { integration: 'pack-backed', note: 'policy/safety.py, payment_safety.py and memory/extract.py (subset) ported. Bolna voice, OCR and its own mission engine NOT ported (RIPPLE engine is the single orchestrator).' }),
  // 04 Organizational Intelligence & Decision Integrity (5)
  P('splitbrain', 'Splitbrain', 'knowledge', ['Contradictory commitment detection'], { integration: 'pack-backed', note: 'Split-brain detection exercised by the Reality Gap Engine and Cross-Domain invariants.' }),
  P('context-keeper', 'Context Keeper', 'knowledge', ['Decision and rationale memory']),
  P('kb-steward', 'KB Steward', 'knowledge', ['Knowledge-base health and outdated documents']),
  P('morning-briefing', 'Morning Briefing Room', 'knowledge', ['Scheduled operational briefings']),
  P('digest-room', 'Digest Room', 'knowledge', ['Digest of unresolved actions']),
  // 05 Personal Planning & Opportunity (4)
  P('tripcrew', 'TripCrew', 'personal', ['Source-backed travel itinerary and budget']),
  P('bounty-board', 'Bounty Board', 'personal', ['Opportunity eligibility, deadlines and rules']),
  P('hermit', 'Hermit', 'personal', ['Website monitoring with permission before sending'], { folder: 'hermit-main' }),
  P('whose-agent', 'Whose Agent?', 'personal', ['Cross-device favour delegation']),
  // 06 Creative Production (2)
  P('darkline', 'Darkline Producer', 'creative', ['Writers-room roles and production checklist']),
  P('showrunner', 'Showrunner', 'creative', ['Shared canon and revision continuity'], { folder: 'showrunner-main' }),
  // 07 Data Governance & Constraint Planning (2 classified + 1 pending)
  P('switch-data-room', 'Switch Data Room', 'data', ['Schema change detection and isolated model SQL'], { folder: 'switch-data-room-main', integration: 'pack-backed', note: 'Schema review exercised by the SchemaCourt pack.' }),
  P('cascade', 'CASCADE', 'data', ['Deterministic constraint-based replanning'], { integration: 'pack-backed', note: 'Unknown-state-is-never-success recovery is exercised by Revenue Recovery (lost response → read-back → verify without repeating).' }),
  P('rupiverse', 'RupiVerse', 'data', [], { folder: 'rupiverse-fts-hackthon-master', integration: 'pending', note: 'Source is a FastAPI + Expo scaffold exposing only GET / and GET /health. No domain capability to classify yet.' }),
];

export const SCENARIOS: Scenario[] = [
  { id: 'A', title: 'One change, independently verified, safely released', systems: ['engineering'], projects: ['countersign', 'switch-notary', 'gatekeeper', 'unseen', 'preflight', 'release-desk', 'bug-to-pr', 'agentqa', 'shipyard', 'switch-data-room'], packs: ['crewpilot'],
    steps: [{ label: 'Bug or change reported', stage: 'intake' }, { label: 'Components, dependencies and owners identified', stage: 'analysis' }, { label: 'Independent reproduction and checks', stage: 'verify' }, { label: 'Designated approver countersigns', stage: 'approval' }, { label: 'Permission-gated release', stage: 'execute' }, { label: 'Deployed version read back', stage: 'verify' }, { label: 'Closed on verified criteria', stage: 'complete' }] },
  { id: 'B', title: 'Customer request to verified business outcome', systems: ['commerce'], projects: ['deskpilot', 'orderroom', 'shopops', 'promise-to-proof', 'tableline', 'bizowl', 'bangsayur', 'reclaim', 'resolve', 'redeem'], packs: ['beo-rescue', 'scopeguard', 'invoiceguard', 'clearsend', 'consumer-resolution'],
    steps: [{ label: 'Request classified', stage: 'intake' }, { label: 'Policy, order and prior commitments checked', stage: 'analysis' }, { label: 'Manager authorises the proposed action', stage: 'approval' }, { label: 'Connector action executed', stage: 'execute' }, { label: 'Resulting status read back', stage: 'verify' }, { label: 'Commitment and audit updated', stage: 'complete' }] },
  { id: 'C', title: 'One organisational memory across all rooms', systems: ['knowledge'], projects: ['splitbrain', 'context-keeper', 'kb-steward', 'morning-briefing', 'digest-room'], packs: [],
    steps: [{ label: 'Original commitment and source retrieved', stage: 'intake' }, { label: 'Conflict detected across rooms', stage: 'analysis' }, { label: 'Authorised people decide', stage: 'approval' }, { label: 'Corrections sent through approved channels', stage: 'execute' }, { label: 'Decision preserved and re-checked for validity', stage: 'verify' }, { label: 'Unresolved items carried into the briefing', stage: 'complete' }] },
  { id: 'D', title: 'Incident to recovery to verified closure', systems: ['incident', 'data'], projects: ['opsroom', 'groundlink', 'incidentroom', 'kite', 'cascade'], packs: ['revenue-recovery', 'incident-sentinel', 'shiftrelay'],
    steps: [{ label: 'Incident received and classified', stage: 'intake' }, { label: 'Telemetry and dependencies assessed', stage: 'analysis' }, { label: 'Recovery alternative authorised', stage: 'approval' }, { label: 'Recovery executed', stage: 'execute' }, { label: 'Actual system state observed', stage: 'verify' }, { label: 'Verified close-out record', stage: 'complete' }] },
  { id: 'E', title: 'Personal missions and external monitoring', systems: ['personal'], projects: ['tripcrew', 'bounty-board', 'hermit', 'whose-agent'], packs: ['movemate', 'submitready', 'offerroom'],
    steps: [{ label: 'Personal mission template chosen', stage: 'intake' }, { label: 'Eligibility, deadlines and sources checked', stage: 'analysis' }, { label: 'User approves before anything is sent', stage: 'approval' }, { label: 'Draft or report produced', stage: 'execute' }, { label: 'Result checked against the requirement', stage: 'verify' }, { label: 'Mission closed', stage: 'complete' }] },
  { id: 'F', title: 'Creative production without losing continuity', systems: ['creative'], projects: ['darkline', 'showrunner'], packs: ['sceneshift', 'podflow'],
    steps: [{ label: 'Creative brief enters', stage: 'intake' }, { label: 'Canon and revision contradictions detected', stage: 'analysis' }, { label: 'Producer approves the revision', stage: 'approval' }, { label: 'Production checklist issued', stage: 'execute' }, { label: 'Deliverables re-checked', stage: 'verify' }, { label: 'Production closed', stage: 'complete' }] },
  { id: 'G', title: 'Data change with constraint-aware replanning', systems: ['data'], projects: ['switch-data-room', 'cascade'], packs: ['revenue-recovery', 'schemacourt'],
    steps: [{ label: 'Schema or contract change detected', stage: 'intake' }, { label: 'Dependent services and artifacts identified', stage: 'analysis' }, { label: 'Feasible plan approved', stage: 'approval' }, { label: 'Only the authorised plan executes', stage: 'execute' }, { label: 'Resulting state verified', stage: 'verify' }, { label: 'Change closed', stage: 'complete' }] },
];

export const systemOfPack = (packId: string): SystemId | null => PACK_SYSTEM[packId] ?? null;
