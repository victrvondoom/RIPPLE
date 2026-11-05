# Gate r1-18775c (superseded)

dry-b1, round 1: first coach round with honest data and group B measurement. Added homoglyph folding, indirect-injection patterns, lookalike-domain clones and near-duplicate review features.

- Pipeline: group B (calibrate-slice threshold, no base dataset)
- Trained: round 1, 2026-10-24T18:44:28+00:00, 423 training rows, run `dry-b1`
- Threshold: 0.4278 (calibrate legit rows that pass Layer 1)
- Features (27): `claim_condition_mismatch`, `domain_clone_of_known`, `domain_known`, `domain_similarity_to_known`, `has_median`, `hidden_chars`, `imperative_to_agent`, `injection_hits_folded`, `injection_hits_reviews`, `injection_hits_text`, `known_wallet`, `machine_directed_sentence`, `manipulation_evidence`, `mixed_script_words`, `order_manipulation`, `payto_affix_match`, `payto_age_days`, `payto_lookalike`, `premium_claim_steep_discount`, `price_ratio`, `price_too_low`, `review_count`, `review_len_mean`, `review_near_dup_ratio`, `review_similarity_max`, `urgency_words`, `verification_bypass`
- Feature-code hash: `92f91fa067cdced68c66452d7534f655ddd3d6a9020639293eabf7c85532a246`

## Benchmark

Fixed clean test set from locked-test listings (444 rows; 95% cluster-bootstrap intervals over base listings).

| Metric | Value |
|---|---|
| Accuracy | 88.7% [86–91] |
| Scams caught (seen families) | 78.1% [72–83] |
| Model false blocks (honest) | 0.0% [0–0] |
| Policy blocks ($100 cap) | 3.9% [2–7] |
| Real listings blocked | 6.8% [3–12] |
| Layer 2 risk AUC | 0.900 |
| Held-out families caught | 14.3% [4–25] |
| Unknown-seller caught (policy-bounded) | 0.0% [0–0] |

| Family | Skip rate |
|---|---|
| bait_and_switch | 100% |
| fake_reviews | 30% |
| hidden_text | 100% |
| legit_mixed_reviews | 0% |
| legit_new_seller | 0% |
| legit_plain | 0% |
| legit_real_discount | 0% |
| legit_rewrite | 0% |
| lookalike_domain | 0% |
| lookalike_payto | 100% |
| payment_mismatch | 100% |
| product_switch | 100% |
| prompt_injection | 95% |
| real | 7% |
| too_cheap | 0% |
| unknown_seller | 0% |
| urgency_pressure | 33% |

## Holdout (operator only)

Recall 55.7% (n=122); seen families 82.5%; held-out families 4.8%; Layer 2 false blocks 0.0%.
