# Demo Runbook: Exploring the RIPPLE Operations Platform

Welcome to **RIPPLE** — the centralized, causal, multi-agent operations platform. Follow this runbook to explore every feature, workflow pack, and dynamic canvas capability.

---

## 1. Accessing the Platform

1. **Local URL:** Open your browser to:
   ```
   http://localhost:8787
   ```
2. **Instant Demo Login (No Password Typing Required):**
   The login page provides **One-Click Demo Login** buttons for 6 personas:
   - **Maya Chen (`maya@harborvine.example`)** — *Manager / SRE Lead / Operations Commander* (Full access to all operations, reviews, and manager approvals).
   - **Sam Rivera (`sam@harborvine.example`)** — *Owner / Escrow Controller* (Full workspace ownership and financial release authority).
   - **Luis Ortega (`luis@harborvine.example`)** — *Member / Head Chef* (Hospitality domain lead).
   - **Priya Nair (`priya@harborvine.example`)** — *Member / Procurement & Escrow Lead* (Financial and deliverable review).
   - **Dan Okafor (`dan@harborvine.example`)** — *Member / Engineering Lead* (PR triage and software reviews).
   - **Vera Holt (`vera@harborvine.example`)** — *Viewer (Read-Only)* (Audit and observer role).

> [!TIP]
> Click **"Maya Chen"** for the standard manager experience or **"Sam Rivera"** for high-privilege owner approvals.

---

## 2. Navigating the Dynamic Workflow Studio (`/studio`)

Once logged in, click **"Studio"** in the top navigation bar.

### A. Dynamic Interactive Canvas (Orbit View)
- **Draggable Multi-Agent Nodes:** Click and drag the central **"You"** avatar or any of the **Specialist Agent Avatars** (`GPU Auditor`, `Cost Allocator`, `Vendor Liaison`, `Budget Analyst`, etc.) anywhere on screen. Notice how the SVG signal cables dynamically stretch and follow your cursor in real time!
- **Draggable Evidence Cards:** Click and drag the chained progression cards (`Invoice`, `Rule checks`, `Timeline`, `Findings`) attached to agents.
- **Draggable Approval Callout:** Click and drag the glowing `"NEEDS YOUR OK"` human authorization bubble.
- **Live Pulse Signals:** Watch animated data tokens pulse along the SVG cables between coordinating agents.

### B. Dynamic Workflow Switching
At the top left of the Studio, click the workflow selector dropdown to switch between multi-agent operational domains:
1. **GPU Cloud Billing Discrepancy** (FinOps & Infrastructure Audit)
2. **Autonomous SRE Incident War Room** (`Incident Response`)
3. **Data Contract & Revenue Invariant Review** (`Schema Governance`)
4. **Cross-Border Escrow & Milestone Payment Guard** (`Escrow Release`)
5. **Software Engineering & Issue Triage** (`Issue Triage / Issue Triage`)
6. **Multi-Agent Refund Orchestrator** (E-Commerce Operations)
7. **Telecom Network Incident Remediation** (Telco Infrastructure)
8. **Clinical Shift Relay & Patient Safety** (Healthcare Handoff)

### C. Live Right-Side Inspector Panel
Click on any agent node (or click `"View Details"` on any evidence card):
- **Tools & Connections:** View live connections to data stores (e.g., Kubernetes, Lambda Billing, Weights & Biases, Ironclad, Slack).
- **Custom Guidance:** Read and adjust live prompt instructions for that agent.
- **Tasks & Outputs:** Inspect live structured findings and handoff summaries.
- **Telemetry:** View live execution latency and model parameters.

### D. Multi-View Operations
Switch between views via the top toolbar:
- **Canvas:** Radial orbit multi-agent canvas with interactive draggable avatars and cables.
- **Board:** Kanban work-item management grouped by status (`Open`, `In Progress`, `Review`, `Done`).
- **Audit Trail:** Immutable timeline of every causal event, state transition, and verified action.
- **3D Infrastructure Map:** Sculptural pixel-style infrastructure topology showing service health, latency, and throughput.

---

## 3. Testing Human-in-the-Loop Interventions

1. **Simulate an Event:** In the top right corner of the Studio, click **"+ Simulate Event"**.
2. **Review Approval Callout:** Notice the `"NEEDS YOUR OK"` callout appear on the canvas.
3. **Navigate to Approvals (`/approvals`):**
   - Click **"Approvals"** in the top navigation.
   - Inspect pending human approvals (e.g. Rollback Authorization, Escrow Payout, Schema Migration, Vendor Dispute).
   - Click **"Approve"** or **"Reject"** in the modal.
4. **Review Forensic Evidence (`/evidence`):**
   - Click **"Evidence"** in the top navigation.
   - Inspect the independent read-back evidence records verifying that the executed effect matches the approved parameters byte-for-byte.
   - Click **"Export Evidence Dossier"** to generate an immutable forensic record.

---

## 4. Running the Causal Directed Acyclic Graph (`/graph`)

1. Click **"Work Graph"** in the top navigation.
2. Select any mission or click one of the quick scenario loaders (`BEO Rescue`, `SceneShift Production`, `ScopeGuard Change Order`, `InvoiceGuard AP Audit`).
3. Click any node in the graph to inspect its causal dependencies, owner department, and status telemetry.

---

## 5. Verification Commands (for Technical Reviewers)

To run the automated test suite locally:
```bash
npm test                # Vitest: 14 test files, 94 tests passing
npm run typecheck       # TypeScript strict check (0 errors)
npm run lint            # ESLint architecture audit (0 errors)
npm run build           # Vite production client build
```

