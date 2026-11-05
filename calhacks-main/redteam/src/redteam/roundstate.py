"""Build the coordinator's RoundInput (issue #1 schema 2) in code, from MongoDB, the model files and promoted.json."""
from calhacks_contracts import Budget, HoldoutTotals, Miss, Reason, RoundInput, RoundReport

from redteam import gate_client, gate_stub, promotion, scoring, store
from redteam.config import ROUND_BUDGET


def current_model_features(model_id: str | None) -> list[str]:
    feats = gate_client.model_features(model_id)
    if not feats and gate_client.GATE_BACKEND == "stub":
        feats = gate_stub.features()
    return feats


def val_misses(model_id: str | None, limit: int = 20, r=None) -> list[Miss]:
    if not model_id:
        return []
    r = r or store.repo()
    ev = gate_client.evaluate(model_id, split="val", rows=True)
    rows = scoring.misses(ev.get("rows", []))[:limit]
    listings = {l.listing_id: l for l in r.listings([x["listing_id"] for x in rows])}
    out = []
    for x in rows:
        if x["listing_id"] not in listings:
            continue
        d = x["decision"]
        out.append(Miss(listing=listings[x["listing_id"]], label=x["label"], family=x["family"],
                        decision=d["decision"], decided_by=d["decided_by"],
                        top_reasons=[Reason.model_validate(t) for t in d.get("top_reasons", [])]))
    return out


def build_round_input(round_: int, *, max_misses: int = 20, r=None) -> RoundInput:
    r = r or store.repo()
    model_id = promotion.current()["model_id"]
    last = store.get_round(r, round_ - 1)
    last_report = RoundReport.model_validate(last["report"]) if last and last.get("report") else None
    h = promotion.holdout_for_current()
    return RoundInput(
        round=round_,
        budget=Budget(**ROUND_BUDGET),
        current_model_id=model_id,
        last_report=last_report,
        coverage=store.coverage(r),
        misses=val_misses(model_id, max_misses, r),
        holdout_totals=HoldoutTotals.model_validate(h) if h else None,
        feature_list=current_model_features(model_id),
    )
