# SchemaCourt ⚖️
### The Autonomous Change Review Room for Data Contracts

> **Flip the Switch Hackathon Submission**  
> **Target Track:** Track 1: Best Business Workflow ($2,000)  
> **Side Bounty:** Code with Wispr ($500 Voice Dictation Integration)  
> **Social Track:** #HowISwitch (Switch AI Community)  
> **GitHub Repository:** [https://github.com/miheergathibandhe/SchemaCourt](https://github.com/miheergathibandhe/SchemaCourt)  
> **Video Demo:** `videos/SchemaCourt_Final_Demo.mp4`  

---

## 1. Project Overview & Elevator Pitch

**The 1-Sentence Pitch:**  
*SchemaCourt turns silent upstream breaking schema changes into an autonomous AI-governed War Room that investigates root cause, tests backward compatibility in DuckDB across 200,000 transactions, and enforces explicit human voice sign-off via Wispr Flow before modifying production analytical models.*

Modern data engineering suffers from a pervasive architectural flaw: **silent upstream schema drift**. Microservice backend engineers deploy API upgrades that deprecate, rename, or nest fields. Downstream analytical pipelines (dbt, Snowflake, DuckDB) blindly ingest this drift, resulting in silent `NULL` propagation, corrupt business metrics, and blank executive financial dashboards.

**SchemaCourt solves this by creating a dedicated Switch AI War Room:**
1. **Autonomous Drift Sentry:** Intercepts upstream schema deprecations before or as they hit downstream warehouses.
2. **AI Investigator (Claude 3.5 Sonnet):** Correlates git diffs, isolates root cause, separates verified facts from suggestions, and formulates a backward-compatible patch (`COALESCE`).
3. **Strict Human Gate:** Claude refuses to alter code or data contracts without explicit human sign-off.
4. **Wispr Flow Voice Dictation Gate:** The lead data engineer approves the deployment completely hands-free using Wispr Flow natural voice dictation.
5. **Dual-Contract Audit Engine:** Executes an in-memory DuckDB audit across 200,000 rows (100k legacy v2 + 100k drifted v3), proving $0.00 financial delta in <50ms.
6. **Decision Audit Receipt:** Logs tamper-evident cryptographic decision receipt and turns the live Streamlit dashboard bright GREEN.

---

## 2. The Problem: The \$17.2M Silent Outage

In our benchmark enterprise scenario:
- **Upstream Service:** `checkout-service@v3.0.0-stripe` deprecates the top-level field `discount_cents` (which becomes 100% NULL) and nests it under `promo_struct.discount_cents`.
- **Downstream Impact:** `models/fct_revenue.sql` calculates:
  ```sql
  net_revenue_cents = order_amount_cents - discount_cents
  ```
  Because SQL arithmetic with `NULL` yields `NULL`, the entire `$17.2M` quarterly revenue aggregates to `$0 / NULL`.
- **The Human Nightmare:** On-call engineers get woken up at 3 AM to raw stack traces, Slack flame wars between backend and analytics teams, and broken reports.

---

## 3. How We Used Switch AI

SchemaCourt is built directly on the **Switch Core Local AI Room Architecture**:
- **Room Engine:** SchemaCourt operates as an isolated, persistent AI collaboration space (`SchemaCourt War Room`) registered in Switch Core.
- **Collaboration Bridge (Telegram):** Connected via Switch Core's Telegram bridge adapter, enabling data engineers to interact with Claude from desktop or mobile with zero friction.
- **Room Rules (`room_rules.md`):** Strict persona and policy governance loaded into Claude's context:
  - Strict human authorization boundary: *Never apply SQL edits or touch models without explicit confirmation from `@maya_data`.*
  - Distinction between verified structural facts (schema diff) and hypotheses.
- **Local Daemon Execution:** Switch manages the autonomous agent process running alongside PostgreSQL and DuckDB.

---

## 4. Code with Wispr Bounty Integration ($500)

> **Live Video Proof:** Visible in `videos/SchemaCourt_Final_Demo.mp4` at **0:52 - 1:04**.

SchemaCourt integrates **Wispr Flow** as the human-in-the-loop authorization gatekeeper:
1. When Claude isolates the schema drift and writes the proposed patch, it stops:
   > *"Waiting for explicit sign-off from @maya_data before applying changes."*
2. Rather than context-switching to a code editor or typing boilerplate in a terminal, Maya opens Telegram and holds Wispr Flow's hotkey.
3. The **Wispr Flow floating waveform pill appears live on screen**, transcribing natural human voice in real-time:
   > `"@SchemaCourtBot approve by @Maya_data. Apply the patch and verify both contracts"`
4. Switch Core receives the verified voice authorization, unlocking Claude to hot-patch `models/fct_revenue.sql` and run the dual verification audit.

---

## 5. Dual-Contract In-Memory Audit (DuckDB)

Before merging any fix to production, SchemaCourt runs a dual audit:
- **Legacy Baseline:** 100,000 transactions on contract v2.0 (`discount_cents` populated).
- **Drifted Baseline:** 100,000 transactions on contract v3.0 (`promo_struct.discount_cents` populated).
- **In-Memory DuckDB Test:**
  ```sql
  SELECT
    COUNT(*) as total_rows,
    SUM(net_revenue_cents) / 100.0 as total_revenue,
    COUNT(CASE WHEN net_revenue_cents IS NULL THEN 1 END) as null_count
  FROM read_parquet('data/dual_contract_benchmark.parquet')
  ```
- **Results:**
  - Total Transactions: `200,000`
  - Null Revenues: `0 (0.00%)`
  - Total Revenue Verified: `$17,249,850.00`
  - Financial Delta: `$0.00`
  - Execution Time: `48.2 milliseconds`

---

## 6. How to Reproduce Locally

```bash
# 1. Clone repository
git clone https://github.com/miheergathibandhe/SchemaCourt.git
cd SchemaCourt

# 2. Install dependencies
pip install -r requirements.txt

# 3. Generate fixtures (200k transactions)
python scripts/generate_fixtures.py

# 4. Launch Streamlit real-time dashboard
streamlit run dashboard/app.py

# 5. Trigger upstream drift simulation (turns dashboard RED)
python -m agents.drift_sentry --simulate-change

# 6. Ask Claude in the Switch War Room to investigate
# Claude halts: "Waiting for explicit sign-off from @maya_data"

# 7. Approve via Wispr Flow voice dictation:
# "@SchemaCourtBot approve by @Maya_data. Apply the patch and verify both contracts"

# 8. Claude applies COALESCE fix, verifies DuckDB, logs receipt, and dashboard turns bright GREEN!
```

---

## 7. Submission Checklist
- [x] Working open-source code pushed to GitHub
- [x] Clear README with architecture diagrams and reproduction steps
- [x] Sub-2-minute master video recording with Wispr Flow voice integration
- [x] Track 1: Best Business Workflow ($2,000) selected
- [x] Code with Wispr Bounty ($500) selected
- [x] Post prepared for #HowISwitch

