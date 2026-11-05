<div align="center">

```text
███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗██╗     
██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝██║     
███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗  ██║     
╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝  ██║     
███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗███████╗
╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝
```

### **Incident-Sentinel — Autonomous SRE Incident Response & Canary Deployment Safety Room on Switch**
*Autonomous Telemetry Ingestion, Multi-Agent Outage Triage, Blast Radius Verification & Human-in-the-Loop Rollback Dispatch*

[![GitHub Stars](https://img.shields.io/github/stars/ronitgupta138/incident-sentinel?style=flat-square&logo=github&color=0891b2)](https://github.com/ronitgupta138/Incident-Sentinel/stargazers)
[![Orchestrator: Switch](https://img.shields.io/badge/Orchestrator-Switch_Rooms-0891b2?style=flat-square&logo=switch&logoColor=white)](https://github.com/sandbox-quantum/switch)
[![Hackathon: WeMakeDevs](https://img.shields.io/badge/WeMakeDevs-Flip_The_Switch-FF895E?style=flat-square)](https://www.wemakedevs.org/hackathons/switch)
[![Track 01](https://img.shields.io/badge/Track_01-Best_Business_Workflow-10b981?style=flat-square)](#-the-problem-the-100k-production-outage)
[![Multi-Agent](https://img.shields.io/badge/Architecture-Multi--Agent_SRE_Swarm-0891b2?style=flat-square)](#-system-architecture)
[![FastMCP](https://img.shields.io/badge/FastMCP-3.3-0891b2?style=flat-square&logo=python&logoColor=white)](https://modelcontextprotocol.io/)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-0891b2?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![Tests](https://img.shields.io/badge/Tests-Passed_100%25-10b981?style=flat-square)](https://github.com/ronitgupta138/Incident-Sentinel/actions)
[![CI Pipeline](https://img.shields.io/badge/CI-GitHub_Actions-0891b2?style=flat-square&logo=githubactions&logoColor=white)](https://github.com/ronitgupta138/Incident-Sentinel/actions/workflows/ci.yml)
[![Hits](https://hits.sh/github.com/ronitgupta138/Incident-Sentinel.svg?style=flat-square&label=views&color=0891b2&labelColor=0a0b0e)](https://hits.sh/github.com/ronitgupta138/Incident-Sentinel/)
[![License: MIT](https://img.shields.io/badge/License-MIT-gray?style=flat-square)](LICENSE)

</div>

> 🏆 **Official Submission**: Built for the **WeMakeDevs × DevTools Academy × Switch Hackathon (Track 01: Best Business Workflow)**.  
> 👤 **Sole Author**: **[Ronit Gupta](https://github.com/ronitgupta138)** ([LinkedIn](https://www.linkedin.com/in/ronitgupta138/))  
> 📖 **Technical Architecture Deep-Dive**: Read the complete engineering retrospective in **[`BLOG_POST.md`](BLOG_POST.md)**.

---

## ⚡ The Problem: The $100k+ Production Outage
When a breaking deployment hits production, every minute of downtime costs thousands of dollars. Engineers typically spend **30 to 45 minutes** in high-stress war rooms:

1. Digging through disparate Datadog / New Relic error logs.
2. Manually correlating error timestamps against recent git commit SHAs.
3. Arguing over which deployment broke the service.
4. Manually crafting rollback commands under pressure.

**Incident-Sentinel** replaces chaos with autonomous precision. It turns a team chat channel (Mattermost, Slack, Teams, Discord) into an **Autonomous SRE Incident War Room** where specialized AI teammates collaborate directly with human on-call engineers to diagnose, approve, and execute production rollbacks in **under 3 minutes**.

---

## 🏛️ System Architecture

```
                     ┌──────────────────────────────────────────────┐
                     │          Enterprise Chat Channel             │
                     │  (Mattermost / Slack / Teams / Discord)      │
                     └──────────────────────┬───────────────────────┘
                                            │ Switch Room Bridge
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │            Switch Agent Room                 │
                     │       #incident-war-room (Shared Log)        │
                     └───────┬──────────────┬──────────────┬────────┘
                             │              │              │
             ┌───────────────┘              │              └───────────────┐
             ▼                              ▼                              ▼
  ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
  │  @sentinel-triager   │      │ @sentinel-remediator │      │  @sentinel-operator  │
  │                      │      │                      │      │                      │
  │ • Observability MCP  │─────►│ • Git Diff Review    │─────►│ • Deployment Rollback│
  │ • Error Spike Triage │      │ • Blast Radius Plan  │      │ • Synthetic Probes   │
  │ • Commit Correlation │      │ • Human Approval Gate│      │ • Post-Mortem Doc    │
  └──────────────────────┘      └──────────┬───────────┘      └──────────────────────┘
                                           │
                                           ▼
                               ┌───────────────────────┐
                               │ Human On-Call Sign-Off│
                               │  "APPROVE ROLLBACK"   │
                               └───────────────────────┘
```

---

## 🤖 Specialized AI Teammates

### 1. `@sentinel-triager` (Observability & Root Cause Isolation)
* **Role:** Queries live observability telemetry (error rates, HTTP 500 spikes, p99 latency percentiles).
* **Action:** Correlates the spike timestamp with deployment release logs to isolate the exact culprit microservice (`cart-service`), breaking version (`v2.14.0`), and error stack trace (`NullPointerException: CartSession.getDiscount()`).
* **Handoff:** Hands the diagnostic brief to `@sentinel-remediator`.

### 2. `@sentinel-remediator` (Mitigation & Human Approval Gate)
* **Role:** Reviews the git diff between culprit release `v2.14.0` and last known stable release `v2.13.2`.
* **Action:** Formulates the mitigation strategy and posts a structured **Interactive Approval Card** in chat.
* **Invariant:** **Strictly enforces the Human-in-the-Loop gate.** No rollback or destructive action is ever triggered without explicit human engineer sign-off in the chat.

### 3. `@sentinel-operator` (Execution & Recovery Verification)
* **Role:** Executes the verified rollback upon receiving human approval.
* **Action:** Shifts 100% of live traffic back to stable release `v2.13.2`, runs active synthetic health probes against endpoints, and confirms error rates have dropped to 0%.
* **Deliverable:** Compiles an automated, standardized **Post-Mortem Markdown Report** detailing the timeline, RCA, and preventative action items.

---

## 📋 The 4-Minute War Room Transcript

```chat
[09:42] SRE-Lead: @sentinel-triager checkout is failing since 09:40. Can you investigate?

[09:42] @sentinel-triager: 🚨 Investigating telemetry...
        • Service: cart-service (Status: DEGRADED)
        • Error Rate: 48.7% (1,420 HTTP 500s in last 5m)
        • p99 Latency: 3,840ms
        • Culprit Deploy: v2.14.0 (Commit 8f3a91b by checkout-team)
        • Error Stack: NullPointerException: CartSession.getDiscount() in CartController.java:142
        @sentinel-remediator: Telemetry confirms v2.14.0 broke checkout. Please prepare mitigation plan.

[09:43] @sentinel-remediator: Mitigation Plan Prepared:
        • Action: Roll back cart-service from v2.14.0 -> v2.13.2 (Stable release from 3 days ago)
        • Blast Radius: Immediate restoration of checkout traffic across all pods.
        • Safe-Check: Database schema v2.13.2 is fully backwards-compatible.
        ⚠️ @Ronit Gupta: Please confirm authorization to execute rollback: reply "APPROVE".

[09:43] Ronit Gupta: APPROVE

[09:44] @sentinel-operator: ✅ Human authorization verified from on-call engineer @Ronit Gupta.
        • Executing deployment rollback: cart-service -> v2.13.2... Done.
        • Traffic Shifted: 100% to v2.13.2.
        • Synthetic Health Check: 10/10 probes passed (HTTP 200).
        • Error Rate: 0.0% | p99 Latency: 24.5ms.
        • Post-Mortem Report compiled and archived to docs/postmortems/INC-8924.md.
        🎉 Incident declared RESOLVED. Normal checkout traffic restored.
```

---

## 🚀 60-Second Reproduction Guide for Judges

You can run and test the complete incident response pipeline locally with zero external dependencies:

### Option A: Local Python Test (Instant)
```bash
# 1. Clone repository
git clone https://github.com/ronitgupta138/Incident-Sentinel.git
cd incident-sentinel

# 2. Run automated end-to-end incident recovery test
python3 test_incident_flow.py
```
**Output:**
```text
✅ End-to-end incident triage and recovery test PASSED!
- Detected degraded cart-service (48.7% error rate).
- Correlated with commit v2.14.0.
- Executed authorized rollback to v2.13.2.
- Verified 100% recovery (0.0% errors, HTTP 200).
```

### Option B: Interactive War Room Simulation
```bash
python3 demo_simulation.py
```
*Renders a real-time, terminal war room simulation with status spinners, error rate metrics tables, approval gates, and synthetic probes.*

### Option C: Docker Compose (Full Stack)
```bash
docker compose up -d
make trigger-incident   # Induces live 500 error spike
make test               # Runs triage and verified rollback
```

---

## 📦 Switch Room Installation

To install Incident-Sentinel directly into your Switch workspace:

1. Copy `incident-sentinel.template.yaml` to your Switch templates folder.
2. In **Switch Console**, click **Create Room from Template** → Select **Incident-Sentinel**.
3. Choose your preferred chat platform (Mattermost, Slack, Discord, or Teams).
4. The war room is provisioned with `@sentinel-triager`, `@sentinel-remediator`, and `@sentinel-operator` ready for production alerts!

---

## 🏆 Hackathon Submission Details
- **Hackathon:** [WeMakeDevs Flip the Switch](https://www.wemakedevs.org/hackathons/switch)
- **Track:** **Track 01 — Best Business Workflow** ($2,000 Cash)
- **Code with Wispr:** Built with voice dictation & prompt engineering via Wispr Flow.
- **Repository:** `https://github.com/ronitgupta138/Incident-Sentinel`
- **Sole Author:** Ronit Gupta ([GitHub](https://github.com/ronitgupta138) · [LinkedIn](https://www.linkedin.com/in/ronitgupta138/))
