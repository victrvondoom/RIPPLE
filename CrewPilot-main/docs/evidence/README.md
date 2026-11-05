# Evidence directory policy

Keep genuine, redacted evidence for each end-to-end run. Example structure (create only as data is genuinely produced):

```text
docs/evidence/
  README.md
  run-TASK-001/
    task-summary.json
    switch-timeline.md
    approvals.json
    builder-report.json
    reviewer-report.json
    test-results.txt
    screenshots/
    draft-pr.txt
```

For every record, preserve task ID, plan revision, actor identity, UTC/IST timestamp with timezone, relevant Switch message/event ID, commit SHA, exact command, exit code, review verdict and real PR URL. Redact credentials, access tokens, private user information and sensitive issue payloads. Do not commit raw `.env`, `.switch/`, local databases, unrestricted logs or private source material.

Mocks, synthetic fixtures and live deployment evidence must be labelled separately. Never fabricate evidence to fill a missing stage. Prefer a public/synthetic test repository and a deliberately created non-sensitive sample issue for the demo.


For the final Wooble submission fields and five-minute walkthrough outline, see `docs/wooble-proof-brief-template.md`.
