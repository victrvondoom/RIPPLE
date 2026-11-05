# How We Built an Autonomous SRE Incident War Room on Switch

*How specialized AI agents, team chat, and human-in-the-loop approvals cut production downtime from 45 minutes to 3 minutes.*

---

## The Chaos of Production War Rooms
Every developer and SRE has lived through this scenario:

It’s 9:42 AM. PagerDuty sounds an alarm. A microservice in checkout is throwing cascading HTTP 500 errors. Customers are dropping off cart pages, and company revenue is plummeting.

The war room starts in Slack or Mattermost. Ten engineers jump in simultaneously:
- One person is sifting through 10,000 log lines in Datadog.
- Another is checking the Kubernetes pod restart counts.
- Someone is asking in chat: *"Wait, who deployed last? What changed in v2.14.0?"*
- Half an hour passes before anyone figures out which commit broke the pipeline and whether rolling back will corrupt the database.

By the time the rollback command is typed and executed, **40 minutes have passed**. In enterprise e-commerce or SaaS, that outage costs tens of thousands of dollars.

When we saw the **[Flip the Switch Hackathon](https://www.wemakedevs.org/hackathons/switch)**, we realized Switch provides the exact missing link needed to solve this problem permanently: **turning solo AI coding agents into collaborative teammates directly inside your chat channels.**

We built **[Incident-Sentinel](https://github.com/ronitgupta138/Incident-Sentinel)** — an autonomous Site Reliability Engineering room where AI agents and human on-call engineers triage, diagnose, approve, and resolve production incidents in **under 3 minutes**.

---

## The Philosophy: AI Teammates, Not Hallucinating Chatbots

Most developers today use AI agents like Claude Code, Codex, or Cursor in isolation on their local terminals. But production incidents are fundamentally **collaborative team events**. They require:
1. **Shared Context:** Everyone in the channel must see the diagnosis and evidence in real time.
2. **Separation of Concerns:** One agent shouldn't try to do everything. Specialization beats a generic prompt every single time.
3. **Strict Human Gates:** Under no circumstances should an AI agent execute a production deployment rollback without explicit human approval.

Switch makes this trivial with **Switch Rooms** and **Agent Templates**.

---

## The Architecture of Incident-Sentinel

Here is the high-level workflow of how Incident-Sentinel operates:

```
[Outage / 500 Spike Occurs]
          │
          ▼
┌──────────────────────────────────────┐
│       #incident-war-room (Chat)      │
│  "Checkout service failing at 09:40" │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│        @sentinel-triager             │
│ • Queries Telemetry via FastMCP      │
│ • Detects 48.7% Error Rate           │
│ • Correlates with commit v2.14.0     │
└──────────────────┬───────────────────┘
                   │ Hands off diagnosis
                   ▼
┌──────────────────────────────────────┐
│        @sentinel-remediator          │
│ • Inspects Git diff of v2.14.0       │
│ • Formulates Rollback to v2.13.2     │
│ • Posts Human Approval Gate Card     │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│     Human SRE Sign-Off Gate          │
│       On-Call: "APPROVE"             │
└──────────────────┬───────────────────┘
                   │ Authorized
                   ▼
┌──────────────────────────────────────┐
│        @sentinel-operator            │
│ • Shifts 100% traffic to v2.13.2     │
│ • Runs 10 Synthetic Health Probes    │
│ • Verifies 0.0% Error Rate           │
│ • Emits Post-Mortem Markdown Report  │
└──────────────────────────────────────┘
```

---

## Deep Dive: The Three Specialized Agents

### 1. `@sentinel-triager`: Telemetry & Root Cause Isolation
Instead of humans staring at raw log dumps, `@sentinel-triager` queries the observability MCP endpoints:
- Finds the service status (`DEGRADED`).
- Computes error rate (48.7%) and p99 latency spike (3,840ms).
- Queries recent deployments and correlates the onset time with commit `8f3a91b` (`v2.14.0`).
- Isolates the culprit stack trace:
  ```java
  NullPointerException: CartSession.getDiscount() in CartController.java:142
  ```

### 2. `@sentinel-remediator`: Mitigation & Human Approval Gate
Once the root cause is established, `@sentinel-remediator` determines the blast radius:
- Inspects database schema compatibility between `v2.14.0` and `v2.13.2`.
- Formulates the safe rollback plan.
- Posts an interactive confirmation card into the chat:
  > *"Action: Roll back cart-service from v2.14.0 to v2.13.2.  
  > Blast Radius: Restores traffic immediately; schema is backward compatible.  
  > ⚠️ On-call engineer: reply 'APPROVE' to authorize."*

### 3. `@sentinel-operator`: Execution & Verification
Once the human types `APPROVE`, `@sentinel-operator` takes action:
- Executes the deployment rollback.
- Runs 10 continuous synthetic health probes against the checkout endpoint.
- Confirms HTTP 200 responses, 0.0% error rate, and 24.5ms latency.
- Automatically compiles a standardized **Post-Mortem Markdown Report** detailing detection, root cause, timeline, and preventative action items.

---

## The Switch Template: How It Connects Together

Switch uses declarative YAML templates to provision multi-agent rooms. Here is the exact template powering Incident-Sentinel:

```yaml
version: 1

params:
  team:
    type: string
    default: "sentinel"
  provider:
    type: provider
    default: [claude, codex, opencode]

agents:
  - name: "{team}-triager"
    description: SRE Telemetry & Root Cause Diagnosis Agent
    instructions: |
      Query telemetry, isolate error spikes, correlate with deployment SHAs,
      and hand diagnostic summaries to @{team}-remediator.

  - name: "{team}-remediator"
    description: Mitigation Planner & Human Approval Gate Agent
    instructions: |
      Review diffs, calculate blast radius, and present approval cards.
      Never proceed without explicit human sign-off.

  - name: "{team}-operator"
    description: Rollback Executor & Recovery Verification Agent
    instructions: |
      Execute rollbacks upon human approval, verify synthetic health,
      and generate post-mortem reports.

room:
  name: "incident-war-room"
  agents: ["{team}-triager", "{team}-remediator", "{team}-operator"]
  users: ["{$creator}"]
```

When you instantiate this in Switch Console, Switch sets up the room in Mattermost or Slack, connects each agent through its local working directory, and posts the kickoff alert.

---

## Reproducing in 60 Seconds

We designed Incident-Sentinel to be 100% reproducible out-of-the-box. We built an enterprise infrastructure simulator in FastAPI so anyone can test the full incident response loop without needing a live cloud account.

```bash
# Clone the repository
git clone https://github.com/ronitgupta138/Incident-Sentinel.git
cd incident-sentinel

# Run the automated end-to-end incident flow test
python3 test_incident_flow.py
```

Output:
```
✅ End-to-end incident triage and recovery test PASSED!
- Detected degraded cart-service (48.7% error rate).
- Correlated with commit v2.14.0.
- Executed authorized rollback to v2.13.2.
- Verified 100% recovery (0.0% errors, HTTP 200).
```

---

## Key Takeaways

1. **AI agents belong in team chat, not solo IDE tabs:** Production engineering is collaborative. Putting agents in shared channels means everyone stays on the same page.
2. **Specialized agents beat monolithic prompts:** Giving one agent the triager role, another the remediation planner role, and another the executor role creates structured, reliable workflows.
3. **Human-in-the-loop is non-negotiable for enterprise SRE:** Autonomous diagnosis + human approval + autonomous execution is the gold standard for AI in production systems.

Check out the full open-source code and template on GitHub:  
👉 **[github.com/ronitgupta138/Incident-Sentinel](https://github.com/ronitgupta138/Incident-Sentinel)**

---
*Built with passion by [Ronit Gupta](https://github.com/ronitgupta138) for the Flip the Switch Hackathon.*
