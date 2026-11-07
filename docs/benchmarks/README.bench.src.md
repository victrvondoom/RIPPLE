| Detector (held-out, rules {{raw:rules.INSPECT_RULES_VERSION}}) | npm | PyPI |
|---|---|---|
| Metadata, at first malicious publish | **{{pct:E2_npm_metadata.confusion.atPublish_vs_allControls.recall}}** recall (n={{n:E2_npm_metadata.sample.placedWithTimestamps}}) | not recoverable: PyPI deletes removed projects |
| Metadata, averaged over the live window | **{{pctv:E2_npm_metadata.liveWindow.meanDetection}}** | — |
| Static code reading (score ≥ 4) | **{{pct:E3_code.npm.atReview.vsAllBenign.recall}}** (n={{n:E3_code.npm.sizes.malicious}}) | **{{pct:E3_code.pypi.atReview.vsAllBenign.recall}}** (n={{n:E3_code.pypi.sizes.malicious}}) |
| Either signal (same npm packages) | **{{pct:E4_npm_combined.atReview.either.recall}}**; {{n:E4_npm_combined.atReview.malicious.neither}} missed by both | — |
| Legitimate flagged by metadata | popular {{pct:E2_npm_metadata.confusion.atPublish_vs_popular.fpr}}, long-tail {{pct:E2_npm_metadata.confusion.atPublish_vs_longtail.fpr}}, **fresh {{pct:E2_npm_metadata.confusion.atPublish_vs_fresh.fpr}}** | well-known {{pctv:E2b_pypi_metadata.controls.popular.COMPOSITE.pct}}, random {{pctv:E2b_pypi_metadata.controls.random.COMPOSITE.pct}}, **fresh {{pctv:E2b_pypi_metadata.controls.fresh.COMPOSITE.pct}}** |
| Legitimate flagged by code (≥ 4) | {{pct:E3_code.npm.atReview.vsAllBenign.fpr}} | {{pct:E3_code.pypi.atReview.vsAllBenign.fpr}} |
| Lookalike names: recall / false alarms | {{pct:E1_names.npm.lookalike.recall}} / {{pct:E1_names.npm.lookalike.fpr}} | {{pct:E1_names.pypi.lookalike.recall}} / {{pct:E1_names.pypi.lookalike.fpr}} |
| Malicious version pushed to an existing package, caught by metadata | {{pctv:E2_npm_metadata.newlyRegistered.existingDetected.pct}} (n={{n:E2_npm_metadata.newlyRegistered.existingDetected.n}}) | — |

Metrics generated {{raw:generatedAt}}; data: OSV/OpenSSF reports ({{n:P.npm.kept}} npm, {{n:P.pypi.kept}} PyPI), npm placeholder timestamps, {{n:C.npmCrawled}} crawled npm names, the {{n:C.pypiProjects}}-project PyPI index.
