"""gate-eval: run the full Gate (Layer 1, then Layer 2 only where Layer 1 passes) and report RoundMetrics.

  gate-eval --model MODEL_ID|promoted [--split train|calibrate|val|all] [--ids FILE] [--query JSON] [--rows]
  -> {"model_id", "metrics": RoundMetrics, "rows"?: [{"listing_id", "label", "family", "attacker_knowledge", "decision"}]}

Data comes from MongoDB ($MONGODB_URI, database $MONGODB_DB_REDTEAM). Holdout rows never live there; score them
in-process with evaluate(model, items, refs).
"""
import argparse
import json
import sys
from pathlib import Path

from calhacks_contracts import GateDecision, GateInput, RoundMetrics, rate
from calhacks_contracts.db import ReferenceSet, Repo, get_db
from calhacks_contracts.families import REAL_FAMILY, policy_bounded_families

from gatepy import MODELS
from gatepy.dataset import Example, GateInputError, featurize, from_items, load_examples, to_inputs
from gatepy.layer1_bridge import failed_rule, passed, run_layer1
from gatepy.model_io import Model, load
from gatepy.registry import discover, select
from gatepy.sandbox import FeaturePolicyError


def decide(model: Model, inputs: list[GateInput], l1=None) -> list[GateDecision]:
    """One GateDecision per input. Layer 2 runs only on inputs that pass every Layer 1 check."""
    l1 = l1 if l1 is not None else run_layer1(inputs)
    reach = [i for i, checks in enumerate(l1) if passed(checks)]
    X = featurize([inputs[i] for i in reach], select(model.features))
    risk, contrib = model.predict_risk(X), model.contributions(X)
    l2 = {i: (float(risk[j]), model.top3(X[j], contrib[j])) for j, i in enumerate(reach)}
    out = []
    for i, checks in enumerate(l1):
        if i not in l2:
            out.append(GateDecision(decision="skip", decided_by="layer1", failed_rule=failed_rule(checks),
                                    model_version=model.model_id, checks=checks))
            continue
        r, top = l2[i]
        skip = r >= model.threshold
        out.append(GateDecision(decision="skip" if skip else "buy", decided_by="layer2" if skip else None,
                                risk_score=round(r, 6), threshold=model.threshold, top_reasons=top,
                                model_version=model.model_id, checks=checks))
    return out


def round_metrics(examples: list[Example], decisions: list[GateDecision]) -> RoundMetrics:
    pairs = list(zip(examples, decisions))
    bounded_fams = policy_bounded_families()
    # Policy-bounded families (no learnable signal; bounded by the unknown-seller cap) are reported apart.
    scam = [(e, d) for e, d in pairs if e.key.label == "scam" and e.key.family not in bounded_fams]
    bounded = [(e, d) for e, d in pairs if e.key.label == "scam" and e.key.family in bounded_fams]
    legit = [(e, d) for e, d in pairs if e.key.label == "legit"]

    def skip_rate(ps):
        return rate(sum(d.decision == "skip" for _, d in ps), len(ps))

    white_box = [(e, d) for e, d in scam if e.key.attacker_knowledge == "white_box"]
    return RoundMetrics(
        layer1_catches=sum(d.decided_by == "layer1" for _, d in scam),
        layer2_recall=skip_rate([(e, d) for e, d in scam if d.decided_by != "layer1"]),
        fpr_real=skip_rate([(e, d) for e, d in legit if e.key.family == REAL_FAMILY]),
        per_family={f: skip_rate([(e, d) for e, d in pairs if e.key.family == f])
                    for f in sorted({e.key.family for e in examples})},
        adaptive_recall=skip_rate(white_box) if white_box else None,
        recall=skip_rate(scam),
        fpr=skip_rate(legit),
        layer2_fpr=skip_rate([(e, d) for e, d in legit if d.decided_by != "layer1"]),
        policy_bounded_recall=skip_rate(bounded) if bounded else None,
    )


def evaluate_examples(model: Model, examples: list[Example], refs: ReferenceSet, with_rows: bool = False,
                      l1=None) -> dict:
    decisions = decide(model, to_inputs(examples, refs), l1)
    out = {"model_id": model.model_id, "metrics": round_metrics(examples, decisions).model_dump(mode="json")}
    if with_rows:
        out["rows"] = [{"listing_id": e.id, "label": e.key.label, "family": e.key.family,
                        "attacker_knowledge": e.key.attacker_knowledge, "decision": d.model_dump(mode="json")}
                       for e, d in zip(examples, decisions)]
    return out


def evaluate(model: Model, items, refs: ReferenceSet, with_rows: bool = False) -> dict:
    """In-process scoring of (Listing, Case | None, AnswerKey) tuples, e.g. the decrypted holdout with its own
    simulated references overlaid on `refs`. Nothing is read from or written to MongoDB."""
    return evaluate_examples(model, from_items(items), refs, with_rows)


def get_repo() -> Repo:
    return Repo(get_db())


def evaluate_repo(model_id: str, repo: Repo, split: str = "all", ids: list[str] | None = None,
                  query: dict | None = None, with_rows: bool = False, models_dir: Path = MODELS) -> dict:
    """gate-eval as a function: score MongoDB listings (optionally restricted to `ids` and a split) with a model."""
    discover()
    model = load(model_id, models_dir)
    query = dict(query or {})
    if ids is not None:
        query["_id"] = {"$in": list(ids)}
    examples = load_examples(repo, query)
    if split != "all":
        examples = [e for e in examples if e.split == split]
    return evaluate_examples(model, examples, repo.reference_snapshot(), with_rows=with_rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="gate-eval", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--model", default="promoted")
    ap.add_argument("--split", choices=["train", "calibrate", "val", "all"], default="all")
    ap.add_argument("--ids", type=Path, help="file with one listing_id per line")
    ap.add_argument("--query", help="JSON filter on the answer_keys collection")
    ap.add_argument("--rows", action="store_true")
    a = ap.parse_args(argv)
    try:
        query = json.loads(a.query) if a.query else {}
        ids = [x.strip() for x in a.ids.read_text(encoding="utf-8").splitlines() if x.strip()] if a.ids else None
        result = evaluate_repo(a.model, get_repo(), a.split, ids, query, a.rows)
    except (GateInputError, FeaturePolicyError, FileNotFoundError, KeyError, json.JSONDecodeError) as e:
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
