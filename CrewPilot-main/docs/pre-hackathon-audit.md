# CrewPilot pre-hackathon audit

Date: 2026-11-01 (Asia/Kolkata)
Repository baseline: \`f9f6dfd13c85955e48f1e20851aef5db9c5e987f\` (\`origin/main\`)

## Scope and evidence

This is a preparation-only audit. It does not add the proposed multi-agent
workflow, register agents, connect to a real Switch deployment, call an LLM,
or create GitHub resources.

Commands run locally:

\`\`\`text
python --version                    # Python 3.12.7
python -m compileall -q .           # PASS
python -m ruff check .              # PASS
python -m pytest -q                 # FAIL: external pytest-asyncio collection error
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q
                                  # exit 5: no tests collected
git diff --check                    # PASS
\`\`\`

The baseline has no committed test files, pytest configuration, Ruff
configuration, or CI workflow. The workspace is on
\`prep/hackathon-readiness\`, created from the verified public \`origin/main\`
baseline; it has no uncommitted changes at the time of this audit.

## What already works

- A native, always-on Switch client receives an SSE event stream and performs
  authenticated HTTP operations.
- \`SwitchTriageConnector\` accepts addressed triage requests, deduplicates
  pending requests in a running process, fetches a GitHub issue or accepts
  pasted text, and records requester-only approve/change decisions.
- \`TriageAgent\` supports OpenAI, Anthropic, and Groq-compatible endpoints and
  validates a constrained JSON triage response.
- Secrets are loaded from environment or a git-ignored \`.switch/agent.json\`;
  \`.env\` and \`.switch/\` are ignored.
- The prompt clearly treats issue text as untrusted input, and the current
  product does not execute repository code or modify GitHub.

## External compatibility finding

The current Switch agent protocol says **one SSE stream down and HTTP calls
up**, with a stable client-generated connection id, \`Last-Event-ID\` resumption,
and a heartbeat every two seconds. It also documents native task lifecycle
events (\`task_delegate\`, \`task_accept\`, \`task_update\`, \`task_finalise\`, and
\`task_cancel\`).

Sources:

- https://docs.switchagents.ai/flintai/switch/internals/agent-protocol
- https://github.com/sandbox-quantum/switch/blob/main/docs/official/internals/agent-protocol.md

Therefore, do **not** migrate this client to WebSockets based on the earlier
planning note. The hackathon page and the current protocol both describe the
SSE/HTTP transport.

## Confirmed gaps and risks

| Priority | Finding | Evidence and impact |
| --- | --- | --- |
| P0 | No automated project test suite or CI | No test/configuration/CI files are committed. Correctness claims cannot be regression-tested. |
| P0 | Approval state is process-local | \`_pending\` and message deduplication live only in memory. Restart loses approvals, task binding, and audit evidence. |
| P0 | Approval can bind to the wrong triage in a busy room | \`_find_pending\` falls back to the most recent pending triage in a room when the incoming thread differs. A correct person can approve the wrong task. |
| P0 | Only one product agent exists | The repository has one \`crewpilot\` triager. Builder, Reviewer, task identity, durable state, and handoff logic are absent. |
| P1 | Current protocol coverage is incomplete for the planned product | The client handles messages and several connection controls but not the documented Switch task lifecycle events. Do not invent a parallel handoff protocol before first checking whether the deployed Switch version supports these events. |
| P1 | Event-loss handling does not recover context | A \`gap\` event only logs a warning. The protocol requires room context/history to be re-read before acting after a gap. |
| P1 | \`connect_to_room\` is called only while sending | Current protocol guidance warns that room claims/subscriptions made after stream catch-up can miss buffered events. This needs an integration test against the exact Switch release used for the demo. |
| P1 | No isolation boundary for generated code | The current triager never edits or executes code. A Builder must use a scoped worktree/container, an allowlisted repository, and non-interactive commands before it can be trusted with patches. |
| P1 | GitHub write path does not exist | The project only reads issues. Draft PR creation must be a separate, least-privilege, explicitly approved executor. |
| P2 | Baseline environment is not reproducible | \`requirements.txt\` lacks development/test tooling and version constraints for the supported Python/runtime workflow. The global pytest installation also has an incompatible \`pytest-asyncio\` plugin. |
| P2 | Secrets-at-rest hardening is platform-dependent | \`os.chmod(..., 0o600)\` is best-effort and has limited meaning on Windows. Prefer environment/secret-store credentials for the final demo. |

## Security assessment

Positive controls already present: ignored secret files, separate registration
and agent tokens, bounded message output, structured LLM output validation,
explicit triage intent, and prompt-injection guidance.

Before a Builder or PR executor is introduced, require these additional
controls:

1. Durable task ids that bind issue, room, thread, requester, plan revision,
   evidence, and approval together.
2. A state-transition allowlist enforced transactionally in SQLite.
3. Exact-task approvals only; no room-level fallback lookup.
4. A constrained worktree/container with no access to host credentials and a
   repository allowlist.
5. Separate GitHub credentials for read, branch/write, and draft-PR creation;
   never permit merge, secrets access, or arbitrary repository targets.
6. Immutable audit entries recording command, exit code, branch, commit, review
   decision, and authorizing human identity.

## Verified readiness conclusion

The Auto-Triager is a credible baseline, but it is not yet an AI engineering
squad. The preparation branch should first add tests and an evidence-backed
task-state design. During the hackathon, build exactly one complete
issue-to-reviewed-draft-PR path before any optional workflows.
