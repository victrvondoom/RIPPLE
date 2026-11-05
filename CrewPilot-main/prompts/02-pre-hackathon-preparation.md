# Antigravity prompt — pre-hackathon preparation (through Nov 3 only)

```text
Act as CrewPilot's senior Python engineer, QA lead, Switch integration researcher and release engineer. Work only in the existing local clone of https://github.com/vincenzo-afk/CrewPilot.

Activate the relevant workspace skills: /python-engineering, /switch-protocol, /test-driven-development, /github-workflow, /security-audit, /code-review and /hackathon-evidence.

PHASE GATE: The official workflow hackathon starts 2026-11-04 00:01 Asia/Kolkata. If the current local time is earlier, do preparation only. Do NOT build or register the new multi-agent Switch workflow, Reproducer/Builder/Reviewer handoffs, new Switch room workflow, code executor or GitHub Draft PR writer before the start. Existing Auto-Triager code is the baseline. Do not misrepresent existing work as hackathon work.

Known remote facts from 2026-11-01: main baseline f9f6dfd; remote prep/hackathon-readiness already exists and is one commit ahead of main, containing docs/pre-hackathon-audit.md and docs/implementation-backlog.md. Do not recreate this branch. Read both docs first. The latest recorded audit ran on Python 3.12.7; compileall, Ruff and git diff --check passed, but pytest had a global plugin error and there were no tests collected when plugin autoload was disabled.

FIRST inspect: git status --short --branch; git remote -v; git branch -vv; git fetch origin --prune; git log --oneline --decorate -12 --all. If worktree is dirty, stop before switching branches and report how to preserve the changes. Never reset, clean, stash, force-push or overwrite teammate work. Work on prep/hackathon-readiness (already exists remotely); only create a local tracking branch if absent and safe.

Tasks:
1. Verify the current Python version and create/use a clean project .venv. Do not rely on globally installed pytest plugins. Determine compatible pinned development dependencies from a clean install.
2. Inspect the full existing source and current official Switch protocol plus target deployment version. Current published docs checked 2026-11-01 describe SSE down and authenticated HTTP operations up. Preserve the existing transport unless current protocol evidence says otherwise. Record sources/version; do not blindly migrate to WebSockets.
3. Add maintainable pytest and Ruff configuration and baseline tests for existing behavior only: GitHub issue URL parsing and fetch errors; triage JSON extraction/validation; Switch SSE frame parsing, connection_state/cursor handling, heartbeat behavior, dedupe; exact-thread requester approval and duplicate-pending handling. Do not leave a deliberately failing test in CI. Record the existing cross-thread/room fallback approval defect as a known P0 blocker to fix in the hackathon implementation.
4. Add simple GitHub Actions CI for supported Python, development dependencies, Ruff and pytest. Ensure CI runs the same commands as local instructions.
5. Review security and document the approved design for durable task IDs, state transitions, exact approvals, builder isolation, read-only reviewer and least-privilege GitHub publication. Do not implement those new workflow features before the event.
6. Create docs/baseline-test-report.md with Python/dependency versions, exact commands, test counts, exit codes and any unresolved failures. Update docs/implementation-backlog.md only if evidence requires it; do not overwrite the existing audit.
7. Inspect the complete diff and staged files for secrets, .env, .switch/, private issue data, local databases and unrelated changes.
8. Run: python -m compileall -q .; python -m ruff check .; python -m ruff format --check .; python -m pytest -q; git diff --check. Run all configured type/security checks too. If anything fails, fix and rerun; do not bypass.
9. When a coherent milestone passes all gates, commit with a Conventional Commit message and push only prep/hackathon-readiness. Verify the remote SHA using git ls-remote and compare with git rev-parse HEAD. Never push main.

Do not make any GitHub API writes, create PRs, register agents or change Switch deployment settings. Finish with an evidence-based report: files, exact commands/results, tests, security notes, commit SHA, remote push verification, remaining blockers, and the next safe step. If any required check fails, do not commit or push.
```
```
