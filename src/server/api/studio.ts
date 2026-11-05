import type { Engine } from '../engine/engine.js';
import { nowIso } from '../db/db.js';

export interface WorkflowDef {
  id: string;
  name: string;
  category: 'financial' | 'telecom' | 'healthcare' | 'governance' | 'crossdomain';
  domain: string;
  badge: string;
  description: string;
  initialCaseId: string;
  initialCaseTitle: string;
  status: 'idle' | 'running' | 'waiting_approval' | 'completed' | 'disputed';
  currentStep: number;
  youStatus: string;
  agents: StudioAgent[];
  steps: StudioStep[];
  connections: StudioConnection[];
  tools: StudioTool[];
  timelineData?: { label: string; ranHours: number; billedHours: number; unit: string; diffHours: number };
  financialSummary?: { billed: string; supported: string; unsupported: string; currency: string; recommendation: string };
  evidenceCards: StudioEvidenceCard[];
  approvalRequest?: {
    id: string;
    title: string;
    amount: string;
    recommendedAction: string;
    alternativeAction: string;
    details: string;
    /** The action recorded for this synthetic scenario in this workspace (audit-logged; nothing is ever dispatched). */
    resolved?: 'dispute' | 'pay_in_full';
  };
}

export interface StudioAgent {
  id: string;
  key: string;
  name: string;
  role: string;
  avatar: 'crown' | 'detective' | 'chef' | 'wizard' | 'piggy' | 'scholar' | 'engineer' | 'robot' | 'shield' | 'doctor' | 'tower';
  status: 'idle' | 'investigating' | 'working' | 'waiting' | 'done' | 'failed' | 'blocked';
  taskCount: string;
  angle: number; // For radial layout (0 to 360)
  guidance: string;
  reads: string[];
  writes: string[];
  completedTasks: number;
}

export interface StudioEvidenceCard {
  id: string;
  agentKey: string;
  title: string;
  type: 'invoice' | 'rule_check' | 'timeline' | 'findings' | 'journal' | 'dispute' | 'reply' | 'specimen' | 'cdr';
  dotColor: string;
  preview: string;
  expandedData?: any;
}

export interface StudioConnection {
  id: string;
  from: string;
  to: string;
  status: 'idle' | 'active' | 'done';
  label: string;
}

export interface StudioTool {
  name: string;
  category: string;
  callCount: number;
  lastCall: string;
  mode: 'reads' | 'writes' | 'not_used';
}

export interface StudioStep {
  stepIndex: number;
  agentKey: string;
  taskTitle: string;
  actionSummary: string;
  emittedEvidence?: StudioEvidenceCard;
  handoffTo?: string;
  requiresApproval?: boolean;
}

