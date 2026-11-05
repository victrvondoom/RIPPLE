# Gate r1-d3dde0 (rejected)

dry-b2, round 1: promoted on 19 validation scams, but its training data had no hidden-text or prompt-injection scams, so it regressed on unseen data. Kept as the case that motivated group C.

- Pipeline: group B (calibrate-slice threshold, no base dataset)
- Trained: round 1, 2026-10-24T19:24:31+00:00, 418 training rows, run `dry-b2`
- Threshold: 0.3514 (calibrate legit rows that pass Layer 1)
- Features (29): `claim_disclaimer`, `domain_brand_in_host`, `domain_known`, `domain_similarity_to_known`, `encoded_blob_hits`, `has_median`, `hidden_chars`, `imperative_to_agent`, `injection_hits_reviews`, `injection_hits_text`, `injection_paraphrase_hits`, `invisible_run_max`, `key_accessory_text_device`, `known_wallet`, `markup_hidden_hits`, `mixed_script_words`, `payto_affix_match`, `payto_age_days`, `payto_lookalike`, `price_ratio`, `price_too_low`, `product_key_text_overlap`, `review_count`, `review_duplicate_share`, `review_len_mean`, `review_opening_repeat`, `review_similarity_max`, `review_similarity_mean`, `stealth_chars`
- Feature-code hash: `9812b39ac89a9604f10dacbfec5bb95caf40cb5773518c07a3fe5e52b34b0301`

## Benchmark

Fixed clean test set from locked-test listings (444 rows; 95% cluster-bootstrap intervals over base listings).

| Metric | Value |
|---|---|
| Accuracy | 82.8% [79–86] |
| Scams caught (seen families) | 65.6% [59–72] |
| Model false blocks (honest) | 1.4% [0–4] |
| Policy blocks ($100 cap) | 3.9% [2–7] |
| Real listings blocked | 8.3% [4–14] |
| Layer 2 risk AUC | 0.799 |
| Held-out families caught | 0.0% [0–0] |
| Unknown-seller caught (policy-bounded) | 0.0% [0–0] |

| Family | Skip rate |
|---|---|
| bait_and_switch | 100% |
| fake_reviews | 85% |
| hidden_text | 5% |
| legit_mixed_reviews | 0% |
| legit_new_seller | 0% |
| legit_plain | 5% |
| legit_real_discount | 0% |
| legit_rewrite | 0% |
| lookalike_domain | 0% |
| lookalike_payto | 100% |
| payment_mismatch | 100% |
| product_switch | 100% |
| prompt_injection | 0% |
| real | 8% |
| too_cheap | 35% |
| unknown_seller | 0% |
| urgency_pressure | 0% |

## Holdout (operator only)

Not scored (the run had no holdout).
