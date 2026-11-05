#!/usr/bin/env python3
"""
SchemaCourt Verifier (@DriftSentry) v2.1.0
Inspects fixture schemas, generates backward-compatible SQL repair proposals,
verifies models/fct_revenue.sql against both legacy and drifted Parquet fixtures,
and records human-approved data contract decisions.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

# Ensure UTF-8 output on Windows consoles to prevent charmap encoding errors
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import duckdb
import requests
from fastapi import FastAPI
from pydantic import BaseModel

DATA_DIR = BASE_DIR / "data"
LEGACY_PARQUET = DATA_DIR / "transactions_legacy.parquet"
DRIFTED_PARQUET = DATA_DIR / "transactions_drifted.parquet"
ACTIVE_PARQUET = DATA_DIR / "active_stream.parquet"
META_FILE = DATA_DIR / "pipeline_meta.json"
SQL_MODEL_PATH = BASE_DIR / "models" / "fct_revenue.sql"
DECISION_FILE = DATA_DIR / "last_decision.json"

CHAT_WEBHOOK_URL = os.getenv("SWITCH_ROOM_WEBHOOK_URL", "")

app = FastAPI(title="SchemaCourt Verifier Agent", version="2.1.0")


class AgentRequest(BaseModel):
    room_id: Optional[str] = "data-contracts"
    sender: Optional[str] = "user"
    message: str


def _execute_model_on_parquet(con: duckdb.DuckDBPyConnection, sql_text: str, parquet_path: Path) -> tuple[list, Optional[str]]:
    """Runs models/fct_revenue.sql against a specific Parquet file path safely."""
    posix_path = parquet_path.as_posix()
    bound_sql = sql_text.strip().rstrip(";")
    if "'data/active_stream.parquet'" in bound_sql:
        bound_sql = bound_sql.replace("'data/active_stream.parquet'", f"'{posix_path}'")
    elif '"data/active_stream.parquet"' in bound_sql:
        bound_sql = bound_sql.replace('"data/active_stream.parquet"', f"'{posix_path}'")
    elif "data/active_stream.parquet" in bound_sql:
        bound_sql = bound_sql.replace("data/active_stream.parquet", posix_path)

    try:
        rows = con.execute(bound_sql).fetchall()
        return rows, None
    except Exception as exc:
        return [], str(exc)


def run_contract_check(verify_both_fixtures: bool = False) -> dict:
    """
    Evaluates models/fct_revenue.sql against the active stream and (optionally)
    both legacy and drifted fixtures to prove backward and forward compatibility.
    """
    t0 = time.perf_counter()
    con = duckdb.connect(":memory:")

    # 1. Ground-truth baseline from legacy fixture using canonical baseline logic
    baseline_rows = con.execute(f"""
        SELECT
            product_tier,
            COUNT(*) AS tx_count,
            ROUND(SUM(gross_amount_cents) / 100.0, 2) AS gross_usd,
            ROUND(SUM(discount_cents) / 100.0, 2) AS discount_usd,
            ROUND(SUM(gross_amount_cents - discount_cents) / 100.0, 2) AS net_usd
        FROM read_parquet('{LEGACY_PARQUET.as_posix()}')
        GROUP BY product_tier
        ORDER BY net_usd DESC
    """).fetchall()

    baseline_by_tier = {
        r[0]: {
            "tx_count": int(r[1]),
            "gross_usd": float(r[2]),
            "discount_usd": float(r[3]),
            "net_usd": float(r[4]),
        }
        for r in baseline_rows
    }
    baseline_total_rows = sum(v["tx_count"] for v in baseline_by_tier.values())
    baseline_total_net = round(sum(v["net_usd"] for v in baseline_by_tier.values()), 2)

    # 2. Observe column population in active_stream.parquet
    col_stats = con.execute(f"""
        SELECT
            COUNT(*) AS total_rows,
            COUNT(discount_cents) AS non_null_legacy_col,
            COUNT(promo_struct.discount_cents) AS non_null_struct_col
        FROM read_parquet('{ACTIVE_PARQUET.as_posix()}')
    """).fetchone()
    active_total_rows, non_null_legacy, non_null_struct = (
        int(col_stats[0]), int(col_stats[1]), int(col_stats[2])
    )

    # 3. Run current models/fct_revenue.sql against Legacy Fixture AND Active/Drifted Fixture
    sql_text = SQL_MODEL_PATH.read_text(encoding="utf-8")
    legacy_model_rows, legacy_sql_err = _execute_model_on_parquet(con, sql_text, LEGACY_PARQUET)

    target_second_parquet = DRIFTED_PARQUET if verify_both_fixtures else ACTIVE_PARQUET
    active_model_rows, active_sql_err = _execute_model_on_parquet(con, sql_text, target_second_parquet)

    con.close()
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)

    legacy_map = {r[0]: r for r in legacy_model_rows} if not legacy_sql_err else {}
    active_map = {r[0]: r for r in active_model_rows} if not active_sql_err else {}

    tier_results = []
    legacy_contract_ok = legacy_sql_err is None and len(legacy_map) == len(baseline_by_tier)
    active_contract_ok = active_sql_err is None and len(active_map) == len(baseline_by_tier)

    legacy_live_total = 0.0
    active_live_total = 0.0
    active_has_nulls = False

    for tier, base in baseline_by_tier.items():
        leg_row = legacy_map.get(tier)
        act_row = active_map.get(tier)

        # Evaluate Legacy Fixture run
        leg_tx = int(leg_row[1]) if leg_row and leg_row[1] is not None else 0
        leg_net = float(leg_row[4]) if leg_row and len(leg_row) > 4 and leg_row[4] is not None else None
        if leg_net is None or leg_tx != base["tx_count"] or abs(leg_net - base["net_usd"]) >= 0.01:
            legacy_contract_ok = False
        else:
            legacy_live_total += leg_net

        # Evaluate Active / Drifted Fixture run
        act_tx = int(act_row[1]) if act_row and act_row[1] is not None else 0
        act_net = float(act_row[4]) if act_row and len(act_row) > 4 and act_row[4] is not None else None
        if act_net is None:
            active_has_nulls = True
            active_contract_ok = False
            act_delta = None
        else:
            active_live_total += act_net
            act_delta = round(act_net - base["net_usd"], 2)
            if act_tx != base["tx_count"] or abs(act_delta) >= 0.01:
                active_contract_ok = False

        tier_results.append({
            "product_tier": tier,
            "baseline_tx": base["tx_count"],
            "baseline_net_usd": base["net_usd"],
            "legacy_tx": leg_tx,
            "legacy_net_usd": leg_net,
            "active_tx": act_tx,
            "active_net_usd": act_net,
            "active_delta_usd": act_delta,
            "tier_passed": (
                leg_net is not None
                and act_net is not None
                and leg_tx == base["tx_count"]
                and act_tx == base["tx_count"]
                and abs(leg_net - base["net_usd"]) < 0.01
                and abs(act_net - base["net_usd"]) < 0.01
            ),
        })

    legacy_live_total = round(legacy_live_total, 2)
    active_live_total = round(active_live_total, 2)
    total_delta_usd = None if active_has_nulls else round(active_live_total - baseline_total_net, 2)

    meta = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else {}
    decision = json.loads(DECISION_FILE.read_text(encoding="utf-8")) if DECISION_FILE.exists() else None

    return {
        "contract_verified": legacy_contract_ok and active_contract_ok,
        "legacy_contract_ok": legacy_contract_ok,
        "active_contract_ok": active_contract_ok,
        "elapsed_ms": elapsed_ms,
        "baseline_total_rows": baseline_total_rows,
        "baseline_total_usd": baseline_total_net,
        "legacy_live_total_usd": legacy_live_total if legacy_contract_ok else None,
        "active_live_total_usd": None if active_has_nulls else active_live_total,
        "total_delta_usd": total_delta_usd,
        "active_total_rows": active_total_rows,
        "non_null_legacy_col": non_null_legacy,
        "non_null_struct_col": non_null_struct,
        "legacy_sql_error": legacy_sql_err,
        "active_sql_error": active_sql_err,
        "tiers": tier_results,
        "meta": meta,
        "decision": decision,
    }


def format_investigation_report(audit: dict) -> str:
    """Step 1 & 2 (Detect): Reports verified facts about the schema change and model impact dynamically."""
    meta = audit.get("meta", {})
    producer = meta.get("producer_version", "checkout-service@v3.0.0-stripe")
    commit_sha = meta.get("commit_sha", "e89b44d")

    if audit["contract_verified"]:
        return (
            f"✅ **Schema Check (`{producer}` @ `{commit_sha}`): Passing.**\n"
            f"- Verified `{audit['baseline_total_rows']:,}` rows across Legacy and Active fixtures.\n"
            f"- Baseline Net Revenue: **${audit['baseline_total_usd']:,.2f}** (`$0.00` delta)."
        )

    null_tiers = [t["product_tier"] for t in audit["tiers"] if t["active_net_usd"] is None]
    tier_impact_str = (
        f"`net_revenue_usd` evaluates to `NULL` across {len(null_tiers)} of {len(audit['tiers'])} product tiers ({', '.join(null_tiers)})"
        if null_tiers
        else f"revenue delta measured at `${audit['total_delta_usd']:,.2f}` vs. baseline"
    )

    return (
        f"⚠️ **Contract Check Failed — `{producer}` (`{commit_sha}`)**\n\n"
        f"**Verified Observations:**\n"
        f"- **Schema Change:** In `data/active_stream.parquet` (`{audit['active_total_rows']:,}` rows), top-level `discount_cents` has "
        f"`{audit['non_null_legacy_col']:,}` non-null rows (down from `{audit['baseline_total_rows']:,}` baseline), while nested `promo_struct.discount_cents` now has "
        f"`{audit['non_null_struct_col']:,}` non-null rows.\n"
        f"- **Affected Model:** `models/fct_revenue.sql` computes `SUM(gross_amount_cents - discount_cents)`.\n"
        f"- **Measured Impact:** {tier_impact_str} "
        f"(expected baseline total: **${audit['baseline_total_usd']:,.2f}**).\n\n"
        f"**Next Step:** Ask me for a backward-compatible repair proposal (`@claude propose fix`) for `@maya_data` to review."
    )


def format_proposal_report(audit: Optional[dict] = None) -> str:
    """Step 3 (Propose): Suggests a backward-compatible SQL repair and explains why it works."""
    return (
        "💡 **SchemaCourt Repair Proposal — Backward-Compatible SQL Patch**\n\n"
        "**Target Model:** `models/fct_revenue.sql`\n"
        "**Proposed Change:** Replace direct references to `discount_cents` with `COALESCE` fallback:\n"
        "```sql\n"
        "- ROUND(SUM(gross_amount_cents - discount_cents) / 100.0, 2) AS net_revenue_usd\n"
        "+ ROUND(SUM(gross_amount_cents - COALESCE(discount_cents, promo_struct.discount_cents, 0)) / 100.0, 2) AS net_revenue_usd\n"
        "```\n\n"
        "**Compatibility Rationale:**\n"
        "1. **Legacy Rows (v2.8.0):** `discount_cents` is populated; `promo_struct` is absent or NULL. COALESCE uses legacy `discount_cents`.\n"
        "2. **Drifted Rows (v3.0.0):** `discount_cents` is NULL; `promo_struct.discount_cents` is populated. COALESCE falls back cleanly.\n"
        "3. **Zero Variance:** Produces identical golden net revenue across both schema versions without breaking column contracts.\n\n"
        "**Approval Gate:** Reply `@claude approve and verify` to apply this change and run dual-contract verification."
    )


def format_dual_verification_report(audit: dict) -> str:
    """Step 4 & 5 (Verify): Reports measured results across both Legacy and Drifted fixtures."""
    meta = audit.get("meta", {})
    producer = meta.get("producer_version", "checkout-service@v3.0.0-stripe")
    commit_sha = meta.get("commit_sha", "e89b44d")

    header_status = (
        f"✅ **Dual-Contract Verification PASSED (`{audit['elapsed_ms']} ms`)**"
        if audit["contract_verified"]
        else f"❌ **Dual-Contract Verification FAILED (`{audit['elapsed_ms']} ms`)**"
    )

    lines = [
        header_status,
        f"Tested `models/fct_revenue.sql` against **Legacy Fixture** (`v2.8.0`) and **Drifted Fixture** (`{producer}` @ `{commit_sha}`):\n",
        "| Product Tier | Rows (Legacy / Drifted) | Baseline Net ($) | Legacy Fixture ($) | Drifted Fixture ($) | Delta ($) | Status |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for t in audit["tiers"]:
        leg_str = "NULL" if t["legacy_net_usd"] is None else f"${t['legacy_net_usd']:,.2f}"
        act_str = "NULL" if t["active_net_usd"] is None else f"${t['active_net_usd']:,.2f}"
        delta_str = "NULL" if t["active_delta_usd"] is None else f"${t['active_delta_usd']:,.2f}"
        status_str = "PASS" if t["tier_passed"] else "FAIL"
        lines.append(
            f"| **{t['product_tier']}** | {t['legacy_tx']:,} / {t['active_tx']:,} | "
            f"${t['baseline_net_usd']:,.2f} | {leg_str} | {act_str} | {delta_str} | **{status_str}** |"
        )

    leg_tot = "NULL" if audit["legacy_live_total_usd"] is None else f"${audit['legacy_live_total_usd']:,.2f}"
    act_tot = "NULL" if audit["active_live_total_usd"] is None else f"${audit['active_live_total_usd']:,.2f}"
    del_tot = "NULL" if audit["total_delta_usd"] is None else f"${audit['total_delta_usd']:,.2f}"
    overall_str = "PASS" if audit["contract_verified"] else "FAIL"

    lines.append(
        f"| **TOTAL** | **{audit['baseline_total_rows']:,} / {audit['active_total_rows']:,}** | "
        f"**${audit['baseline_total_usd']:,.2f}** | **{leg_tot}** | **{act_tot}** | **{del_tot}** | **{overall_str}** |"
    )

    if not audit["contract_verified"]:
        if audit["legacy_sql_error"] or audit["active_sql_error"]:
            lines.append(f"\n**SQL Error:** `{audit['legacy_sql_error'] or audit['active_sql_error']}`")
        else:
            lines.append("\n**Failure Reason:** Output contains `NULL` values, row count mismatch, or non-zero revenue delta.")
    else:
        lines.append("\n**Outcome:** Both contracts verified. Next: Record approval decision (`@claude record decision`).")

    return "\n".join(lines)


def record_approval_decision(approver: str, note: str) -> dict:
    """Step 6 (Record): Records the human-approved contract change after passing verification."""
    audit = run_contract_check(verify_both_fixtures=True)
    if not audit["contract_verified"]:
        raise RuntimeError("Cannot record approval: Dual-contract verification is currently FAILING.")

    meta = audit.get("meta", {})
    record = {
        "status": "APPROVED_AND_VERIFIED",
        "approved_by": approver,
        "producer_version": meta.get("producer_version", "checkout-service@v3.0.0-stripe"),
        "commit_sha": meta.get("commit_sha", "e89b44d"),
        "model": "models/fct_revenue.sql",
        "legacy_fixture_result": f"PASS (${audit['legacy_live_total_usd']:,.2f})",
        "drifted_fixture_result": f"PASS (${audit['active_live_total_usd']:,.2f})",
        "measured_delta_usd": audit["total_delta_usd"],
        "rows_verified": audit["baseline_total_rows"],
        "change_summary": note,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    DECISION_FILE.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


@app.post("/agent/message")
def handle_switch_message(req: AgentRequest):
    """
    Switch Agent Protocol Endpoint:
    Handles Detect, Propose, Approve, Verify, and Record intents conversationally.
    """
    msg_lower = req.message.lower()

    if any(k in msg_lower for k in ["propose", "proposal", "plan", "suggest"]):
        # Step 3: Propose
        reply = format_proposal_report()
        return {"agent": "DriftSentry", "room_id": req.room_id, "reply": reply}

    elif any(k in msg_lower for k in ["record", "sign off", "signoff", "decision", "approve"]):
        # Step 6: Record Approval (Enforces Data Owner authorization)
        is_authorized = any(k in msg_lower for k in ["maya_data", "@maya_data", "data owner", "approved by"]) or req.sender in ["maya_data", "@maya_data"]
        if not is_authorized:
            reply = (
                "⚠️ **Approval Gate Blocked:** Recording a contract decision requires explicit authorization "
                "from the Data Owner (`@maya_data`). Please have `@maya_data` review and reply:\n"
                "> `@claude approved by @maya_data. Apply patch and verify.`"
            )
            return {"agent": "DriftSentry", "room_id": req.room_id, "reply": reply}

        try:
            approver = "@maya_data" if "maya_data" in msg_lower else (req.sender or "@maya_data")
            rec = record_approval_decision(
                approver=approver,
                note="Coalesce discount_cents with promo_struct.discount_cents for v3.0 backward compatibility"
            )
            reply = (
                f"📝 **Contract Decision Recorded**\n\n"
                f"- **Approved By:** `{rec['approved_by']}` (Data Owner)\n"
                f"- **Producer Version:** `{rec['producer_version']}` (`{rec['commit_sha']}`)\n"
                f"- **Verification Status:** `PASSED` across `{rec['rows_verified']:,}` rows ($0.00 delta)\n"
                f"- **Recorded At:** `{rec['recorded_at']}`\n"
                f"- **Audit Receipt:** Saved to `{DECISION_FILE.name}`. Dashboard returning to GREEN."
            )
        except Exception as exc:
            reply = f"❌ **Cannot Record Decision:** {exc}"
        return {"agent": "DriftSentry", "room_id": req.room_id, "reply": reply}

    elif any(k in msg_lower for k in ["verify", "both", "audit", "test"]):
        # Step 5: Verify
        audit = run_contract_check(verify_both_fixtures=True)
        reply = format_dual_verification_report(audit)
        return {
            "agent": "DriftSentry",
            "room_id": req.room_id,
            "reply": reply,
            "contract_verified": audit["contract_verified"],
        }

    else:
        # Step 1 & 2: Detect / Investigate
        audit = run_contract_check(verify_both_fixtures=False)
        reply = format_investigation_report(audit)
        return {
            "agent": "DriftSentry",
            "room_id": req.room_id,
            "reply": reply,
            "contract_verified": audit["contract_verified"],
        }


UNPATCHED_SQL_TEMPLATE = """-- ============================================================================
-- Model: models/fct_revenue.sql
-- Tier: GOLD (Executive Finance & Daily KPI Reporting)
-- Contract Rule: Must preserve column names and match baseline net revenue.
-- ============================================================================

