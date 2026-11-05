# CrewPilot — Antigravity Starter Kit

This kit is additive. It contains Antigravity project instructions, reusable skills, prompts and submission/evidence templates. It does **not** contain the CrewPilot application source code, a completed test suite, a configured Switch deployment, API credentials, or a finished hackathon implementation. Keep the existing repository source and its audit/backlog; Antigravity must build and verify the remaining work.

## Current repository facts checked on 2026-11-01

- Repository: `vincenzo-afk/CrewPilot` (public; default branch `main`).
- Remote branches found: `main` and `prep/hackathon-readiness`.
- `prep/hackathon-readiness` is already one commit ahead of `main`; it contains `docs/pre-hackathon-audit.md` and `docs/implementation-backlog.md`. Do not recreate it.
- The audited main baseline was `f9f6dfd13c85955e48f1e20851aef5db9c5e987f`.
- Existing product is a single custom Switch Auto-Triager. It fetches GitHub issues, asks OpenAI/Anthropic/Groq for structured triage, posts through Switch and supports requester approval/change requests.
- Current implementation uses SSE events down and authenticated HTTP operations up. The hackathon overview and the Switch source protocol checked on 2026-11-01 both describe SSE/HTTP. Do not perform a WebSocket migration unless the actual deployment's current official protocol/version proves it is required.
- The committed audit records Python 3.12.7; compileall, Ruff and `git diff --check` passed. Pytest did not produce a passing baseline: global pytest plugin loading failed, and disabling plugin autoload found no tests. Use a clean project `.venv`, add tests, then record actual results.
- Current audit findings include in-memory approval state, unsafe room-level approval fallback, no committed tests/CI, one agent only, no Builder/Reviewer, and no GitHub Draft PR writer.

## Safe installation

1. Open the existing local `CrewPilot` clone in Antigravity. Do not create a new blank project.
2. Check `git status --short --branch` before copying anything.
3. Extract this ZIP into the repository root, preserving the `.agents` directory. If `AGENTS.md` already exists, merge it manually; do not replace it.
4. Review the file list and `git diff`; then commit the kit only after confirming it contains no secrets and no unrelated changes. Do not use `git add .` blindly.
5. Skills are under `.agents/skills/<name>/SKILL.md`. Antigravity's workspace skill location is `.agents/skills` and skills can be manually invoked as `/<skill-name>`.

## Recommended sequence

1. Install and verify skills (or use `prompts/01-install-skills.md` to have Antigravity create them).
2. Run `prompts/02-pre-hackathon-preparation.md` before Nov 4, 2026 00:01 IST. This is preparation only; it must not build the new multi-agent workflow.
3. From Nov 4, use `prompts/03-hackathon-master-prompt.md` as the standing project brief.
4. Complete one real workflow end-to-end before adding optional features.
5. Use `docs/submission-evidence-checklist.md`, `docs/wooble-proof-brief-template.md` and `docs/evidence/README.md` to prepare proof.

The official overview includes a `triage-pair` example where a Triager routes bugs to a Reproducer. This project extends that idea into a controlled reproduce → fix → independent review workflow. In CrewPilot, the second agent is named Reproducer/Builder so we can target three independent identities while retaining a separate Reviewer.

Official references:
- https://www.wemakedevs.org/hackathons/switch
- https://www.wemakedevs.org/hackathons/switch/rules
- https://www.wemakedevs.org/hackathons/switch/resources
- https://docs.switchagents.ai/switch-rooms/getting-started
- https://docs.switchagents.ai/flintai/switch/internals/agent-protocol
- https://antigravity.google/docs/skills
