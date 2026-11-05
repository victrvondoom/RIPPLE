-- ============================================================================
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