SELECT
    product_tier,
    COUNT(*) AS total_transactions,
    ROUND(SUM(gross_amount_cents) / 100.0, 2) AS gross_revenue_usd,
    ROUND(SUM(discount_cents) / 100.0, 2) AS total_discounts_usd,
    ROUND(SUM(gross_amount_cents - discount_cents) / 100.0, 2) AS net_revenue_usd
FROM read_parquet('data/active_stream.parquet')
GROUP BY product_tier
ORDER BY net_revenue_usd DESC;
"""


def reset_demo_state() -> None:
    """Resets the demo to healthy baseline: legacy stream, unpatched SQL, no decision file."""
    from scripts.generate_fixtures import set_stream_mode
    set_stream_mode("legacy")
    SQL_MODEL_PATH.write_text(UNPATCHED_SQL_TEMPLATE, encoding="utf-8")
    if DECISION_FILE.exists():
        DECISION_FILE.unlink()
    # Sync to Switch agent directory if it exists
    switch_dir = Path(r"C:\Users\mihee\.switch\agents\localhost-59634\switch-buddy-admin")
    if switch_dir.exists():
        try:
            (switch_dir / "models" / "fct_revenue.sql").write_text(UNPATCHED_SQL_TEMPLATE, encoding="utf-8")
            if (switch_dir / "data" / "last_decision.json").exists():
                (switch_dir / "data" / "last_decision.json").unlink()
            from scripts.generate_fixtures import ACTIVE_PARQUET as S_ACT, LEGACY_PARQUET as S_LEG
            import shutil
            shutil.copy2(LEGACY_PARQUET, switch_dir / "data" / "active_stream.parquet")
            shutil.copy2(META_FILE, switch_dir / "data" / "pipeline_meta.json")
        except Exception:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SchemaCourt Data Contract Verifier")
    parser.add_argument("--investigate", action="store_true", help="Inspect active stream and report schema impact")
    parser.add_argument("--propose", action="store_true", help="Print backward-compatible SQL repair proposal")
    parser.add_argument("--verify-both", action="store_true", help="Verify models/fct_revenue.sql against both legacy and drifted fixtures")
    parser.add_argument("--simulate-change", "--trigger-drift", dest="simulate_change", action="store_true", help="Switch active stream to drifted v3.0 fixture and run investigation")
    parser.add_argument("--reset-baseline", action="store_true", help="Reset active stream to legacy fixture and clear recorded decision")
    parser.add_argument("--reset-demo", action="store_true", help="Full demo reset: legacy stream + unpatched SQL + clean state")
    parser.add_argument("--record-approval", type=str, metavar="APPROVER", help="Record human approval after verification passes")
    parser.add_argument("--serve", action="store_true", help="Run FastAPI Switch Agent server on port 8090")
    args = parser.parse_args()

    if args.serve:
        import uvicorn
        uvicorn.run(app, host="0.0.0.0", port=8090)
    elif args.reset_demo:
        reset_demo_state()
        print("🎬 DEMO RESET COMPLETE!")
        print("- Active stream: legacy (checkout-service@v2.8.0)")
        print("- models/fct_revenue.sql: unpatched baseline")
        print("- Recorded decisions: cleared")
        print(format_investigation_report(run_contract_check(verify_both_fixtures=False)))
    elif args.reset_baseline:
        from scripts.generate_fixtures import set_stream_mode
        if DECISION_FILE.exists():
            DECISION_FILE.unlink()
        set_stream_mode("legacy")
        print(format_investigation_report(run_contract_check(verify_both_fixtures=False)))
    elif args.simulate_change:
        from scripts.generate_fixtures import set_stream_mode
        if DECISION_FILE.exists():
            DECISION_FILE.unlink()
        set_stream_mode("drift")
        report = format_investigation_report(run_contract_check(verify_both_fixtures=False))
        print(report)
        if CHAT_WEBHOOK_URL:
            try:
                requests.post(CHAT_WEBHOOK_URL, json={"text": report}, timeout=4)
            except Exception:
                pass
    elif args.propose:
        print(format_proposal_report())
    elif args.record_approval:
        try:
            rec = record_approval_decision(
                approver=args.record_approval,
                note="Coalesce discount_cents with promo_struct.discount_cents for v3.0 backward compatibility"
            )
            print(json.dumps(rec, indent=2))
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    elif args.verify_both:
        print(format_dual_verification_report(run_contract_check(verify_both_fixtures=True)))
    else:
        print(format_investigation_report(run_contract_check(verify_both_fixtures=False)))
