# Gate r2-f0bfbd (superseded)

seed1, round 2 of the three-seed validation: the only candidate (1 of 9) to pass promotion against the baseline with ~25 validation scams per family. Adds payment_coercion, untrusted_deep_discount, review_paraphrase_mass and review_dup_long_frac.

- Pipeline: group C (base dataset, out-of-fold threshold, coverage-aware promotion)
- Trained: round 2, 2026-10-24T22:09:08+00:00, 804 training rows, run `seed1`
- Threshold: 0.8568 (out-of-fold scores (5 folds by base listing) of legit train+calibrate rows)
- Features (21): `domain_known`, `domain_similarity_to_known`, `has_median`, `hidden_chars`, `imperative_to_agent`, `injection_hits_reviews`, `injection_hits_text`, `known_wallet`, `mixed_script_words`, `payment_coercion`, `payto_affix_match`, `payto_age_days`, `payto_lookalike`, `price_ratio`, `price_too_low`, `review_count`, `review_dup_long_frac`, `review_len_mean`, `review_paraphrase_mass`, `review_similarity_max`, `untrusted_deep_discount`
- Feature-code hash: `6cdaed38eaf46f69663b2d849350db5fae5607e985c4de953e7dab6dbce4d62d`

## Benchmark

Fixed clean test set from locked-test listings (444 rows; 95% cluster-bootstrap intervals over base listings).

| Metric | Value |
|---|---|
| Accuracy | 91.8% [89–94] |
| Scams caught (seen families) | 88.1% [81–93] |
| Model false blocks (honest) | 1.8% [0–4] |
| Policy blocks ($100 cap) | 3.9% [2–7] |
| Real listings blocked | 9.1% [4–14] |
| Layer 2 risk AUC | 0.954 |
| Held-out families caught | 11.4% [2–22] |
| Unknown-seller caught (policy-bounded) | 0.0% [0–0] |

| Family | Skip rate |
|---|---|
| bait_and_switch | 100% |
| fake_reviews | 85% |
| hidden_text | 100% |
| legit_mixed_reviews | 0% |
| legit_new_seller | 0% |
| legit_plain | 0% |
| legit_real_discount | 0% |
| legit_rewrite | 6% |
| lookalike_domain | 0% |
| lookalike_payto | 100% |
| payment_mismatch | 100% |
| product_switch | 100% |
| prompt_injection | 85% |
| real | 9% |
| too_cheap | 35% |
| unknown_seller | 0% |
| urgency_pressure | 27% |

## Holdout (operator only)

Recall 54.1% (n=122); seen families 82.5%; held-out families 0.0%; Layer 2 false blocks 2.1%.
