# CrewPilot implementation backlog

This backlog is intentionally split by event phase. Until the hackathon opens,
complete only preparation work that does not create the new Switch workflow.

## Preparation work (before 2026-11-04 00:01 Asia/Kolkata)

### PREP-01 — Reproducible quality baseline

**Outcome:** isolated development dependencies, pinned supported Python range,
pytest and Ruff configuration, plus GitHub Actions that run lint and tests.

**Acceptance criteria:**

- A clean environment can install runtime and development dependencies.
- \`python -m ruff check .\` and \`python -m pytest -q\` run without relying on
  globally installed plugins.
- CI runs the same commands on the selected Python version.

### PREP-02 — Regression tests for current behaviour

**Outcome:** tests for configuration validation, issue URL parsing/fetch errors,
triage JSON validation, message normalization, duplicate protection, and exact
requester authorization.

**Acceptance criteria:**

- Tests use fake HTTP/LLM clients; no real credentials or network are needed.
- The current cross-thread approval fallback has a failing regression test that
  documents the unsafe behavior before it is removed during the event.
- Tests cover SSE reconnect, cursor forwarding, heartbeat errors, \`gap\`, and
  \`evicted\` handling with a fake Switch server.

### PREP-03 — Switch deployment compatibility fixture & protocol alignment plan

**Outcome:** a documented Switch version, local test fixture setup, and verified protocol compatibility plan.

**Acceptance criteria:**

- The chosen deployment is verified against official documentation (`sandbox-quantum/switch docs/official/internals/agent-protocol.md`: SSE `/agents/{id}/events` down, authenticated HTTP `/agents/{id}/ops/{op}` up).
- The protocol compatibility plan (`docs/switch-protocol-compatibility-plan.md`) details connection lifecycle, cursor resumption, room subscription semantics (`scope=all` vs `scope=single`), gap recovery via `read_context`, and addressing rules.
- Agent-to-agent addressing is planned and tested with separate identities using documented room messages/mentions.
- The exact credentials and bridge setup remain outside Git.

### PREP-04 — Security and delivery design

**Outcome:** approved state-machine, database schema, executor permission model,
and threat model in documentation.

**Acceptance criteria:**

- Every privileged action has a human authorizer, required evidence, and a
  denial/expiry behavior.
- Builder isolation, repository allowlist, token scopes, and audit retention are
  agreed before implementation.

## Hackathon implementation (from 2026-11-04 00:01 Asia/Kolkata)

### M1 — Durable task state and identities

Implement a SQLite store for task, task revision, evidence, approval, and audit
records. Register distinct Triager, Builder, and Reviewer identities. Use a
unique task id in all Switch messages.

**Done when:** state survives restart, concurrent task ids cannot collide, and
transitions are tested.

### M2 — Triager to Builder handoff

Create a structured triage brief with issue evidence, risk level, acceptance
criteria, and test plan. Require an exact task-specific human scope approval
before sending the Builder a Switch handoff.

**Done when:** an independent Builder receives the approved task through Switch,
not through an in-process function call.

### M3 — Constrained Builder

Create a worktree for the approved repository, make the minimum patch, run the
approved test commands, commit it, and record branch/commit/output evidence.

**Done when:** no generated command escapes the configured workspace; failure
preserves evidence and cannot create a PR.

### M4 — Independent Reviewer and revision loop

Send the commit/diff and task criteria to a separate Reviewer agent. Record
PASS or CHANGES_REQUESTED; send revisions back to the Builder under the same
task id with a bounded revision count.

**Done when:** a review rejection blocks delivery and a successful re-review is
auditable.

### M5 — Human-authorized Draft PR executor

Build a narrow executor that checks task state, exact human authorization,
passing tests, committed branch, and passing review before creating a Draft PR
in the approved repository.

**Done when:** a live demo produces one real Draft PR and the executor cannot
merge, deploy, change repository, or bypass missing evidence.

### M6 — End-to-end demo and submission material

Document setup, configuration, architecture, security model, reproduction,
known limitations, and a short demo script. Record a video that visibly shows
the three independent Switch agents and the human approval gates.

**Done when:** a fresh clone can reproduce the workflow with documented setup,
and the README describes only implemented capabilities.

## Non-negotiable release gates

For each milestone: inspect the diff; run the documented tests and lint; record
outputs and exit codes; review security-sensitive changes; commit only verified
changes to a feature branch; then open a PR. Do not push directly to \`main\`,
force-push shared work, or create GitHub resources from an unapproved task.
