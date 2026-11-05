# Flip the Switch — compliance checklist (honest status)

Hackathon: Nov 4–7, 2026. Pull-request/submission deadline: **Nov 7, 11:59 PM IST**. Track: **01 Best Business Workflow** (also eligible: Code with Wispr, Best Blog, #HowISwitch).

Legend: DONE = verified in this repo · PARTIAL · TODO = not started · YOURS = only the human can do it.

## 1. Core challenge: "an AI agent + people in team chat get a real task done, connected by Switch"
| Requirement | Status | Evidence / gap |
|---|---|---|
| Use an AI agent you already use (Claude Code, Codex, Cursor, OpenCode…) | **TODO** | RIPPLE's role "agents" are deterministic rule-based analyzers. No real agent (e.g. Claude Code) is connected. |
| Connect it to Slack/Teams/Discord/Telegram/Mattermost via Switch | **TODO** | Adapter `src/server/collab/switch.ts` exists but has only run against a mock (`tests/switch.test.ts`). Docker is installed on this machine, so a real run is possible. |
| Humans and agent get a real task done together in a room | **PARTIAL** | Local room works; humans approve in RIPPLE UI. Not yet in a chat app. |
| Switch is central; project stops working without it (30% of score) | **TODO** | Today Switch is optional (local mode default). Must become the collaboration path in the demo. |

## 2. Judging criteria
| Criterion | Weight | Status | What to do |
|---|---|---|---|
| Use of Switch | 30% | weakest | Real Switch run: Console + Docker server + one chat bridge; register Claude Code/Codex as role agents; make handoffs/questions/approvals flow through the room. Record the true result in `progress.md`. |
| Technical execution (clone & reproduce) | 25% | strong | `npm test` 132 passed, e2e scripts, evidence in `docs/evidence/`. Re-run before submitting; add one-command Switch setup. |
| Creativity & impact | 25% | strong | One engine, 13 packs, baseline→impact graph→approval→verified action. |
| Presentation (demo video + README) | 20% | PARTIAL | README exists but states "Switch postponed". Needs a demo video (YOURS) and a README rewritten around the Switch story once the real run works. |

## 3. Submission items
| Item | Status |
|---|---|
| Public GitHub repo (this folder is not a git repo yet) | TODO — `git init`, commit, push; `.env` stays ignored |
| README explaining how Switch is used | PARTIAL |
| Demo video | YOURS |
| Team size ≤ 4 | n/a |
| Switch room template for Console | DONE (draft, **untested**): `switch/ripple-room.template.yaml` |
| Code with Wispr: dictate while building + Insights scorecard screenshot | YOURS |
| Best Blog (optional) | YOURS |
| #HowISwitch social post (optional) | YOURS |
| Track 03 Core Contribution (optional) | separate: get an issue labelled `hackathon` assigned first |

## 4. Recommended order (highest score per hour)
1. Start Switch locally (Docker + Console, per its `docs/official/deploy/self-host.md`) with a Mattermost or Discord bridge.
2. Register Claude Code (or Codex) as a real agent; point `SWITCH_ROLE_AGENTS` at it; confirm `GET {bridge}/health`.
3. Run one mission (BEO guest-count change): handoff posted in chat → real agent replies → human approves → RIPPLE verifies. Capture a screen recording.
4. Make the room reply visible in the mission UI as an agent contribution (currently advisory only — see limitation 1 in `progress.md`).
5. Rewrite README top section around that flow; update `docs/SWITCH.md` and `progress.md` with the real result (success or failure).
6. `git init`, push, record the demo, post #HowISwitch.

## 5. Honesty rules for the submission
Do not say Switch works until step 3 has been exercised against a real Switch server. Do not describe the rule-based analyzers as LLMs. Connectors remain dry-run.