export function getStudioWorkflows(): WorkflowDef[] {
  return [
    {
      id: 'gpu-billing',
      name: 'GPU & Cloud Billing Audit',
      category: 'financial',
      domain: 'Cloud Infrastructure & High-Performance Compute',
      badge: 'Billed After Shutdown',
      description: 'Investigates provider GPU cluster invoices against kubernetes lifecycle logs, W&B run telemetry, and contractual termination timestamps to identify post-shutdown overbilling.',
      initialCaseId: 'LAMBDA-CASE-6001',
      initialCaseTitle: 'Lambda billed 12 h after shutdown (i-hel-4471)',
      status: 'waiting_approval',
      currentStep: 3,
      youStatus: 'your call',
      timelineData: {
        label: 'Instance i-hel-4471 Runtime vs Metering',
        ranHours: 24,
        billedHours: 36,
        unit: 'hours',
        diffHours: 12
      },
      financialSummary: {
        billed: '$3,600.00',
        supported: '$2,400.00',
        unsupported: '$1,200.00',
        currency: 'USD',
        recommendation: 'Dispute $1,200.00 unsupported post-termination charge. Pay $2,400.00 authorized compute.'
      },
      approvalRequest: {
        id: 'APP-LAMBDA-6001',
        title: 'Approve vendor dispute for $1,200',
        amount: '$1,200.00',
        recommendedAction: 'Dispute $1,200 (Pay $2,400 now)',
        alternativeAction: 'Pay in full $3,600',
        details: 'Provider meter ran 12h past verified instance termination at 2026-10-15 08:00 UTC (request hel-api-req-7f3a91). Independent audit verified container teardown.'
      },
      tools: [
        { name: 'Lambda Cloud API', category: 'GPU cloud billing', callCount: 2, lastCall: 'just now', mode: 'reads' },
        { name: 'Kubernetes Cluster', category: 'Cluster events and job logs', callCount: 2, lastCall: 'just now', mode: 'reads' },
        { name: 'Weights & Biases', category: 'Experiment runs and owners', callCount: 1, lastCall: 'just now', mode: 'reads' },
        { name: 'Ironclad', category: 'Provider contracts & commitments', callCount: 1, lastCall: 'just now', mode: 'reads' },
        { name: 'CoreWeave Registry', category: 'Reserved GPU capacity', callCount: 0, lastCall: 'not used yet', mode: 'not_used' },
        { name: 'Nebius Telemetry', category: 'GPU cluster billing', callCount: 0, lastCall: 'not used yet', mode: 'not_used' },
        { name: 'Slack (#finance-ops)', category: 'Finance operations channel', callCount: 1, lastCall: '1 min ago', mode: 'writes' }
      ],
      agents: [
        {
          id: 'ag-you',
          key: 'you',
          name: 'You (Controller)',
          role: 'Human Authorization & Fiduciary Lead',
          avatar: 'crown',
          status: 'waiting',
          taskCount: 'your call',
          angle: 0,
          guidance: 'Fiduciary sign-off: authorize disputes over $1,000 before sending to provider accounting.',
          reads: ['Dispute draft', 'Audit findings', 'Timeline proof'],
          writes: ['Approval token', 'Authorized ledger entry'],
          completedTasks: 0
        },
        {
          id: 'ag-gpu-auditor',
          key: 'gpu_auditor',
          name: 'GPU Auditor',
          role: 'Instance Lifecycle & Job Auditor',
          avatar: 'detective',
          status: 'done',
          taskCount: '1 done',
          angle: 50,
          guidance: 'Cross-reference Kubernetes pod termination events with provider billing periods. Always record exact UTC timestamps.',
          reads: ['Kubernetes audit log', 'Weights & Biases API', 'Lambda invoice line items'],
          writes: ['Lifecycle timeline', 'Unsupported hour breakdown'],
          completedTasks: 1
        },
        {
          id: 'ag-cost-allocator',
          key: 'cost_allocator',
          name: 'Cost Allocator',
          role: 'Financial Reconciliation & Journal Specialist',
          avatar: 'chef',
          status: 'done',
          taskCount: '1 done',
          angle: 110,
          guidance: 'Calculate exact contractual hourly rate ($100/hr for 8x H100). Draft dual journal entry and dispute packet.',
          reads: ['GPU Auditor timeline', 'Master Services Agreement'],
          writes: ['JE-7027 credit memo', 'Dispute notice payload'],
          completedTasks: 1
        },
        {
          id: 'ag-vendor-liaison',
          key: 'vendor_liaison',
          name: 'Vendor Liaison',
          role: 'AP Communication & Settlement Agent',
          avatar: 'wizard',
          status: 'waiting',
          taskCount: 'waiting · 1 done',
          angle: 160,
          guidance: 'Maintain neutral, evidence-backed tone in provider communications. Attach machine-verifiable JSON trace.',
          reads: ['Dispute notice', 'Approved resolution'],
          writes: ['Vendor transmission receipt', 'Credit memo CM-1042'],
          completedTasks: 1
        },
        {
          id: 'ag-budget-analyst',
          key: 'budget_analyst',
          name: 'Budget Analyst',
          role: 'Departmental Budget & Burn Forecast',
          avatar: 'piggy',
          status: 'done',
          taskCount: '1 done',
          angle: 215,
          guidance: 'Monitor Frontier Language Models monthly compute spend against $520,000 allocation.',
          reads: ['General Ledger Q4', 'Projected burn rate'],
          writes: ['Variance report', 'Forecast runway'],
          completedTasks: 1
        },
        {
          id: 'ag-controls-lead',
          key: 'controls_lead',
          name: 'Controls Lead',
          role: 'Policy Compliance & Separation of Duties',
          avatar: 'scholar',
          status: 'done',
          taskCount: '1 queued · 1 done',
          angle: 270,
          guidance: 'Enforce policy ALLOC-SHARED v2. Ensure verifier has no conflicting write access to general ledger.',
          reads: ['Internal Controls Matrix', 'Role credentials'],
          writes: ['Compliance certification'],
          completedTasks: 1
        },
        {
          id: 'ag-capacity-planner',
          key: 'capacity_planner',
          name: 'Capacity Planner',
          role: 'Cluster Reservation & Sizing Agent',
          avatar: 'engineer',
          status: 'idle',
          taskCount: 'idle',
          angle: 320,
          guidance: 'Track future reservation commitments and spot price arbitrage across clusters.',
          reads: ['CoreWeave reservation schedule', 'Lambda cluster status'],
          writes: ['Cluster sizing recommendation'],
          completedTasks: 0
        }
      ],
      connections: [
        { id: 'c1', from: 'gpu_auditor', to: 'cost_allocator', status: 'done', label: 'Lifecycle Timeline & Findings' },
        { id: 'c2', from: 'cost_allocator', to: 'you', status: 'active', label: 'Dispute Approval Request ($1,200)' },
        { id: 'c3', from: 'you', to: 'vendor_liaison', status: 'idle', label: 'Fiduciary Authorization' },
        { id: 'c4', from: 'budget_analyst', to: 'cost_allocator', status: 'done', label: 'Budget Allocation Code' },
        { id: 'c5', from: 'controls_lead', to: 'you', status: 'done', label: 'Policy Check Passed (ALLOC-SHARED)' }
      ],
      evidenceCards: [
        {
          id: 'ev-inv',
          agentKey: 'gpu_auditor',
          title: 'Invoice',
          type: 'invoice',
          dotColor: '#10b981',
          preview: 'Received HEL-2026-10-118-L3 from Lambda for 8x H100 GPU cluster ($3,600.00 total for 36 hours billed).'
        },
        {
          id: 'ev-rules',
          agentKey: 'gpu_auditor',
          title: 'Rule checks',
          type: 'rule_check',
          dotColor: '#f59e0b',
          preview: 'SELECT l.quantity, l.period_start, l.period_end FROM lambda_meter WHERE instance_id="i-hel-4471" AND k8s_pod_status="TERMINATED"'
        },
        {
          id: 'ev-timeline',
          agentKey: 'gpu_auditor',
          title: 'Timeline',
          type: 'timeline',
          dotColor: '#f59e0b',
          preview: 'Meter ran 12 h past termination (Ran: 24h [08:00 UTC], Billed: 36h [20:00 UTC]).'
        },
        {
          id: 'ev-findings',
          agentKey: 'gpu_auditor',
          title: 'Findings',
          type: 'findings',
          dotColor: '#ef4444',
          preview: '$1,200.00 of $3,600.00 is NOT supported by lifecycle events or contractual commitments.'
        },
        {
          id: 'ev-je',
          agentKey: 'cost_allocator',
          title: 'JE-7027',
          type: 'journal',
          dotColor: '#10b981',
          preview: 'Posted JE-7027: Debit AP Accrual $2,400.00 · Credit Cash $2,400.00 · Holdback $1,200.00.'
        },
        {
          id: 'ev-dispute',
          agentKey: 'cost_allocator',
          title: 'Dispute',
          type: 'dispute',
          dotColor: '#10b981',
          preview: 'Drafted formal dispute notice referencing HEL-2026-10-118-L3 with K8s API audit log attachment.'
        },
        {
          id: 'ev-reply',
          agentKey: 'vendor_liaison',
          title: 'Vendor reply',
          type: 'reply',
          dotColor: '#10b981',
          preview: 'Lambda Billing Team: "Confirmed i-hel-4471 terminated at 08:00 UTC. Meter fault in us-west-2. Issued credit memo CM-1042 for $1,200.00."'
        }
      ],
      steps: [
        {
          stepIndex: 1,
          agentKey: 'gpu_auditor',
          taskTitle: 'Ingest invoice & query pod lifecycle logs',
          actionSummary: 'Extracted invoice HEL-2026-10-118-L3. Discovered container teardown occurred 12 hours before billing meter was stopped.',
          handoffTo: 'cost_allocator'
        },
        {
          stepIndex: 2,
          agentKey: 'cost_allocator',
          taskTitle: 'Calculate overbill & prepare journal entry',
          actionSummary: 'Calculated 12 unsupported hours @ $100/hr = $1,200.00 discrepancy. Prepared draft JE-7027.',
          handoffTo: 'you',
          requiresApproval: true
        },
        {
          stepIndex: 3,
          agentKey: 'you',
          taskTitle: 'Human Authorization Checkpoint',
          actionSummary: 'Awaiting controller approval to dispute $1,200 and dispatch formal dispute packet to Lambda vendor AP.'
        },
        {
          stepIndex: 4,
          agentKey: 'vendor_liaison',
          taskTitle: 'Dispatch dispute to Lambda AP & verify settlement',
          actionSummary: 'Transmitted dispute evidence. Vendor AP confirmed metering bug and issued $1,200 credit memo CM-1042.'
        }
      ]
    },
    {
      id: 'invoice-passport',
      name: 'Invoice Passport & Accounts Payable',
      category: 'financial',
      domain: 'Accounts Payable & Anti-Fraud Security',
      badge: 'Bursar 12-Agent Passport',
      description: 'Multi-agent accounts payable verification passport. Performs 12-point checks: sender DKIM, bank destination routing, PO match, duplicate detection, and insider risk.',
      initialCaseId: 'AP-INV-9921',
      initialCaseTitle: 'Apex Dynamics $42,500.00 consulting services invoice',
      status: 'waiting_approval',
      currentStep: 2,
      youStatus: 'verification hold',
      timelineData: {
        label: 'Deliverable Delivery vs Invoice Submission',
        ranHours: 120,
        billedHours: 180,
        unit: 'hours',
        diffHours: 60
      },
      financialSummary: {
        billed: '$42,500.00',
        supported: '$28,000.00',
        unsupported: '$14,500.00',
        currency: 'USD',
        recommendation: 'Place on VERIFICATION HOLD. Bank routing differs from Master Vendor Profile.'
      },
      approvalRequest: {
        id: 'APP-AP-9921',
        title: 'Confirm Payment Hold & Vendor Callback',
        amount: '$42,500.00',
        recommendedAction: 'Enforce Verification Hold (Out-of-band callback)',
        alternativeAction: 'Authorize payment override',
        details: 'Beneficiary bank routing number changed from Chase (NY) to First Digital Bank (Delaware). Out-of-band voice verification mandatory under AP-SEC-04.'
      },
      tools: [
        { name: 'ERP Master Vendor Table', category: 'Vendor master records', callCount: 3, lastCall: 'just now', mode: 'reads' },
        { name: 'FedACH Routing Directory', category: 'Bank validation', callCount: 1, lastCall: 'just now', mode: 'reads' },
        { name: 'Email Header Inspector', category: 'DKIM / SPF auth', callCount: 1, lastCall: '2 mins ago', mode: 'reads' },
        { name: 'Jira Worklogs', category: 'Timesheet verification', callCount: 4, lastCall: 'just now', mode: 'reads' },
        { name: 'AP Disbursement Engine', category: 'Payment gateway', callCount: 0, lastCall: 'held', mode: 'writes' }
      ],
      agents: [
        {
          id: 'ag-you',
          key: 'you',
          name: 'You (AP Lead)',
          role: 'Disbursement Authorization',
          avatar: 'crown',
          status: 'waiting',
          taskCount: 'hold decision',
          angle: 0,
          guidance: 'Never release funds when bank routing fails FedACH or master vendor verification without 2-person verbal sign-off.',
          reads: ['Vendor Passport', 'Bank Routing Diff'],
          writes: ['Release Token / Hold Order'],
          completedTasks: 0
        },
        {
          id: 'ag-auth',
          key: 'auth_agent',
          name: 'Sender Auth Agent',
          role: 'Cryptographic Email & Domain Validator',
          avatar: 'shield',
          status: 'done',
          taskCount: '1 done',
          angle: 60,
          guidance: 'Verify SPF, DKIM 2048-bit keys and DMARC alignment on all inbound supplier invoices.',
          reads: ['Inbound MIME headers'],
          writes: ['Cryptographic verification score'],
          completedTasks: 1
        },
        {
          id: 'ag-bank',
          key: 'bank_agent',
          name: 'Bank Destination Agent',
          role: 'Routing Transit & Beneficiary Examiner',
          avatar: 'robot',
          status: 'done',
          taskCount: '1 done',
          angle: 120,
          guidance: 'Compare ACH routing transit number with historical approved disbursements.',
          reads: ['FedACH API', 'Disbursement ledger'],
          writes: ['Routing change alert: HIGH RISK'],
          completedTasks: 1
        },
        {
          id: 'ag-po',
          key: 'po_agent',
          name: 'PO Matcher',
          role: 'Three-Way Matching Specialist',
          avatar: 'scholar',
          status: 'done',
          taskCount: '1 done',
          angle: 180,
          guidance: 'Check invoice line item rates against approved purchase order PO-8891.',
          reads: ['Purchase Order PO-8891', 'Receiving slip'],
          writes: ['Match variance report ($0.00 variance)'],
          completedTasks: 1
        },
        {
          id: 'ag-passport',
          key: 'passport_agent',
          name: 'Passport Assembler',
          role: 'Evidence Cryptographic Stitcher',
          avatar: 'wizard',
          status: 'done',
          taskCount: '1 done',
          angle: 240,
          guidance: 'Aggregate 12 agent findings into immutable tamper-proof Invoice Passport.',
          reads: ['All agent telemetry'],
          writes: ['Signed Passport #PASSPORT-9921-HELD'],
          completedTasks: 1
        },
        {
          id: 'ag-risk',
          key: 'risk_agent',
          name: 'Insider Risk Agent',
          role: 'Behavioral Anomaly & Collusion Detector',
          avatar: 'detective',
          status: 'done',
          taskCount: '1 done',
          angle: 300,
          guidance: 'Inspect invoice submitter employee relationships and recent master vendor edits.',
          reads: ['ERP audit trail', 'HR Directory'],
          writes: ['No insider risk detected'],
          completedTasks: 1
        }
      ],
      connections: [
        { id: 'c1', from: 'auth_agent', to: 'passport_agent', status: 'done', label: 'DKIM Valid (Pass)' },
        { id: 'c2', from: 'bank_agent', to: 'passport_agent', status: 'done', label: 'Routing Mismatch (FAIL)' },
        { id: 'c3', from: 'po_agent', to: 'passport_agent', status: 'done', label: '3-Way Match 100%' },
        { id: 'c4', from: 'passport_agent', to: 'you', status: 'active', label: 'Passport Status: HELD' }
      ],
      evidenceCards: [
        {
          id: 'ev-inv-apex',
          agentKey: 'auth_agent',
          title: 'Invoice',
          type: 'invoice',
          dotColor: '#10b981',
          preview: 'Apex Dynamics Invoice #AD-4091 ($42,500.00, Net-30).'
        },
        {
          id: 'ev-dkim',
          agentKey: 'auth_agent',
          title: 'Rule checks',
          type: 'rule_check',
          dotColor: '#10b981',
          preview: 'DKIM d=apexdynamics.com (PASS) · SPF ip4:198.51.100.24 (PASS) · TLS 1.3 encrypted.'
        },
        {
          id: 'ev-routing',
          agentKey: 'bank_agent',
          title: 'Findings',
          type: 'findings',
          dotColor: '#ef4444',
          preview: 'CRITICAL: Account 021000021 (Chase) swapped to 122000496 (First Digital Bank, DE). Change requested 48h prior.'
        },
        {
          id: 'ev-passport-doc',
          agentKey: 'passport_agent',
          title: 'Passport',
          type: 'findings',
          dotColor: '#f59e0b',
          preview: 'Passport #9921: 11 Passed, 1 FAILED (Bank Destination). Status: DISBURSEMENT_HOLD.'
        }
      ],
      steps: [
        {
          stepIndex: 1,
          agentKey: 'auth_agent',
          taskTitle: 'Verify email signature & PO alignment',
          actionSummary: 'Cryptographic authentication passed. PO-8891 milestone 3 verified.',
          handoffTo: 'bank_agent'
        },
        {
          stepIndex: 2,
          agentKey: 'bank_agent',
          taskTitle: 'Inspect beneficiary destination',
          actionSummary: 'Discovered unauthorized wire destination substitution. Flagged for fiduciary freeze.',
          handoffTo: 'you',
          requiresApproval: true
        }
      ]
    },
    {
      id: 'vendor-bank-change',
      name: 'Vendor Bank-Change Investigation',
      category: 'financial',
      domain: 'Fraud Prevention & Wire Security',
      badge: 'Adversarial Email Defense',
      description: 'Zero-trust forensic analysis of vendor wire modification requests. Uses historical ledger analysis, SPF/DKIM validation, and verified phone channel out-of-band authentication.',
      initialCaseId: 'WIRE-CHG-804',
      initialCaseTitle: 'Urgent Wire Instructions Update: Horizon Media Corp',
      status: 'waiting_approval',
      currentStep: 2,
      youStatus: 'frozen profile',
      financialSummary: {
        billed: '$180,000.00',
        supported: '$0.00',
        unsupported: '$180,000.00',
        currency: 'USD',
        recommendation: 'REJECT wire change request. Adversarial email impersonation detected from spoofed lookalike domain.'
      },
      approvalRequest: {
        id: 'APP-WIRE-804',
        title: 'Freeze Vendor Profile & Send Security Notice',
        amount: '$180,000.00',
        recommendedAction: 'Freeze Vendor Profile (Fraud alert confirmed)',
        alternativeAction: 'Request additional documentation',
        details: 'Inbound request originated from "horizon-mediacorp.com" (punycode registered 3 days ago in Reykjavik). Target bank in Cyprus.'
      },
      tools: [
        { name: 'WHOIS & Domain Registrar', category: 'Domain age analysis', callCount: 2, lastCall: 'just now', mode: 'reads' },
        { name: 'Out-of-band Twilio Voice', category: 'Authorized vendor callback', callCount: 1, lastCall: 'just now', mode: 'reads' },
        { name: 'Treasury Wire Ledger', category: 'Payment hold controller', callCount: 1, lastCall: 'just now', mode: 'writes' }
      ],
      agents: [
        { id: 'ag-you', key: 'you', name: 'You (Fraud Lead)', role: 'Fiduciary Wire Authority', avatar: 'crown', status: 'waiting', taskCount: 'action required', angle: 0, guidance: 'Zero trust: do not accept telephone numbers printed in request emails.', reads: ['Domain dossier', 'Forensic analysis'], writes: ['Profile freeze order'], completedTasks: 0 },
        { id: 'ag-email', key: 'email_agent', name: 'Adversarial Email Analyst', role: 'Domain & Header Forensic Specialist', avatar: 'detective', status: 'done', taskCount: '1 done', angle: 90, guidance: 'Detect typosquatting, homoglyphs and suspicious registrar changes.', reads: ['Email headers', 'WHOIS'], writes: ['Lookalike domain verdict: MALICIOUS'], completedTasks: 1 },
        { id: 'ag-hist', key: 'hist_agent', name: 'Historical Ledger Auditor', role: 'Vendor Payment History', avatar: 'scholar', status: 'done', taskCount: '1 done', angle: 180, guidance: 'Review last 36 months of settlements.', reads: ['ERP AP ledger'], writes: ['Historical baseline: US Domestic Wells Fargo'], completedTasks: 1 },
        { id: 'ag-contact', key: 'contact_agent', name: 'Trusted Contact Agent', role: 'Out-of-band Callback Verification', avatar: 'wizard', status: 'done', taskCount: '1 done', angle: 270, guidance: 'Initiate call to corporate CFO listed in original master agreement.', reads: ['Original Master Agreement'], writes: ['CFO verified: No bank change requested! Fraud confirmed.'], completedTasks: 1 }
      ],
      connections: [
        { id: 'c1', from: 'email_agent', to: 'you', status: 'done', label: 'Domain Age: 3 Days (Flagged)' },
        { id: 'c2', from: 'contact_agent', to: 'you', status: 'active', label: 'CFO Confirms Impersonation' }
      ],
      evidenceCards: [
        { id: 'ev-wire-em', agentKey: 'email_agent', title: 'Invoice', type: 'invoice', dotColor: '#ef4444', preview: 'Inbound message from billing@horizon-medìacorp.com claiming urgent invoice settlement to Cyprus bank.' },
        { id: 'ev-wire-whois', agentKey: 'email_agent', title: 'Rule checks', type: 'rule_check', dotColor: '#ef4444', preview: 'WHOIS: Domain created 2026-11-01 via NameCheap anonymity proxy. IP routed through Reykjavik VPN.' },
        { id: 'ev-wire-voice', agentKey: 'contact_agent', title: 'Findings', type: 'findings', dotColor: '#10b981', preview: 'Verified CFO callback (+1-212-555-0199): Horizon Media has NOT changed banking partners.' }
      ],
      steps: [
        { stepIndex: 1, agentKey: 'email_agent', taskTitle: 'Forensic domain analysis', actionSummary: 'Homoglyph domain detected. Spoofed identity flagged.', handoffTo: 'contact_agent' },
        { stepIndex: 2, agentKey: 'contact_agent', taskTitle: 'Authorized callback verification', actionSummary: 'CFO confirmed ongoing BEC attack. Prompted freeze.', handoffTo: 'you', requiresApproval: true }
      ]
    },
    {
      id: 'sla-dispute',
      name: 'Financial Dispute & SLA Credit',
      category: 'financial',
      domain: 'Cloud Services & Contract Arbitration',
      badge: 'GroundTruth Telemetry Audit',
      description: 'Arbitrates multi-tier SLA contract violations using synthetic network probes, Datadog outage traces, and contractual penalty tiers to generate binding SLA credit deductions.',
      initialCaseId: 'SLA-DISP-440',
      initialCaseTitle: 'Tier-1 Database 4.2h Outage SLA Credit Claim',
      status: 'waiting_approval',
      currentStep: 2,
      youStatus: 'credit ready',
      timelineData: {
        label: 'Contractual 99.99% Uptime vs Actual Monthly Service',
        ranHours: 715.8,
        billedHours: 720.0,
        unit: 'hours',
        diffHours: 4.2
      },
      financialSummary: {
        billed: '$142,000.00',
        supported: '$113,600.00',
        unsupported: '$28,400.00',
        currency: 'USD',
        recommendation: 'Execute 20% SLA credit ($28,400.00) against current master invoice per Section 9.2.'
      },
      approvalRequest: {
        id: 'APP-SLA-440',
        title: 'Approve $28,400.00 Contractual SLA Credit Memo',
        amount: '$28,400.00',
        recommendedAction: 'Deduct $28,400.00 SLA credit from next wire',
        alternativeAction: 'Defer to quarterly vendor arbitration',
        details: 'Outage duration: 252 minutes (availability fell to 99.41% vs 99.99% SLA commitment). Tier 3 contractual credit triggered.'
      },
      tools: [
        { name: 'Datadog Synthetic Monitoring', category: 'API Telemetry', callCount: 4, lastCall: 'just now', mode: 'reads' },
        { name: 'Contract Repository (Ironclad)', category: 'Legal SLA clauses', callCount: 1, lastCall: 'just now', mode: 'reads' },
        { name: 'Billing Reconciliation Portal', category: 'Credit memo issuer', callCount: 1, lastCall: 'waiting', mode: 'writes' }
      ],
      agents: [
        { id: 'ag-you', key: 'you', name: 'You (Contract Owner)', role: 'Contractual Enforcement Lead', avatar: 'crown', status: 'waiting', taskCount: 'sign-off required', angle: 0, guidance: 'Confirm calculated credit complies with 30-day reporting window in Master Agreement.', reads: ['Telemetry audit', 'Credit formula'], writes: ['Executed SLA credit deduction'], completedTasks: 0 },
        { id: 'ag-telem', key: 'telemetry_agent', name: 'Telemetry Analyst', role: 'Outage & Performance Auditor', avatar: 'detective', status: 'done', taskCount: '1 done', angle: 90, guidance: 'Filter external network outages from provider-confirmed 5xx HTTP server response periods.', reads: ['Datadog API', 'StatusPage Webhooks'], writes: ['Exact downtime duration: 252 mins'], completedTasks: 1 },
        { id: 'ag-calc', key: 'calc_agent', name: 'Credit Calculator', role: 'Deterministic Penalty Modeler', avatar: 'chef', status: 'done', taskCount: '1 done', angle: 180, guidance: 'Apply Section 9.2 formula: <99.5% availability = 20% billing credit.', reads: ['Ironclad SLA Section 9.2'], writes: ['Binding credit amount: $28,400.00'], completedTasks: 1 },
        { id: 'ag-conf', key: 'verifier_agent', name: 'Independent Verifier', role: 'Contradiction & Evidence Reviewer', avatar: 'robot', status: 'done', taskCount: '1 done', angle: 270, guidance: 'Challenge telemetry to ensure client DNS failure did not contribute to outage.', reads: ['BGP route telemetry'], writes: ['Verified: 100% provider server-side culpability'], completedTasks: 1 }
      ],
      connections: [
        { id: 'c1', from: 'telemetry_agent', to: 'calc_agent', status: 'done', label: '252 Mins Confirmed Downtime' },
        { id: 'c2', from: 'calc_agent', to: 'verifier_agent', status: 'done', label: '20% Rate Calculation' },
        { id: 'c3', from: 'verifier_agent', to: 'you', status: 'active', label: 'Evidence Verified: Ready to Execute' }
      ],
      evidenceCards: [
        { id: 'ev-sla-log', agentKey: 'telemetry_agent', title: 'Timeline', type: 'timeline', dotColor: '#ef4444', preview: 'Oct 12 14:10-18:22 UTC: 503 Service Unavailable returned across all us-east-1 availability zones.' },
        { id: 'ev-sla-sec', agentKey: 'calc_agent', title: 'Rule checks', type: 'rule_check', dotColor: '#10b981', preview: 'Clause 9.2.3: "If monthly uptime is between 99.0% and 99.5%, customer receives 20% credit on monthly fee."' },
        { id: 'ev-sla-memo', agentKey: 'calc_agent', title: 'Findings', type: 'findings', dotColor: '#10b981', preview: 'Base monthly charge $142,000.00 × 20% = $28,400.00 contractual credit.' }
      ],
      steps: [
        { stepIndex: 1, agentKey: 'telemetry_agent', taskTitle: 'Ingest and cross-correlate telemetry', actionSummary: 'Validated 252 minutes of verified database unavailability.', handoffTo: 'calc_agent' },
        { stepIndex: 2, agentKey: 'calc_agent', taskTitle: 'Calculate SLA credit tier', actionSummary: 'Determined tier 3 credit threshold reached. Drafted credit memo.', handoffTo: 'you', requiresApproval: true }
      ]
    },
    {
      id: 'healthcare-clinical',
      name: 'Clinical Trial Specimen & Supply Chain Reconciliation',
      category: 'healthcare',
      domain: 'Biotech & Clinical Operations',
      badge: 'Cold-Chain Integrity Audit',
      description: 'End-to-end multi-agent audit of investigational oncology drug cohorts during transatlantic transit. Detects temperature excursions, audits continuous data-loggers, and validates chain-of-custody protocols.',
      initialCaseId: 'CLIN-EXC-109',
      initialCaseTitle: 'Investigational Drug Batch LOT-884 Temperature Excursion',
      status: 'waiting_approval',
      currentStep: 2,
      youStatus: 'quarantine decision',
      timelineData: {
        label: 'Cryo-Container Stability Spec (-20°C ± 2°C) vs Logged Temperature',
        ranHours: 72,
        billedHours: 72,
        unit: 'hours',
        diffHours: 0
      },
      financialSummary: {
        billed: '$380,000.00',
        supported: '$0.00',
        unsupported: '$380,000.00',
        currency: 'USD',
        recommendation: 'QUARANTINE batch LOT-884 immediately. Temperature reached +8.4°C for 38 minutes during tarmac transit in Frankfurt.'
      },
      approvalRequest: {
        id: 'APP-CLIN-109',
        title: 'Issue Batch Quarantine & Dispatch Replacement Cohort',
        amount: '$380,000.00',
        recommendedAction: 'Quarantine LOT-884 & Release Backup Depot Lot',
        alternativeAction: 'Authorize extended stability re-testing',
        details: 'Excursion exceeded 30-minute critical threshold by 8 minutes. GCP regulatory compliance requires immediate quarantine to protect patient safety.'
      },
      tools: [
        { name: 'Sensitech Cryo-Logger IoT', category: 'Temperature telemetry', callCount: 3, lastCall: 'just now', mode: 'reads' },
        { name: 'FDA 21 CFR Part 11 Audit Trail', category: 'Compliance ledger', callCount: 2, lastCall: 'just now', mode: 'reads' },
        { name: 'Clinical Trial ERP (Veeva)', category: 'Inventory management', callCount: 1, lastCall: 'waiting', mode: 'writes' }
      ],
      agents: [
        { id: 'ag-you', key: 'you', name: 'You (Medical Director)', role: 'Patient Safety & Trial Integrity Lead', avatar: 'crown', status: 'waiting', taskCount: 'safety decision', angle: 0, guidance: 'Zero tolerance for unverified biological potency in phase III clinical cohorts.', reads: ['Excursion curve', 'Stability model'], writes: ['Quarantine order'], completedTasks: 0 },
        { id: 'ag-cold', key: 'cold_chain', name: 'Cold-Chain Auditor', role: 'IoT Data Logger Forensic Specialist', avatar: 'detective', status: 'done', taskCount: '1 done', angle: 90, guidance: 'Decode NIST-traceable sensor logs and identify exact breach intervals.', reads: ['Sensitech IoT dump'], writes: ['Excursion profile: Peak +8.4°C'], completedTasks: 1 },
        { id: 'ag-reg', key: 'reg_agent', name: 'Regulatory Verifier', role: 'GCP & Protocol Compliance Lead', avatar: 'doctor', status: 'done', taskCount: '1 done', angle: 180, guidance: 'Check IND investigational brochure stability parameters.', reads: ['FDA IND dossier', 'Stability Matrix'], writes: ['Protocol Breach: Exceeded 30-min window'], completedTasks: 1 },
        { id: 'ag-log', key: 'logistics_agent', name: 'Clinical Depot Liaison', role: 'Secondary Supply Dispatcher', avatar: 'wizard', status: 'done', taskCount: '1 done', angle: 270, guidance: 'Prepare immediate dispatch of qualified backup lot LOT-885 from Geneva depot.', reads: ['Geneva inventory'], writes: ['Ready for dispatch upon sign-off'], completedTasks: 1 }
      ],
      connections: [
        { id: 'c1', from: 'cold_chain', to: 'reg_agent', status: 'done', label: 'Logged Peak: +8.4°C' },
        { id: 'c2', from: 'reg_agent', to: 'you', status: 'active', label: 'Protocol Violation: Safety Hold' },
        { id: 'c3', from: 'logistics_agent', to: 'you', status: 'done', label: 'Backup Lot Available (Geneva)' }
      ],
      evidenceCards: [
        { id: 'ev-temp-curve', agentKey: 'cold_chain', title: 'Timeline', type: 'timeline', dotColor: '#ef4444', preview: 'Sensor #T-992: Temperature climbed from -19.8°C to +8.4°C at 11:42 UTC during ramp transfer at Frankfurt Cargo.' },
        { id: 'ev-fda-spec', agentKey: 'reg_agent', title: 'Rule checks', type: 'rule_check', dotColor: '#ef4444', preview: 'Trial Protocol Section 7.4.1: "Excursion > 0°C permitted for maximum of 30 minutes cumulative. Current: 38 minutes."' },
        { id: 'ev-quarantine-order', agentKey: 'reg_agent', title: 'Findings', type: 'findings', dotColor: '#ef4444', preview: 'Recommendation: Quarantined under 21 CFR 312.62. Do NOT administer to patients.' }
      ],
      steps: [
        { stepIndex: 1, agentKey: 'cold_chain', taskTitle: 'Ingest cold chain telemetry', actionSummary: 'Identified 38-minute thermal breach above critical threshold.', handoffTo: 'reg_agent' },
        { stepIndex: 2, agentKey: 'reg_agent', taskTitle: 'Evaluate stability protocol', actionSummary: 'Confirmed protocol violation. Prepared quarantine order.', handoffTo: 'you', requiresApproval: true }
      ]
    },
    {
      id: 'telecom-cdr',
      name: 'Telecom CDR & Roaming Billing Mediation',
      category: 'telecom',
      domain: 'Telecommunications & Carrier Settlement',
      badge: 'GSMA TAP3 Mediation',
      description: 'Arbitrates cross-border 5G roaming data transfers between telecommunications carriers. Validates call detail record (CDR) timestamps, eliminates phantom traffic, and reconciles TAP3 exchange files.',
      initialCaseId: 'TEL-CDR-902',
      initialCaseTitle: 'Carrier Roaming Exchange Billing Mismatch (DE-Frankfurt vs UK-London)',
      status: 'waiting_approval',
      currentStep: 2,
      youStatus: 'settlement review',
      financialSummary: {
        billed: '$340,000.00',
        supported: '$271,600.00',
        unsupported: '$68,400.00',
        currency: 'EUR',
        recommendation: 'Withhold €68,400.00 overcharge. 4,200 phantom data sessions recorded after GTP tunnel teardown.'
      },
      approvalRequest: {
        id: 'APP-TEL-902',
        title: 'Authorize Carrier Dispute Settlement Offset of €68,400',
        amount: '€68,400.00',
        recommendedAction: 'Execute €68,400 dispute offset per GSMA TD.57',
        alternativeAction: 'Pay full clearinghouse balance',
        details: 'GTP tunnel teardown in carrier SGSN occurred at 03:14:22 CET. Partner switch continued metering data until 06:00:00 CET due to lost GTP-C Echo message.'
      },
      tools: [
        { name: 'GSMA TAP3 Clearinghouse', category: 'Wholesale CDR exchange', callCount: 3, lastCall: 'just now', mode: 'reads' },
        { name: '5G Core SMF/UPF Telemetry', category: 'Session management logs', callCount: 4, lastCall: 'just now', mode: 'reads' },
        { name: 'Carrier Clearing Gateway', category: 'Settlement ledger', callCount: 1, lastCall: 'waiting', mode: 'writes' }
      ],
      agents: [
        { id: 'ag-you', key: 'you', name: 'You (Settlement Director)', role: 'Carrier Wholesale Fiduciary', avatar: 'crown', status: 'waiting', taskCount: 'settlement call', angle: 0, guidance: 'Enforce GSMA TD.57 dispute protocol timelines within 60 days of TAP3 exchange.', reads: ['CDR Discrepancy Matrix'], writes: ['Dispute Offset Order'], completedTasks: 0 },
        { id: 'ag-cdr', key: 'cdr_agent', name: 'CDR Parser Agent', role: 'TAP3 & Diameter Record Matcher', avatar: 'tower', status: 'done', taskCount: '1 done', angle: 90, guidance: 'Compare incoming TAP3 file records with local 5G user plane function (UPF) session logs.', reads: ['TAP3 files', 'UPF session dump'], writes: ['Discrepancy: 4,200 phantom sessions'], completedTasks: 1 },
        { id: 'ag-rate', key: 'rate_agent', name: 'Wholesale Rate Reconciler', role: 'Interconnect Tariff Calculator', avatar: 'chef', status: 'done', taskCount: '1 done', angle: 180, guidance: 'Apply agreed roaming tariff of €0.012 per Megabyte.', reads: ['Carrier Interconnect Agreement'], writes: ['Overcharge calculated: €68,400.00'], completedTasks: 1 },
        { id: 'ag-fraud', key: 'fraud_telecom', name: 'SIM-Box & Bypass Auditor', role: 'Interconnect Fraud Examiner', avatar: 'shield', status: 'done', taskCount: '1 done', angle: 270, guidance: 'Ensure traffic does not exhibit SIM-box bypass or automated toll-fraud patterns.', reads: ['Call duration distribution'], writes: ['Traffic verified clean: Technical metering fault only'], completedTasks: 1 }
      ],
      connections: [
        { id: 'c1', from: 'cdr_agent', to: 'rate_agent', status: 'done', label: '5.7 TB Phantom Volume Flagged' },
        { id: 'c2', from: 'rate_agent', to: 'you', status: 'active', label: '€68,400 Overcharge Calculated' },
        { id: 'c3', from: 'fraud_telecom', to: 'you', status: 'done', label: 'No Toll Fraud: Technical Fault' }
      ],
      evidenceCards: [
        { id: 'ev-tap3', agentKey: 'cdr_agent', title: 'Invoice', type: 'invoice', dotColor: '#10b981', preview: 'TAP3 Clearing Batch #2026-W44: Total claimed roaming €340,000.00 across 2.4M subscriber data sessions.' },
        { id: 'ev-gtp-log', agentKey: 'cdr_agent', title: 'Rule checks', type: 'rule_check', dotColor: '#ef4444', preview: 'GTP-C Session Release confirmed by Core SMF at 03:14:22 CET. Partner switch recorded data sessions until 06:00:00 CET.' },
        { id: 'ev-tel-findings', agentKey: 'rate_agent', title: 'Findings', type: 'findings', dotColor: '#ef4444', preview: '5.7 TB unaccounted volume × €0.012/MB = €68,400.00 dispute offset prepared.' }
      ],
      steps: [
        { stepIndex: 1, agentKey: 'cdr_agent', taskTitle: 'Ingest TAP3 & match session logs', actionSummary: 'Identified 4,200 orphaned sessions continued past tunnel teardown.', handoffTo: 'rate_agent' },
        { stepIndex: 2, agentKey: 'rate_agent', taskTitle: 'Calculate wholesale offset', actionSummary: 'Prepared €68,400 dispute offset for carrier arbitration.', handoffTo: 'you', requiresApproval: true }
      ]
    }
  ];
}

