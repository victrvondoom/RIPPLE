# Competitive Gap Analysis (corrected, session 3)

The earlier version of this file claimed things the code did not do (dual-probe recovery checks, "cryptographic" gates, live-metric re-reads, an OfferRoom pack that did not exist). It has been replaced. Details: [INHERITANCE.md](INHERITANCE.md).

| Dimension | The five competitor projects | RIPPLE today |
|---|---|---|
| Scope | One workflow each (SRE / data contracts / triage / escrow / job hunt) | One engine, one data model, 13 packs (domain = configuration) |
| State & audit | Chat transcript, files, or Redis keys | 11-state machine, audited transitions, SQLite with `workspace_id` scoping |
| Verification | Agent or script self-report (Incident-Sentinel's tool returns SUCCESS even when its infra API is down) | `Engine.verifyAction` re-reads the connector effect; packs re-run their own domain checks on the stored document (tamper tests fail verification) |
| Who may approve | Role names or a typed word | Manager/owner level **plus** optional named-approver gate (fail-closed) and assignee-only questions |
| Honesty about scope | Varies | Every output states what was NOT done (no cluster call, no money moved, no code changed, nothing submitted) |
| Where competitors are ahead | | Live integrations: PayPal sandbox payouts, real flight data, job-board scrapers, DuckDB at 100k rows, PDF/DOCX rendering, LLM-backed triage/verification, Discord/Mattermost bridges that were run live. RIPPLE has none of these; its connectors are local/dry-run and Switch is mock-tested only. |
