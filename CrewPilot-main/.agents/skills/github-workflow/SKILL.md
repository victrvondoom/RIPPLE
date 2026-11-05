---
name: github-workflow
description: Safely manages CrewPilot branches, diffs, Conventional Commits, pull requests, push verification and teammate changes. Use before any Git operation that changes repository history or remote state.
---
# GitHub Workflow

## Before every task
1. Run `git status --short --branch`, `git branch -vv`, `git remote -v`, `git fetch origin --prune`, and inspect relevant commit history.
2. Identify uncommitted, untracked and teammate-owned work. Preserve it. Never reset, clean, force-push or stash without explicit permission.
3. Never commit directly to `main`.
4. `prep/hackathon-readiness` already exists on origin; do not recreate it. Track it locally only if absent and the working tree is safe.
5. Use `feat/ai-engineering-squad` during the hackathon. Check whether it exists before creating it; if it does, inspect its head and history first.

## Release sequence
1. Review `git diff --stat`, `git diff`, and `git status`.
2. Run relevant tests, full pytest, Ruff lint/format, compile checks and `git diff --check`.
3. Scan staged files for `.env`, `.switch`, API keys, local DBs, private issue text, generated caches and unrelated edits.
4. Commit one coherent verified milestone using Conventional Commits.
5. Push only the working feature branch. First push: `git push -u origin <branch>`; later: `git push origin <branch>`.
6. Verify the remote branch SHA using `git ls-remote origin refs/heads/<branch>` and compare it with `git rev-parse HEAD`.
7. Report commit SHA, remote verification and any failed checks. If any required check fails, do not commit or push.

## Forbidden
- Direct commits/pushes to `main`.
- `git push --force`, `--force-with-lease`, `git reset --hard`, `git clean -fd`.
- Overwriting another contributor's work or claiming a push succeeded without remote verification.
- Automatically merging a PR. Open a PR to `main` and leave merge to the repo owner/review process.
