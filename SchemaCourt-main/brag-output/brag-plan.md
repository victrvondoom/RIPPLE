# Brag Plan: SchemaCourt ⚖️

## What is this app?
SchemaCourt is an autonomous AI Change Review Room for Data Contracts that catches silent upstream breaking schema changes, drafts backward-compatible SQL fixes, verifies 200,000 transactions in DuckDB with $0.00 financial discrepancy, and enforces human voice authorization via Wispr Flow before merging.

## The angle
"What happens when backend teams push a breaking schema update without telling data engineering? An executive reads $0 revenue. SchemaCourt puts an AI courtroom between microservices and your analytical warehouse so pipelines never silently break again."

## Hook (first 2-3 seconds)
Big red critical alert: "🚨 PRODUCTION INCIDENT: Stripe checkout-service v3.0.0 released. $17.2M revenue evaluated to NULL."

## Key moments (the middle)
- **The Upstream Drift:** Field `discount_cents` deprecated to 100% NULL and moved to `promo_struct.discount_cents`.
- **The Switch War Room:** Claude in Telegram analyzes the AST diff, identifies backward-compatible `COALESCE`, and refuses to modify code without explicit human sign-off.
- **The Wispr Voice Gate:** Lead data engineer speaks into Wispr Flow: `@SchemaCourtBot approve by @Maya_data`.
- **The Dual-Contract DuckDB Audit:** 200,000 rows audited in 48ms, $0.00 delta, Streamlit flips from red to bright green.

## Outro / punchline
"Autonomous AI governance with strict human authority. Data contracts that never silently break again."

## User flow worth showing
1. Entry: Upstream drift triggered (`--simulate-change`), Streamlit dashboard turns RED.
2. Key action: Claude isolates root cause in Telegram, halted at human approval gate.
3. Voice approval: Wispr Flow waveform pill appears live, dictating approval.
4. Result: DuckDB dual audit passes, Streamlit dashboard flips to bright GREEN (`✅ DUAL-CONTRACT VERIFIED`).

## Tone
- Preset: `cinematic` / `polished`
- Creative direction: Mission-critical data engineering infrastructure with high stakes, real metrics, and zero fluff.

## Format: landscape — 1920x1080
## Duration: 75 seconds total video (10s intro, 10s drift, 14s investigation, 28s approval/audit, 8s outro)

## Visual identity
- Background: `#0B0F19` (Deep obsidian slate)
- Accent Red: `#EF4444` (Upstream breaking alert)
- Accent Green: `#10B981` (Verified contract pass)
- Accent Blue: `#3B82F6` (Switch Core engine)
- Accent Purple: `#EC4899` (Wispr Flow voice gate)
- Display font: Segoe UI Bold
- Code font: Consolas Bold

## Audio direction
- Role: Crisp screen demo audio with ambient voiceover and live Wispr Flow voice dictation waveform.
- Restraint rule: No generic EDM tracks; focus on clarity, prompt interaction, and instant visual feedback.

