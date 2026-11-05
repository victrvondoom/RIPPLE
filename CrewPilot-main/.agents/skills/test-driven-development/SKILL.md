---
name: test-driven-development
description: Builds regression and feature tests with pytest, reproduces failures, implements the smallest safe change and verifies behavior before release. Use for every CrewPilot code milestone.
---
# Test-Driven Development

1. Reproduce the current behavior and inspect the relevant code before editing.
2. Write a focused test for the expected behavior or bug. For an unsafe existing behavior that cannot be fixed before the hackathon phase gate, document it as a blocker rather than leaving a failing CI test.
3. Use fake HTTP/LLM/Switch/GitHub clients and temporary directories. Unit tests must not need real tokens or network access.
4. Implement the smallest change that makes the test pass.
5. Run the focused test, then the full suite, lint, formatter and compile checks.
6. Inspect test names, assertions, branch coverage of authorization/state transitions, and failure paths. Avoid tests that only assert mocks were called without validating behavior.
7. For protocol-sensitive behavior, test both the fake fixture and a separate live deployment check. Label each result accurately.

## CrewPilot minimum test areas
- GitHub issue URL parsing and safe fetch errors.
- Triage JSON schema/normalization and malformed model outputs.
- Switch SSE framing, auth, reconnect/cursor, heartbeat, event dedupe and gap recovery.
- Exact requester/task/plan revision authorization; no cross-thread or room fallback.
- SQLite uniqueness, transaction safety, valid/invalid state transitions and restart recovery.
- Builder path restrictions, command allowlist, timeout and secret isolation.
- Reviewer read-only enforcement and exact commit SHA review.
- Draft PR executor approval, repository allowlist, idempotency and rejection paths.

## Environment
Use a clean project `.venv` to avoid globally installed pytest plugins. Record Python and dependency versions. Never hide plugin errors with `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` as a substitute for a reproducible test environment.
