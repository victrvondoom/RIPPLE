# Gate r3-be84bc (current)

live-r3, round 3 on top of r2-f0bfbd, after the live store test showed r2 let every mzn Official Outlet listing through. Adds the store_clone family (60 seeded rows plus the round's own) and the features bargain_on_imitation_domain and known_wallet_wrong_domain. On the live stores it skipped 105/105 outlet listings and 0/304 real ones.

- Pipeline: group C plus the store_clone family
- Trained: round 3, 2026-10-25T03:29:51+00:00, 921 training rows, run `live-r3`
- Threshold: 0.9107 (out-of-fold scores (5 folds by base listing) of legit train+calibrate rows)
- Features (23): `bargain_on_imitation_domain`, `domain_known`, `domain_similarity_to_known`, `has_median`, `hidden_chars`, `imperative_to_agent`, `injection_hits_reviews`, `injection_hits_text`, `known_wallet`, `known_wallet_wrong_domain`, `mixed_script_words`, `payment_coercion`, `payto_affix_match`, `payto_age_days`, `payto_lookalike`, `price_ratio`, `price_too_low`, `review_count`, `review_dup_long_frac`, `review_len_mean`, `review_paraphrase_mass`, `review_similarity_max`, `untrusted_deep_discount`
- Feature-code hash: `751bd7b51ab8714cffd7a491179e832c173db6c4732805f6f6096c1b90988c57`

## Benchmark

Fixed clean test set from locked-test listings (444 rows; 95% cluster-bootstrap intervals over base listings).

| Metric | Value |
|---|---|
| Accuracy | 90.7% [88–94] |
| Scams caught (seen families) | 85.6% [79–91] |
| Model false blocks (honest) | 1.8% [0–4] |
| Policy blocks ($100 cap) | 3.9% [2–7] |
| Real listings blocked | 9.1% [4–14] |
| Layer 2 risk AUC | 0.965 |
| Held-out families caught | 5.7% [0–14] |
| Unknown-seller caught (policy-bounded) | 0.0% [0–0] |

| Family | Skip rate |
|---|---|
| bait_and_switch | 100% |
| fake_reviews | 85% |
| hidden_text | 100% |
| legit_mixed_reviews | 0% |
| legit_new_seller | 0% |
| legit_plain | 5% |
| legit_real_discount | 0% |
| legit_rewrite | 0% |
| lookalike_domain | 0% |
| lookalike_payto | 100% |
| payment_mismatch | 100% |
| product_switch | 100% |
| prompt_injection | 70% |
| real | 9% |
| too_cheap | 30% |
| unknown_seller | 0% |
| urgency_pressure | 13% |

## Holdout (operator only)

Recall 54.1% (n=122); seen families 81.2%; held-out families 2.4%; Layer 2 false blocks 2.8%.
