# CrewPilot Team Ownership & Responsibility Matrix

**Status:** PROPOSED (Subject to mutual agreement by team members)  
**Date:** 2026-11-01  
**Event:** Flip the Switch Hackathon (Nov 4–7, 2026)  

---

## 1. Team Roster

- **Team Captain:** Bharani (`vincenzo-afk`)
- **Team Member:** Kamalesh (`kamalesh404`)

---

## 2. Proposed Responsibility Matrix

| Domain / Workstream | Primary Lead (PROPOSED) | Secondary Support (PROPOSED) | Scope & Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Switch Infrastructure & Room Setup** | Bharani | Kamalesh | Deployment choice evaluation (shared remote server vs. local Switch Console with tunnel; note: a local server on one machine is not accessible to remote teammates unless publicly bridged or hosted remotely), room creation, Discord bridge connection, credential generation for 3 identities. |
| **Agent Architecture & Coordination** | Kamalesh | Bharani | Multi-agent handoff contracts, prompt engineering for Triager, Reproducer/Builder, and Reviewer. |
| **Python Backend & Protocol Client** | Kamalesh | Bharani | Hardening of `agent_client.py` SSE transport, gap context recovery via `read_context`, heartbeat loop, multi-agent dispatch. |
| **Persistence & State Machine (SQLite)** | Kamalesh | Bharani | SQLite schema implementation, WAL transactions, task FSM enforcement, exact approval queries. |
| **Reproducer & Builder Sandbox** | Bharani | Kamalesh | Disposable git worktree setup, isolated subprocess execution (`shell=False`), command allowlist, patch application. |
| **Security & Authorization Controls** | Kamalesh | Bharani | Removal of cross-thread approval fallback, secret redaction, token isolation, prompt injection defenses. |
| **Independent Reviewer Role** | Bharani | Kamalesh | Read-only diff inspection agent, policy rule evaluator, pass/changes feedback loops. |
| **GitHub Integration & PR Publisher** | Kamalesh | Bharani | Scoped fine-grained token setup, verified Draft PR creator, duplicate prevention. |
| **Quality Assurance (QA) & CI Testing** | Kamalesh | Bharani | Unit tests for SSE protocol & SQLite, CI pipeline maintenance on GitHub Actions, regression testing. |
| **Demo Execution & Video Recording** | Bharani | Kamalesh | Demo issue reproduction rehearsal, video capture (showing human + 3 Switch agents in chat), narration. |
| **Documentation & Submission Proof** | Bharani | Kamalesh | Final README polish, Wooble proof brief, architecture diagram, submission portal check. |

---

## 3. Communication & Code Review Protocol

1. **Feature Branching:** All event work is developed on `feat/ai-engineering-squad`. Direct commits to `main` are prohibited.
2. **Peer Review:** Before any milestone is pushed or merged to `main`, the secondary lead must review the diff, run `pytest`, and verify tests pass.
3. **Daily Sync:** A 15-minute sync at 09:00 IST and 20:00 IST during November 4–7 to align on milestone milestones.
