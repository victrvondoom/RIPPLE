# CrewPilot Security and Delivery Architecture Design

**Status:** Approved for Hackathon Implementation (M1–M5)
**Date:** 2026-11-01 (Pre-Hackathon Preparation)
**Phase Gate:** Architecture & Design Specification (No implementation prior to 2026-11-04 00:01 IST)

---

## 1. Threat Model & Trust Boundaries

CrewPilot operates as an autonomous squad inside a team chat (Switch rooms bridged to Discord). To prevent prompt injection, privilege escalation, and unintended repository modifications, the architecture treats all external data as untrusted:

1. **Untrusted Data Sources:**
   - GitHub issue titles, descriptions, and comments.
   - Project repository files, documentation, and commit messages.
   - Tool outputs and LLM-generated code/text.
   - Chat room messages from unverified users.

2. **Core Security Invariant:**
   - Content from untrusted sources **never** grants system capabilities, overrides policies, or bypasses authorization checks.
   - All state transitions and sensitive operations are enforced by deterministic Python application logic and transactional SQLite constraints, not by LLM prompting alone.

---

## 2. Durable Task Model & SQLite Schema

All task state, approvals, and evidence are persisted in SQLite (WAL mode, foreign key enforcement) rather than volatile memory.

### Database Tables:

```sql
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,               -- UUIDv7 (timestamp-ordered)
    issue_source TEXT NOT NULL,             -- e.g. "owner/repo#42"
    request_key TEXT NOT NULL UNIQUE,       -- Deduplication key
    room_id TEXT NOT NULL,                  -- Originating Switch room
    thread_id TEXT,                         -- Originating Switch thread
    requester_id TEXT NOT NULL,             -- Authorized human user ID
    requester_name TEXT NOT NULL,           -- Human username
    state TEXT NOT NULL,                    -- Current FSM state
    plan_revision INTEGER NOT NULL DEFAULT 1,
    target_repo TEXT NOT NULL,              -- Target GitHub repository
    branch_name TEXT,                       -- e.g. "crewpilot/task-<id>"
    commit_sha TEXT,                        -- Exact SHA under test/review
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE task_approvals (
    approval_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    action_type TEXT NOT NULL,              -- 'SCOPE_APPROVAL' | 'PUBLICATION_APPROVAL'
    plan_revision INTEGER NOT NULL,
    commit_sha TEXT,                        -- Bound for publication approvals
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    decision TEXT NOT NULL,                 -- 'APPROVED' | 'REJECTED'
    feedback TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE task_evidence (
    evidence_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    stage TEXT NOT NULL,                    -- 'TRIAGE' | 'REPRODUCTION' | 'BUILD' | 'REVIEW'
    command TEXT,                           -- Exact executed command array
    exit_code INTEGER,
    stdout_summary TEXT,
    stderr_summary TEXT,
    commit_sha TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(task_id),
    actor TEXT NOT NULL,                    -- Agent identity or human ID
    event_type TEXT NOT NULL,
    payload JSON,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 3. Finite State Machine (FSM) & Allowed Transitions

State transitions are checked within database transactions; illegal transitions raise a `StateTransitionError`.

```
[INIT]
   │
   ▼
TRIAGED ──────(Human Scope Approval)─────► SCOPE_APPROVED
   │                                              │
   │ (Changes Requested)                          ▼
   └─────────────────────────────────────► REPRODUCING
                                                  │
                                                  ▼
                                            IMPLEMENTING
                                                  │
                                                  ▼
                                           TESTS_PASSING
                                                  │
                                                  ▼
                                           UNDER_REVIEW
                                            │        │
                     (Changes Requested)    │        │ (Reviewer PASS)
                     ┌──────────────────────┘        ▼
                     ▼                         REVIEW_APPROVED
               REVISING (Max 2 loops)                │
                     │                               ▼
                     └──────────────► PENDING_PUBLICATION_APPROVAL
                                                     │
                                                     ▼ (Human PR Approval)
                                               PR_PUBLISHED
