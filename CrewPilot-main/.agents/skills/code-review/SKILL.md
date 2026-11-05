---
name: code-review
description: Performs evidence-based review of actual CrewPilot diffs for correctness, race conditions, authorization, Switch protocol compliance, security, tests and maintainability. Use before every milestone commit and for the independent Reviewer role.
---
# Code Review

## Review the actual change
1. Read the task and acceptance criteria, then inspect the complete diff and surrounding call sites.
2. Verify behavior against the actual code and official protocol/docs; do not trust the implementer's summary.
3. Check correctness, null/empty/error paths, concurrency, idempotency, resource cleanup and restart behavior.
4. Check security boundaries, task binding, human approvals, token access, filesystem paths, subprocess arguments and prompt injection.
5. Confirm tests exercise behavior, including negative cases. Verify that test evidence corresponds to the exact commit SHA under review.
6. Identify regressions, missing migrations/docs, accidental secrets, scope creep and unhandled external API failures.

## Output format
- Verdict: PASS or CHANGES_REQUESTED.
- Findings ordered by severity; each finding includes file, line/range, impact, reproduction/evidence and required correction.
- Acceptance criteria checklist.
- Tests/commands independently executed with exit codes.
- Exact commit SHA reviewed.
- Residual risks and limitations.

Never rubber-stamp a change because tests pass or another agent claims success. Reviewer role is read-only and must not modify the patch it reviews.
