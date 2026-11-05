#!/usr/bin/env python3
"""
Generates 100,000 deterministic checkout transactions in Parquet format
and allows instant toggling between 'legacy' (healthy) and 'drift' (broken) streams.
"""
import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
import duckdb

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
LEGACY_PARQUET = DATA_DIR / "transactions_legacy.parquet"
DRIFTED_PARQUET = DATA_DIR / "transactions_drifted.parquet"
ACTIVE_PARQUET = DATA_DIR / "active_stream.parquet"
META_FILE = DATA_DIR / "pipeline_meta.json"


def build_parquet_fixtures() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(":memory:")

    # Deterministic seed so revenue numbers are identical every run
    con.execute("SELECT setseed(0.42);")

    # Create base 100,000 rows in memory
    con.execute("""
        CREATE TEMP TABLE raw_tx AS
        SELECT
            'TX-' || lpad(i::VARCHAR, 6, '0') AS tx_id,
            1000 + (i % 4500) AS customer_id,
            CASE
                WHEN (i % 10) IN (0, 1) THEN 'Enterprise'
                WHEN (i % 10) IN (2, 3, 4, 5) THEN 'Growth'
                ELSE 'Starter'
            END AS product_tier,
            CASE
                WHEN (i % 10) IN (0, 1) THEN 49900
                WHEN (i % 10) IN (2, 3, 4, 5) THEN 14900
                ELSE 4900
            END AS gross_amount_cents,
            CASE
                WHEN (i % 5) = 0 THEN 2000
                WHEN (i % 5) = 1 THEN 1000
                WHEN (i % 5) = 2 THEN 500
                ELSE 0
            END AS raw_discount_cents,
            CASE
                WHEN (i % 5) = 0 THEN 'ENT_LOYALTY_20'
                WHEN (i % 5) = 1 THEN 'STRIPE_V3_PROMO'
                WHEN (i % 5) = 2 THEN 'WELCOME_5'
                ELSE 'NONE'
            END AS promo_code,
            TIMESTAMP '2026-11-03 00:00:00' + INTERVAL (i % 86400) SECOND AS event_ts
        FROM range(1, 100001) tbl(i);
    """)

    # 1. Export Legacy Contract Parquet (discount_cents populated, promo_struct NULL)
    con.execute(f"""
        COPY (
            SELECT
                tx_id,
                customer_id,
                product_tier,
                gross_amount_cents::BIGINT AS gross_amount_cents,
                raw_discount_cents::BIGINT AS discount_cents,
                CAST(NULL AS STRUCT(code VARCHAR, discount_cents BIGINT, campaign VARCHAR)) AS promo_struct,
                event_ts
            FROM raw_tx
        ) TO '{LEGACY_PARQUET.as_posix()}' (FORMAT PARQUET);
    """)

    # 2. Export Drifted Payload Parquet (discount_cents NULL, moved into promo_struct)
    con.execute(f"""
        COPY (
            SELECT
                tx_id,
                customer_id,
                product_tier,
                gross_amount_cents::BIGINT AS gross_amount_cents,
                CAST(NULL AS BIGINT) AS discount_cents,
                {{
                    'code': promo_code,
                    'discount_cents': raw_discount_cents::BIGINT,
                    'campaign': 'STRIPE_CHECKOUT_V3'
                }} AS promo_struct,
                event_ts
            FROM raw_tx
        ) TO '{DRIFTED_PARQUET.as_posix()}' (FORMAT PARQUET);
    """)

    con.close()
    print(f"[OK] Generated 100,000 rows in {LEGACY_PARQUET.name} and {DRIFTED_PARQUET.name}")


def set_stream_mode(mode: str) -> None:
    if not LEGACY_PARQUET.exists() or not DRIFTED_PARQUET.exists():
        build_parquet_fixtures()

    if mode == "legacy":
        shutil.copyfile(LEGACY_PARQUET, ACTIVE_PARQUET)
        meta = {
            "stream_mode": "legacy",
            "commit_sha": "a4f91c2",
            "producer_version": "checkout-service@v2.8.0",
            "schema_note": "Top-level `discount_cents` (BIGINT) active",
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
    else:
        shutil.copyfile(DRIFTED_PARQUET, ACTIVE_PARQUET)
        meta = {
            "stream_mode": "drift",
            "commit_sha": "e89b44d",
            "producer_version": "checkout-service@v3.0.0-stripe",
            "schema_note": "BREAKING: `discount_cents` deprecated (NULL); nested `promo_struct.discount_cents` added",
            "updated_at": datetime.now(timezone.utc).isoformat()
        }

    META_FILE.write_text(json.dumps(meta, indent=2))
    print(f"[STREAM UPDATED] Active stream set to '{mode.upper()}' ({meta['producer_version']} @ {meta['commit_sha']})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Manage SchemaCourt Parquet fixtures")
    parser.add_argument(
        "--mode",
        choices=["legacy", "drift"],
        default="legacy",
        help="Set active_stream.parquet to 'legacy' (healthy) or 'drift' (breaking commit)"
    )
    args = parser.parse_args()
    build_parquet_fixtures()
    set_stream_mode(args.mode)

