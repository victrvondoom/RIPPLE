# Gate r0-ac1d79 (superseded)

Baseline: committed features, trained on the real listings plus the base dataset (no coach edits). The incumbent every seeded run started from.

- Pipeline: group C (base dataset, out-of-fold threshold)
- Trained: round 0, 2026-10-24T21:43:29+00:00, 634 training rows, run `seed1`
- Threshold: 0.5945 (out-of-fold scores (5 folds by base listing) of legit train+calibrate rows)
- Features (17): `domain_known`, `domain_similarity_to_known`, `has_median`, `hidden_chars`, `imperative_to_agent`, `injection_hits_reviews`, `injection_hits_text`, `known_wallet`, `mixed_script_words`, `payto_affix_match`, `payto_age_days`, `payto_lookalike`, `price_ratio`, `price_too_low`, `review_count`, `review_len_mean`, `review_similarity_max`
- Feature-code hash: `b83dfafadf0322e9b3dfb1f947fabc23a3da187f41ab678a2c97250065e4496f`

## Benchmark

Fixed clean test set from locked-test listings (444 rows; 95% cluster-bootstrap intervals over base listings).

| Metric | Value |
|---|---|
| Accuracy | 86.9% [83–90] |
| Scams caught (seen families) | 75.6% [68–83] |
| Model false blocks (honest) | 1.4% [0–3] |
| Policy blocks ($100 cap) | 3.9% [2–7] |
| Real listings blocked | 7.6% [4–13] |
| Layer 2 risk AUC | 0.941 |
| Held-out families caught | 8.6% [0–21] |
| Unknown-seller caught (policy-bounded) | 5.0% [0–17] |

| Family | Skip rate |
|---|---|
| bait_and_switch | 100% |
| fake_reviews | 35% |
| hidden_text | 100% |
| legit_mixed_reviews | 0% |
| legit_new_seller | 0% |
| legit_plain | 0% |
| legit_real_discount | 10% |
| legit_rewrite | 0% |
| lookalike_domain | 10% |
| lookalike_payto | 100% |
| payment_mismatch | 100% |
| product_switch | 100% |
| prompt_injection | 45% |
| real | 8% |
| too_cheap | 25% |
| unknown_seller | 5% |
| urgency_pressure | 7% |

## Holdout (operator only)

Recall 53.3% (n=122); seen families 77.5%; held-out families 7.1%; Layer 2 false blocks 0.7%.