/**
 * Studio routes. IMPORTANT: the workflow definitions above are *synthetic, labelled demo
 * scenarios* — they are not engine missions. These routes therefore only (a) serve real,
 * measured telemetry from the running engine/database and (b) record demo decisions and
 * guidance to the audit ledger. Nothing here dispatches, pays, emails or contacts anyone.
 */

// Recorded demo decisions / guidance are in-memory per workspace (process lifetime) and
// always mirrored into the audited ledger. They intentionally never touch engine state.
const studioDecisions = new Map<string, 'dispute' | 'pay_in_full'>();
const studioGuidance = new Map<string, string>();

export function registerStudioRoutes(app: any, engine: Engine) {
  // ---- real, measured helpers (no fabricated numbers) ----
  const dbBytes = (): number => {
    const pc = engine.db.get('PRAGMA page_count') as any;
    const ps = engine.db.get('PRAGMA page_size') as any;
    return Number(pc?.page_count ?? 0) * Number(ps?.page_size ?? 0);
  };
  /** Workspace-scoped counts from the real ledger. Never queries tenant tables without a workspace id. */
  const ledgerCounts = (ws: string) => {
    const n = (sql: string, ...p: any[]) => Number((engine.db.get(sql, ...p) as any)?.n ?? 0);
    return {
      missions: n('SELECT count(*) n FROM missions WHERE workspace_id=?', ws),
      activeMissions: n("SELECT count(*) n FROM missions WHERE workspace_id=? AND state NOT IN ('completed','cancelled')", ws),
      openWorkItems: n("SELECT count(*) n FROM work_items WHERE workspace_id=? AND status!='done'", ws),
      agentRuns: n('SELECT count(*) n FROM agent_runs WHERE workspace_id=?', ws),
      pendingApprovals: n("SELECT count(*) n FROM approvals WHERE workspace_id=? AND status='pending'", ws),
      openQuestions: n("SELECT count(*) n FROM questions WHERE workspace_id=? AND status='open'", ws),
      verifiedActions: n("SELECT count(*) n FROM actions WHERE workspace_id=? AND status='verified'", ws),
      evidenceRecords: n('SELECT count(*) n FROM evidence WHERE workspace_id=?', ws),
      auditEvents: n('SELECT count(*) n FROM audit_events WHERE workspace_id=?', ws)
    };
  };
  const fmtBytes = (b: number) =>
    b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  // GET /api/studio/workflows — synthetic demo scenarios, merged with decisions/guidance recorded in THIS workspace
  app.get('/api/studio/workflows', (c: any) => {
    const actor = c.get('actor');
    const ws = actor.workspaceId;
    const workflows = getStudioWorkflows().map((w) => ({
      ...w,
      agents: w.agents.map((a) => ({ ...a, guidance: studioGuidance.get(`${ws}|${w.id}|${a.key}`) ?? a.guidance })),
      approvalRequest: w.approvalRequest
        ? { ...w.approvalRequest, resolved: studioDecisions.get(`${ws}|${w.id}`) }
        : undefined
    }));
    return c.json({
      workflows,
      note: 'Synthetic demo scenarios. Approvals are recorded to the audit ledger only — nothing is dispatched, paid or sent.'
    });
  });

  // POST /api/studio/workflows/:id/approve — records the human decision for a demo scenario (audit-logged; NO side effects)
  app.post('/api/studio/workflows/:id/approve', async (c: any) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const action = body?.action;
    if (action !== 'dispute' && action !== 'pay_in_full') {
      return c.json({ error: { code: 'invalid_action', message: "action must be 'dispute' or 'pay_in_full'." } }, 422);
    }
    if (!getStudioWorkflows().some((w) => w.id === id)) {
      return c.json({ error: { code: 'not_found', message: 'Unknown studio workflow.' } }, 404);
    }
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : 'Recorded via Studio';
    const actor = c.get('actor');
    studioDecisions.set(`${actor.workspaceId}|${id}`, action);
    engine.audit(
      actor.workspaceId, null, 'user', actor.name, 'studio_approval_resolved',
      `Workflow ${id}: ${action} decided (synthetic demo scenario; decision recorded only, nothing dispatched). Note: ${note}`
    );
    return c.json({
      ok: true,
      workflowId: id,
      action,
      resolvedAt: nowIso(),
      message: 'Decision recorded in the audit ledger. Synthetic demo scenario — no dispute was sent, no payment was made.'
    });
  });

  // POST /api/studio/workflows/:id/guidance — saves demo agent guidance (audit-logged; not injected into analyzer runs)
  app.post('/api/studio/workflows/:id/guidance', async (c: any) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const agentKey = body?.agentKey;
    const guidance = typeof body?.guidance === 'string' ? body.guidance.slice(0, 2000) : '';
    const wf = getStudioWorkflows().find((w) => w.id === id);
    if (!wf || !wf.agents.some((a) => a.key === agentKey)) {
      return c.json({ error: { code: 'not_found', message: 'Unknown studio workflow or agent.' } }, 404);
    }
    const actor = c.get('actor');
    studioGuidance.set(`${actor.workspaceId}|${id}|${agentKey}`, guidance);
    engine.audit(
      actor.workspaceId, null, 'user', actor.name, 'studio_guidance_updated',
      `Workflow ${id} agent ${agentKey} guidance updated (demo; not injected into analyzer runs): "${guidance.slice(0, 80)}..."`
    );
    return c.json({
      ok: true, workflowId: id, agentKey, guidance, savedAt: nowIso(),
      message: 'Saved for this demo scenario and recorded in the audit ledger. It is not injected into analyzer runs.'
    });
  });

  // GET /api/studio/telemetry — REAL live server/engine metrics (measured at request time)
  app.get('/api/studio/telemetry', (c: any) => {
    const actor = c.get('actor');
    const t0 = performance.now();
    const counts = ledgerCounts(actor.workspaceId);
    const metricsQueryMs = +(performance.now() - t0).toFixed(1);
    return c.json({
      checkedAt: nowIso(),
      uptimeSeconds: Math.floor(process.uptime()),
      dbBytes: dbBytes(),
      counts,
      provider: { name: engine.provider.name, kind: engine.provider.kind },
      packs: engine.packs.listings().length,
      collab: engine.collab.describe(),
      metricsQueryMs
    });
  });

  // GET /api/studio/infrastructure — real runtime facts; no fabricated latencies or health scores
  app.get('/api/studio/infrastructure', (c: any) => {
    const actor = c.get('actor');
    const t0 = performance.now();
    const counts = ledgerCounts(actor.workspaceId);
    const servedInMs = +(performance.now() - t0).toFixed(1);
    const bytes = dbBytes();
    const connectors = Object.values(engine.connectors) as any[];
    const connectorWorkload = connectors.length
      ? connectors.map((k) => `${k.name} (${k.mode})`).join(' · ')
      : 'none configured';

    const nodes = [
      {
        id: 'web-client',
        name: 'RIPPLE Web Application',
        role: 'React client — renders server read models, no business logic',
        category: 'client',
        status: 'online',
        workload: `Authenticated session: ${actor.name}`,
        env: 'Browser (this request)',
        details: '"Online" reflects this authenticated request; the UI is served by the API server below.'
      },
      {
        id: 'hono-api',
        name: 'Hono API Gateway & Server',
        role: 'Session-authenticated HTTP API + read models',
        category: 'server',
        status: 'online',
        workload: `Served this response in ${servedInMs} ms (ledger queries measured)`,
        env: `Node.js ${process.version}`,
        details: 'Same-origin JSON with CSRF defence in depth; studio telemetry counts are measured in real time.'
      },
      {
        id: 'agent-orchestrator',
        name: 'Mission Engine (Orchestrator)',
        role: 'State machine, baselines, changes, approvals, actions, verification',
        category: 'orchestrator',
        status: 'online',
        workload: `${counts.activeMissions} active / ${counts.missions} missions · ${counts.agentRuns} agent runs · ${counts.verifiedActions} verified actions`,
        env: 'RIPPLE engine (pack-agnostic)',
        details: 'All state changes go through Engine.transition() and are audited.'
      },
      {
        id: 'sqlite-ledger',
        name: 'SQLite Database & Evidence Ledger',
        role: 'Authoritative state & audit store',
        category: 'database',
        status: 'online',
        workload: `WAL mode · ${fmtBytes(bytes)} · ${counts.evidenceRecords} evidence · ${counts.auditEvents} audit events`,
        env: 'node:sqlite (experimental)',
        details: 'Every tenant row is workspace-scoped; studio counts are filtered by workspace.'
      },
      {
        id: 'inference-provider',
        name: `Analyzer Provider — ${engine.provider.name}`,
        role: 'Deterministic analyzers (model wording optional, labelled)',
        category: 'inference',
        status: 'online',
        workload: `${engine.provider.kind} mode`,
        env: engine.provider.name,
        details: 'Deterministic vs model output stays distinguishable; agents never certify human-only decisions.'
      },
      {
        id: 'external-connectors',
        name: 'Sandboxed Connectors & Outbox',
        role: 'Local dry-run external adapters',
        category: 'connectors',
        status: 'online',
        workload: connectorWorkload,
        env: 'File-backed local outbox',
        details: 'Dry-run only: nothing is emailed, posted, paid, uploaded or submitted anywhere.'
      }
    ];

    return c.json({
      status: 'ok',
      checkedAt: nowIso(),
      uptimeSeconds: Math.floor(process.uptime()),
      dbBytes: bytes,
      counts,
      nodes
    });
  });
}
