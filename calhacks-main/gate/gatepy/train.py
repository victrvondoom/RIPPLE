"""gate-train: train Layer 2 on MongoDB listings that pass Layer 1, pick the threshold on validation, save a model.

  gate-train --round N [--config gate/train_config.yaml] [--query JSON] [--out gate/models]
  -> {"model_id", "round", "kind", "features", "n_train", "n_val", "threshold", "val": RoundMetrics}

Rows are split by base listing (calhacks_contracts.splits). The model is fitted on train + calibrate rows that pass
Layer 1. The threshold is picked on out-of-fold scores of those same rows (OOF_FOLDS folds grouped by base listing:
every row is scored by a model that never saw its base listing), so it rests on every legit row rather than the few
dozen in calibrate alone and a single borderline listing can't swing it. Val metrics are reported on val, which
neither the fit nor the threshold touches. Holdout families are refused. `--query` filters answer_keys.
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import yaml
from calhacks_contracts.db import Repo
from sklearn.linear_model import LogisticRegression

from gatepy import GATE_DIR, MODELS
from gatepy.clock import as_of
from gatepy.dataset import GateInputError, data_hash, featurize, load_examples, to_inputs
from gatepy.evaluate import evaluate_examples, get_repo
from gatepy.layer1_bridge import passed, run_layer1
from gatepy.model_io import from_meta, save
from gatepy.registry import Feature, discover, feature_code_hash, select, self_test
from gatepy.sandbox import FeaturePolicyError
from gatepy.selftest import fixture_inputs

DEFAULT_CONFIG = GATE_DIR / "train_config.yaml"
SELF_TEST_SAMPLE = 50
OOF_FOLDS = 5


def fit_lightgbm(X, y, feats: list[Feature], cfg: dict) -> dict:
    p = dict(cfg.get("params", {}))
    rounds = int(p.pop("n_estimators", 200))
    params = {
        "objective": "binary", "verbose": -1, "deterministic": True, "force_row_wise": True,
        "num_threads": 1, "seed": int(cfg.get("seed", 7)),
        "monotone_constraints": [f.monotone for f in feats], "monotone_constraints_method": "advanced",
        **p,
    }
    ds = lgb.Dataset(X, label=y, feature_name=[f.name for f in feats], free_raw_data=False)
    booster = lgb.train(params, ds, num_boost_round=rounds)
    return {"booster": booster.model_to_string(), "coef": None}


def fit_logreg(X, y, feats: list[Feature], cfg: dict) -> dict:
    """Standardized logistic regression. A feature whose weight breaks its monotone direction is dropped (weight 0)."""
    mean = X.mean(axis=0)
    scale = X.std(axis=0)
    scale[scale == 0] = 1.0
    Z = (X - mean) / scale
    active = list(range(len(feats)))
    weights = np.zeros(len(feats))
    intercept = 0.0
    while active:
        clf = LogisticRegression(C=float(cfg.get("params", {}).get("C", 1.0)), max_iter=2000)
        clf.fit(Z[:, active], y)
        w = clf.coef_[0]
        bad = [j for j, i in enumerate(active) if feats[i].monotone and np.sign(w[j]) == -feats[i].monotone]
        if not bad:
            weights[active] = w
            intercept = float(clf.intercept_[0])
            break
        active = [i for j, i in enumerate(active) if j not in bad]
    return {"booster": None, "coef": {"weights": weights.tolist(), "intercept": intercept,
                                      "mean": mean.tolist(), "scale": scale.tolist()}}


FITTERS = {"lightgbm": fit_lightgbm, "logreg": fit_logreg}


def pick_threshold(risk_legit: np.ndarray, max_fpr: float) -> float:
    """Lowest cut (skip if risk >= cut) that blocks at most max_fpr of legit rows."""
    if len(risk_legit) == 0:
        return 0.5
    desc = np.sort(risk_legit)[::-1]
    allowed = int(np.floor(max_fpr * len(desc) + 1e-9))
    if allowed >= len(desc):
        return 0.0
    return float(min(1.0, desc[allowed] + 1e-9))


def oof_risk(kind: str, X: np.ndarray, y: np.ndarray, groups: list[str], feats: list[Feature], cfg: dict,
             folds: int = OOF_FOLDS) -> np.ndarray:
    """Out-of-fold risk: rows are dealt into folds by base listing; each fold is scored by a model fitted on the others.
    Rows of a fold whose training part lacks a class stay NaN."""
    uniq = sorted(set(groups), key=lambda g: hashlib.sha256(g.encode()).hexdigest())
    fold_of = {g: i % folds for i, g in enumerate(uniq)}
    f = np.array([fold_of[g] for g in groups])
    risk = np.full(len(y), np.nan)
    for k in range(folds):
        fit_ix, score_ix = np.where(f != k)[0], np.where(f == k)[0]
        if len(score_ix) == 0 or len(set(y[fit_ix])) < 2:
            continue
        m = from_meta({"kind": kind, "features": [x.name for x in feats], "threshold": 0.5,
                       **FITTERS[kind](X[fit_ix], y[fit_ix], feats, cfg)})
        risk[score_ix] = m.predict_risk(X[score_ix])
    return risk


def train(round_: int, config: Path = DEFAULT_CONFIG, query: dict | None = None, out: Path = MODELS,
          repo: Repo | None = None) -> dict:
    config = Path(config)
    cfg_src = config.read_text(encoding="utf-8")
    cfg = yaml.safe_load(cfg_src) or {}
    kind = cfg.get("kind", "lightgbm")
    if kind not in FITTERS:
        raise GateInputError(f"unknown model kind {kind!r}")

    discover()
    try:
        feats = select(cfg.get("features", "all"), cfg.get("exclude_features", []))
    except KeyError as e:
        raise GateInputError(str(e)) from e
    if not feats:
        raise GateInputError("no features selected")

    repo = repo or get_repo()
    refs = repo.reference_snapshot()
    examples = load_examples(repo, query)
    inputs = to_inputs(examples, refs)
    errors = self_test(feats, fixture_inputs() + inputs[:SELF_TEST_SAMPLE])
    if errors:
        raise GateInputError("feature self-test failed: " + "; ".join(errors[:5]))

    l1 = run_layer1(inputs)
    split = [e.split for e in examples]
    tr = [i for i in range(len(examples)) if split[i] in ("train", "calibrate") and passed(l1[i])]
    cal = [i for i in range(len(examples)) if split[i] == "calibrate"]
    va = [i for i in range(len(examples)) if split[i] == "val"]
    y = np.array([e.key.label == "scam" for e in examples], dtype=int)
    if len(set(y[tr])) < 2:
        raise GateInputError(f"need scam and legit training rows that pass Layer 1 (have {len(tr)} rows, "
                             f"{int(y[tr].sum()) if tr else 0} scam)")

    X = featurize([inputs[i] for i in tr], feats)
    fitted = FITTERS[kind](X, y[tr], feats, cfg)
    max_fpr = float(cfg.get("threshold", {}).get("max_fpr", 0.02))
    meta = {
        "model_id": None, "round": round_, "kind": kind,
        "features": [f.name for f in feats], "monotone": [f.monotone for f in feats],
        "threshold": 0.5, **fitted,
        "train_data_hash": data_hash([examples[i] for i in tr]), "feature_code_hash": feature_code_hash(),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": as_of().isoformat(), "query": query or {},
        "val_metrics": None,
        "threshold_rule": {"max_fpr": max_fpr, "on": None},
        "n_train": len(tr), "n_calibrate": len(cal), "n_val": len(va),
        "config_source": cfg_src, "config_is_default": config.resolve() == DEFAULT_CONFIG.resolve(),
        "feature_sources": {p.name: p.read_text(encoding="utf-8") for p in sorted((GATE_DIR / "features").glob("*.py"))},
    }
    model = from_meta(meta)

    # Threshold on out-of-fold scores of the fitted rows' legit part (never on val), so val stays an honest estimate.
    groups = [examples[i].key.base_listing_id or examples[i].id for i in tr]
    oof = oof_risk(kind, X, y[tr], groups, feats, cfg)
    legit = [j for j in range(len(tr)) if y[tr][j] == 0 and not np.isnan(oof[j])]
    if legit:
        meta["threshold_rule"]["on"] = f"out-of-fold scores ({OOF_FOLDS} folds by base listing) of legit train+calibrate rows"
        risk = oof[legit]
    else:
        legit = [j for j in range(len(tr)) if y[tr][j] == 0]
        meta["threshold_rule"]["on"] = "in-sample legit rows (fallback: no out-of-fold scores)"
        risk = model.predict_risk(X[legit]) if legit else np.array([])
    meta["threshold_rule"]["n"] = len(legit)
    meta["threshold"] = pick_threshold(risk, max_fpr)

    digest = hashlib.sha256(json.dumps([meta["booster"], meta["coef"], meta["threshold"], meta["train_data_hash"],
                                        meta["feature_code_hash"], cfg_src]).encode()).hexdigest()
    meta["model_id"] = f"r{round_}-{digest[:6]}"
    model = from_meta(meta)
    meta["val_metrics"] = evaluate_examples(model, [examples[i] for i in va], refs, l1=[l1[i] for i in va])["metrics"]
    save(meta, out)
    return {"model_id": meta["model_id"], "round": round_, "kind": kind, "features": meta["features"],
            "n_train": len(tr), "n_val": len(va), "threshold": round(meta["threshold"], 6), "val": meta["val_metrics"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="gate-train", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--round", type=int, required=True)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--query", help="JSON filter on the answer_keys collection")
    ap.add_argument("--out", type=Path, default=MODELS)
    a = ap.parse_args(argv)
    try:
        result = train(a.round, a.config, json.loads(a.query) if a.query else None, a.out)
    except (GateInputError, FeaturePolicyError, json.JSONDecodeError) as e:
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
