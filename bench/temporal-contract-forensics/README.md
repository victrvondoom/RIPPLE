# TCFB — Temporal Contract Forensics Benchmark

Methodology and current results: [`docs/TCF_BENCHMARK.md`](../../docs/TCF_BENCHMARK.md).

| File | Role |
|---|---|
| `lib.ts` | shared types, seed, PRNG, oracle view format |
| `generator.ts` | 20 adversarial categories built from a hidden true timeline; emits engine input + independent oracle view |
| `oracle.ts` | independent brute-force reference (exhaustive offsets, event sweep, documented policy) |
| `run.ts` | runs engine + oracle, scores against oracle and truth, simulates acquiring requested evidence, writes `results/` |
| `render-doc.ts` | copies `results/report.md` into the doc |

```bash
npx tsx bench/temporal-contract-forensics/run.ts 150 10
npx tsx bench/temporal-contract-forensics/render-doc.ts
```