```

### Transition Matrix:

| From State | Event / Trigger | Required Authority | To State |
| :--- | :--- | :--- | :--- |
| `INIT` | Triage completed | Auto-Triager | `TRIAGED` |
| `TRIAGED` | Human approves scope | Requester | `SCOPE_APPROVED` |
| `TRIAGED` | Human requests changes | Requester | `REVISING` |
| `SCOPE_APPROVED` | Builder accepts task | Switch message | `REPRODUCING` |
| `REPRODUCING` | Reproduction confirmed | Builder | `IMPLEMENTING` |
| `IMPLEMENTING` | Tests pass in worktree | Builder | `TESTS_PASSING` |
| `TESTS_PASSING` | Dispatched to Reviewer | Switch message | `UNDER_REVIEW` |
| `UNDER_REVIEW` | Reviewer PASS | Independent Reviewer | `REVIEW_APPROVED` |
| `UNDER_REVIEW` | Reviewer REJECT | Independent Reviewer | `REVISING` |
| `REVIEW_APPROVED` | Ready for PR gate | System | `PENDING_PUBLICATION_APPROVAL` |
| `PENDING_PUBLICATION_APPROVAL` | Human approves Draft PR | Requester | `PR_PUBLISHED` |

---

## 4. Human Approval Binding & No Room-Level Fallback

The baseline defect allowing cross-thread fallback lookup (`_find_pending` room fallback) is eliminated:
- Approvals must match either:
  1. An explicit mention with task reference (e.g. `@crewpilot approve task-0123`), OR
  2. A direct message within the exact thread of the task.
- Any decision arriving with an ambiguous or mismatched task ID/thread is rejected with an actionable error.
- Approval records strictly bind:
  - Exact `task_id`
  - Exact `plan_revision`
  - Exact `commit_sha` (for publication approval)
  - Authorized `requester_id`

---

## 5. Builder Sandbox & Command Execution Isolation

The Reproducer/Builder agent implements patches and runs verification tests under strict isolation:

1. **Filesystem Isolation:**
   - Executes inside a dedicated `git worktree` or temporary directory (`.worktrees/task-<id>`).
   - Disposable on task completion or failure.
   - Host secrets, `.env`, `.switch/`, and database files are **not** mounted or accessible in the worktree.

2. **Execution Boundary:**
   - **No shell strings:** Never execute commands with `shell=True` or interpolated LLM strings.
   - **Argument Arrays:** Execute only structured argument vectors: `["pytest", "-q"]`, `["git", "diff"]`.
   - **Command Allowlist:** Only approved tools: `git`, `python`, `pytest`, `ruff`.
   - **Timeouts:** Hard timeouts on every command (default: 60 seconds).
   - **Resource Limits:** Subprocess limits preventing runaway forks or network calls where unneeded.

---

## 6. Independent Read-Only Reviewer

The Reviewer agent is an independent entity:
- **Distinct Identity:** Has its own Switch registration ID, credentials, and message routing.
- **Read-Only Access:** Evaluates the `git diff` and execution logs for the exact commit SHA. Has no write access to the worktree or repository.
- **Criteria:** Verifies:
  1. Patch addresses the stated bug without scope creep.
  2. No security regressions or credential leaks.
  3. Tests actually exercise the fix and pass.
  4. Code complies with repository conventions.
- **Verdict:** Issues `PASS` or `CHANGES_REQUESTED` with line-level feedback. A review rejection blocks the workflow from reaching publication approval.

---

## 7. Least-Privilege GitHub Publication Executor

Draft PR creation is decoupled from both the Triager and the Builder:
- **Token Scope:** A fine-grained GitHub token scoped strictly to `pull_requests: write` and `contents: write` for the specific repository allowlist.
- **Forbidden Actions:** No permissions for `repo:admin`, workflow modifications, main branch pushes, or PR merges.
- **Publication Gate:** The executor will only push the feature branch (`crewpilot/task-<id>`) and create a **Draft PR** if:
  1. Database state is `REVIEW_APPROVED`.
  2. All local tests for `commit_sha` exited 0.
  3. Independent Reviewer issued a verified `PASS` for `commit_sha`.
  4. Requester explicitly granted `PUBLICATION_APPROVAL` for `commit_sha`.
- Any missing prerequisite aborts execution without modifying GitHub.
