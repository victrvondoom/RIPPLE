Held-out 70% split, rules frozen in commit `52239ba` before the first held-out run (re-run after the disclosed session-19 control fix; metrics generated {{raw:generatedAt}}).

| | npm | PyPI |
|---|---|---|
| Metadata only (at first malicious publish) | **{{pct:E2_npm_metadata.confusion.atPublish_vs_allControls.recall}}** {{ci:E2_npm_metadata.confusion.atPublish_vs_allControls.recallCI95}}, n={{n:E2_npm_metadata.sample.placedWithTimestamps}} | not recoverable for removed projects; {{pct:E2b_pypi_metadata.confusion_liveMalicious_vs_allControls.recall}} of {{n:E2b_pypi_metadata.maliciousStillLive.COMPOSITE.known}} still-live |
| Metadata only (averaged over the live window) | **{{pctv:E2_npm_metadata.liveWindow.meanDetection}}** | — |
| Code only (score ≥ 4) | **{{pct:E3_code.npm.atReview.vsAllBenign.recall}}** {{ci:E3_code.npm.atReview.vsAllBenign.recallCI95}}, n={{n:E3_code.npm.sizes.malicious}} | **{{pct:E3_code.pypi.atReview.vsAllBenign.recall}}** {{ci:E3_code.pypi.atReview.vsAllBenign.recallCI95}}, n={{n:E3_code.pypi.sizes.malicious}} |
| Either (same packages) | **{{pct:E4_npm_combined.atReview.either.recall}}** {{ci:E4_npm_combined.atReview.either.recallCI95}}; missed by both {{n:E4_npm_combined.atReview.malicious.neither}}/{{n:E4_npm_combined.atReview.malicious.n}} | — |
| Legitimate flagged, metadata | popular {{pct:E2_npm_metadata.confusion.atPublish_vs_popular.fpr}}, long-tail {{pct:E2_npm_metadata.confusion.atPublish_vs_longtail.fpr}}, fresh {{pct:E2_npm_metadata.confusion.atPublish_vs_fresh.fpr}} | well-known {{pctv:E2b_pypi_metadata.controls.popular.COMPOSITE.pct}}, random {{pctv:E2b_pypi_metadata.controls.random.COMPOSITE.pct}}, fresh {{pctv:E2b_pypi_metadata.controls.fresh.COMPOSITE.pct}} |
| Legitimate flagged, code (≥ 4 / ≥ 7) | {{pct:E3_code.npm.atReview.vsAllBenign.fpr}} / {{pct:E3_code.npm.atMalicious.vsAllBenign.fpr}} | {{pct:E3_code.pypi.atReview.vsAllBenign.fpr}} / {{pct:E3_code.pypi.atMalicious.vsAllBenign.fpr}} |
| Lookalike names (recall / false alarms) | {{pct:E1_names.npm.lookalike.recall}} / {{pct:E1_names.npm.lookalike.fpr}} | {{pct:E1_names.pypi.lookalike.recall}} / {{pct:E1_names.pypi.lookalike.fpr}} |
| Malicious versions of existing packages caught by metadata | {{pctv:E2_npm_metadata.newlyRegistered.existingDetected.pct}} | — |
