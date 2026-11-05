"""Standing benchmark for the Gate: a fixed clean test set from locked-test listings, honest metrics with intervals.

  uv run --project redteam python -m redteam.bench build-test --snapshot SNAP --out DIR [--n 20] [--seed 97]
  uv run --project redteam python -m redteam.bench run --test DIR (--train-store STORE | --model ID --models DIR)
                                                     [--json out.json] [--boot 500]

build-test: the current generator applied to the snapshot's locked-test listings (never used for training), every
family including held-out ones, plus those real listings unmodified. Local only; real Bitdeer calls for LLM families.

run: trains the standard Gate on a local store (or loads an existing model) and scores it on the test set. Reported:
  seen families     accuracy, recall (policy-bounded families excluded), false blocks split into model (Layer 2) and
                    policy (Layer 1) blocks, real-listing false blocks, Layer 2 risk AUC, per-family skip rates
  held-out          recall on the held-out families (operator view; the coordinator never sees these numbers)
  policy-bounded    recall on policy-bounded families (unknown_seller), reported apart
Every rate has a 95% interval from a cluster bootstrap over base listings: copies of one real listing are resampled
together, so near-duplicates don't make the interval look tighter than it is.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

AS_OF = "2026-10-24"


# ---------- test set ----------
def build_test(snapshot: Path, out: Path, n: int = 20, seed: int = 97) -> dict:
    os.environ["REDTEAM_LOCAL_STORE"] = str(out / "store")
    from calhacks_contracts.families import families
    from redteam import bitdeer, dryrun, store
    from redteam.generate import run_spec
    manifest = json.loads((snapshot / "manifest.json").read_text())
    if not (out / "store" / "listings.jsonl").exists():
        r = store.empty_local_repo()
        dryrun.seed_repo(r, snapshot, "locked_test", False, manifest["as_of"])
        store.set_repo(r)
        store.flush()
    r = store.repo()
    client = bitdeer.make_client()
    fams = families()
    legit = sorted(f for f, v in fams.items() if v["label"] == "legit")
    have = {k.family for k in r.answer_keys()}
    specs = [(f, {"spec_id": f"T-{f}", "family": f, "n": n, "legit_ratio": 0, "mode": "mutate_real"})
             for f in sorted(fams) if fams[f]["label"] == "scam"]
    specs.append(("legit", {"spec_id": "T-legit", "family": "payment_mismatch", "n": n * len(legit),
                            "legit_ratio": 1.0, "mode": "mutate_real"}))
    log, usd = {}, 0.0
    for name, spec in specs:
        if name in have or (name == "legit" and set(legit) <= have):
            continue
        o = run_spec(spec, round_=1, r=r, client=client, allow_holdout=True, seed=seed, id_prefix="T")
        store.flush()
        usd += o["usd"]
        log[name] = {"kept": o["kept"], "dropped": o["dropped"]}
    meta = {"snapshot": str(snapshot), "snapshot_hashes": manifest["hashes"], "n_per_family": n, "seed": seed,
            "usd": round(usd, 4), "generation": log}
    (out / "test_meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


# ---------- metrics ----------
def _cluster_ci(groups: list[str], stat, boot: int, rng: np.random.Generator) -> tuple[float, float]:
    uniq = sorted(set(groups))
    idx = defaultdict(list)
    for i, g in enumerate(groups):
        idx[g].append(i)
    vals = []
    for _ in range(boot):
        pick = rng.choice(len(uniq), size=len(uniq), replace=True)
        rows = [i for j in pick for i in idx[uniq[j]]]
        v = stat(rows)
        if v is not None:
            vals.append(v)
    if not vals:
        return (None, None)
    return (round(float(np.percentile(vals, 2.5)), 3), round(float(np.percentile(vals, 97.5)), 3))


def _rate(rows: list[dict], pred) -> float | None:
    return (sum(pred(r) for r in rows) / len(rows)) if rows else None


def summarize(rows: list[dict], boot: int = 500, seed: int = 0) -> dict:
    """rows: {"listing_id", "group", "label", "family", "decision": GateDecision dict} on the test set."""
    from calhacks_contracts.families import holdout_families, policy_bounded_families
    from sklearn.metrics import roc_auc_score
    held, bounded = holdout_families(), policy_bounded_families()
    rng = np.random.default_rng(seed)
    skip = lambda r: r["decision"]["decision"] == "skip"
    by = lambda r: r["decision"]["decided_by"]

    def metric(sel, fn):
        """Point estimate + cluster-bootstrap interval of fn over the rows chosen by sel."""
        base = [r for r in rows if sel(r)]
        point = fn(base)
        groups = [r["group"] for r in rows]

        def stat(ix):
            sub = [rows[i] for i in ix if sel(rows[i])]
            return fn(sub)
        lo, hi = _cluster_ci(groups, stat, boot, rng)
        return {"value": None if point is None else round(point, 3), "lo": lo, "hi": hi, "n": len(base)}

    seen_scam = lambda r: r["label"] == "scam" and r["family"] not in held | bounded
    legit = lambda r: r["label"] == "legit"
    seen_or_legit = lambda r: seen_scam(r) or legit(r)

    def accuracy(rs):
        return _rate(rs, lambda r: skip(r) == (r["label"] == "scam"))

    def l2_auc(rs):
        rs = [r for r in rs if by(r) != "layer1" and r["decision"].get("risk_score") is not None]
        y = [r["label"] == "scam" for r in rs]
        return float(roc_auc_score(y, [r["decision"]["risk_score"] for r in rs])) if 0 < sum(y) < len(y) else None

    fams = sorted({r["family"] for r in rows})
    return {
        "accuracy": metric(seen_or_legit, accuracy),
        "recall": metric(seen_scam, lambda rs: _rate(rs, skip)),
        "false_blocks": metric(legit, lambda rs: _rate(rs, skip)),
        "false_blocks_model": metric(lambda r: legit(r) and by(r) != "layer1", lambda rs: _rate(rs, skip)),
        "false_blocks_policy": metric(legit, lambda rs: _rate(rs, lambda r: by(r) == "layer1")),
        "false_blocks_real": metric(lambda r: r["family"] == "real", lambda rs: _rate(rs, skip)),
        "l2_risk_auc": metric(seen_or_legit, l2_auc),
        "held_out_recall": metric(lambda r: r["label"] == "scam" and r["family"] in held, lambda rs: _rate(rs, skip)),
        "policy_bounded_recall": metric(lambda r: r["label"] == "scam" and r["family"] in bounded,
                                        lambda rs: _rate(rs, skip)),
        "per_family": {f: {"skip_rate": round(_rate([r for r in rows if r["family"] == f], skip), 3),
                           "n": sum(r["family"] == f for r in rows)} for f in fams},
    }


# ---------- run ----------
def score(model, test_dir: Path, boot: int = 500) -> dict:
    from gatepy.dataset import load_examples
    from gatepy.evaluate import evaluate_examples
    from redteam import store
    repo = store.load_local(test_dir / "store")
    ex = load_examples(repo, include_holdout=True)
    res = evaluate_examples(model, ex, repo.reference_snapshot(), with_rows=True)
    base = {e.id: (e.key.base_listing_id or e.id) for e in ex}
    rows = [{**r, "group": base[r["listing_id"]]} for r in res["rows"]]
    return {"model_id": model.model_id, "test_rows": len(rows), **summarize(rows, boot)}


def run(test_dir: Path, train_store: Path | None = None, model_id: str | None = None, models: Path | None = None,
        boot: int = 500) -> dict:
    os.environ.setdefault("GATE_AS_OF", AS_OF)
    from gatepy.model_io import load
    from redteam import store
    if train_store is not None:
        from gatepy.train import train
        models = models or (train_store.parent / "bench_models")
        t = train(1, out=models, repo=store.load_local(train_store))
        model_id = t["model_id"]
        extra = {"trained": {k: t[k] for k in ("model_id", "kind", "n_train", "n_val", "threshold")}}
    else:
        extra = {}
    return {**extra, **score(load(model_id, models), test_dir, boot)}


def table(res: dict) -> str:
    keys = ["accuracy", "recall", "false_blocks", "false_blocks_model", "false_blocks_policy", "false_blocks_real",
            "l2_risk_auc", "held_out_recall", "policy_bounded_recall"]
    out = [f"model {res['model_id']}  test rows {res['test_rows']}", f"{'metric':24}{'value':>8}  95% interval   n"]
    for k in keys:
        m = res[k]
        v = "—" if m["value"] is None else f"{m['value']:.3f}"
        ci = "" if m["lo"] is None else f"[{m['lo']:.3f}, {m['hi']:.3f}]"
        out.append(f"{k:24}{v:>8}  {ci:15}{m['n']:>4}")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build-test")
    b.add_argument("--snapshot", type=Path, required=True)
    b.add_argument("--out", type=Path, required=True)
    b.add_argument("--n", type=int, default=20)
    b.add_argument("--seed", type=int, default=97)
    r = sub.add_parser("run")
    r.add_argument("--test", type=Path, required=True)
    r.add_argument("--train-store", type=Path)
    r.add_argument("--model")
    r.add_argument("--models", type=Path)
    r.add_argument("--json", type=Path)
    r.add_argument("--boot", type=int, default=500)
    a = ap.parse_args(argv)
    if a.cmd == "build-test":
        print(json.dumps(build_test(a.snapshot.resolve(), a.out.resolve(), a.n, a.seed), indent=1))
        return 0
    if not a.train_store and not (a.model and a.models):
        ap.error("run needs --train-store, or --model and --models")
    res = run(a.test.resolve(), a.train_store and a.train_store.resolve(), a.model, a.models and a.models.resolve(),
              a.boot)
    if a.json:
        a.json.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(table(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
