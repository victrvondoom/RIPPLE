# CrewPilot hackathon execution playbook

**Project:** CrewPilot — Evidence-Driven Bug Investigation Squad
**Repository:** https://github.com/vincenzo-afk/CrewPilot
**Track:** Best Business Workflow
**Prepared:** 2026-11-01 (Asia/Kolkata)

## Confirmed official requirements

- Build a real workflow in team chat where at least one human and at least one AI agent collaborate through Switch to complete a real task.
- Switch is mandatory and must be central; document the integration in README.
- Teams: solo or up to four people. Eligibility rules include minimum age 18 or local age of majority and other exclusions; confirm each participant's eligibility.
- Event starts 2026-11-04 00:01 IST; submissions close 2026-11-07 23:59 IST. Schedule asks for public repo, demo video and README.
- Existing agents/libraries/templates are allowed, but Switch setup and the workflow the agents run must be built during the hackathon.
- Judges assess Switch usage, technical execution, creativity/impact and presentation. The page currently shows placeholder 0% for numerical weighting; do not rely on invented percentages.
- Best Blog and Code with Wispr are optional side tracks; Wispr requires a usage scorecard screenshot.

Sources: https://www.wemakedevs.org/hackathons/switch ; https://www.wemakedevs.org/hackathons/switch/rules ; https://www.wemakedevs.org/hackathons/switch/schedule

## Repository inspection as of 2026-11-01

- The public repository default branch is `main`.
- `prep/hackathon-readiness` already exists remotely and is two commits ahead of `main`; it contains `docs/pre-hackathon-audit.md`, `docs/implementation-backlog.md`, `docs/security-architecture-design.md`, `docs/baseline-test-report.md`, and 44 passing baseline tests verified in CI. Do not recreate it.
- Existing application is a native Switch custom always-on Auto-Triager: GitHub issue retrieval, OpenAI/Anthropic/Groq structured triage, triage card posting, requester approval and change request.
- The existing README documents a live Discord → Switch → CrewPilot → Groq → Switch → Discord test, including requester-only approval. Treat this as the repository's own recorded evidence and re-run it against the hackathon demo environment.
- Audit findings: Python 3.12.7; compileall, Ruff and `git diff --check` passed; 44 unit and regression tests pass in a clean `.venv`; CI workflow committed and green.
- Confirmed gaps: Approvals and message deduplication are currently in memory; a mismatched thread can fall back to the room's latest pending triage (P0 vulnerability documented in tests); only one agent exists; no Builder, Reviewer, durable audit trail or Draft PR writer exists yet.
- Switch protocol alignment: Authoritative Switch agent protocol documentation (`sandbox-quantum/switch docs/official/internals/agent-protocol.md`) specifies SSE events down (`GET /agents/{id}/events`) and authenticated HTTP operations up (`POST /agents/{id}/ops/{op}`). The existing codebase uses this documented SSE/HTTP transport. No WebSocket migration is required or planned. Compatibility testing, connection lifecycle handling, and room context recovery on gap events are detailed in `docs/switch-protocol-compatibility-plan.md`.

Audit: https://github.com/vincenzo-afk/CrewPilot/blob/prep/hackathon-readiness/docs/pre-hackathon-audit.md
Backlog: https://github.com/vincenzo-afk/CrewPilot/blob/prep/hackathon-readiness/docs/implementation-backlog.md

## Exact actions to take now (Nov 1–3)

1. Open the existing local clone in Antigravity. Do not create a blank workspace.
2. In its terminal run `git status --short --branch`, `git remote -v`, `git branch -vv`, `git fetch origin --prune`, `git log --oneline --decorate -12 --all`.
3. If clean, switch to the already-existing local branch, or safely track `origin/prep/hackathon-readiness` if local branch is absent. If dirty, preserve and inspect first; do not stash/reset/clean.
4. Install this kit's `.agents/skills` and merge `AGENTS.md` only if safe. Review before committing.
5. Use `prompts/02-pre-hackathon-preparation.md`: make a clean `.venv`, resolve pytest plugin pollution by isolating dependencies, create baseline regression tests, add Ruff/pytest config and CI. No new multi-agent workflow or Switch deployment setup yet.
6. Run all checks. Commit/push only the verified preparation milestone to `prep/hackathon-readiness`, never `main`. Verify remote SHA.
7. Assign team ownership and confirm who owns Switch setup/Discord, backend/state, Reproducer/Builder+Reviewer, QA/demo/docs. Check official WeMakeDevs Discord and event registration.
8. Rehearse the existing one-agent triage flow and preserve a truthful pre-event baseline screenshot/video if helpful; do not present it as hackathon-created work.

## Branch plan

- `main`: owner's stable branch; no direct commits.
- `prep/hackathon-readiness`: already exists; tests/docs/CI preparation.
- `feat/ai-engineering-squad`: create only after checking it does not already exist, based on the latest approved preparation baseline; all hackathon implementation goes here.
- After each verified milestone, push the feature branch and open/update a PR to `main` for owner review. Do not auto-merge.

## Hackathon build order (Nov 4–7)

- **Nov 4 / M1:** validate Switch server version and chat bridge; create shared room and distinct Triager/Builder/Reviewer identities; prove real addressed Switch messages; add SQLite task/state/audit model; fix exact-task approval flaw.
- **Nov 5 / M2:** real Triager → Builder handoff through Switch; Reproducer/Builder first reproduces the bug with exact commands and output, then works in a disposable repo workspace, makes actual code changes, runs allowlisted tests and records branch/SHA/results.
- **Nov 6 / M3:** independent read-only Reviewer, PASS/CHANGES_REQUESTED loop, revision limit, exact-commit review; human authorizes a separate publication action; create actual Draft PR.
- **Nov 7 / M4:** clean-clone reproducibility, regression/security tests, CI, README/setup/architecture/security/demo script, genuine screenshots/logs, video, submission and confirmation before 23:59 IST.

Do not build optional incident response, content studio or trip planner. The target is one convincing issue-to-reviewed-Draft-PR task.

## Definition of done

A judge can follow the README from a clean clone, configure Switch and required credentials, join a shared team room, submit a real issue, watch a human approve the task, see independent Switch agents hand off work, inspect a genuine patch and test evidence, see a separate read-only review and human publication gate, then open a real GitHub Draft PR. Every claim has evidence, and nothing is fabricated.

## Submission checklist

See `docs/submission-evidence-checklist.md` and `docs/wooble-proof-brief-template.md`. The official public page says repo + demo video + README, but the registration widget is dynamic and a dedicated submission form URL was not exposed in the page extraction at this check. Use the official Register flow and organizer Discord for the actual portal/form; do not use an invented URL. Keep the submission receipt.
