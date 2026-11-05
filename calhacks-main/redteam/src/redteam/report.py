"""Rounds table for the demo and dashboard, read from MongoDB (`rounds` collection) and promoted.json.

Per round: attack success of fresh attacks against last round's model, the candidate's validation numbers (recall,
false blocks, false blocks on real listings, adaptive recall), the code's promotion decision, holdout totals for the
promoted model, cost and hook denials.

Usage: uv run --project redteam python -m redteam.report [--json]
"""
import argparse
import json
import sys

from redteam import store
from redteam.config import DATA
from redteam.promotion import current


def _v(rate):
    return rate and rate.get("value")


def rows() -> list[dict]:
    history = {h["model_id"]: h for h in current()["history"]}
    out = []
    for doc in store.all_rounds(store.repo()):
        rep = doc.get("report") or {}
        m = rep.get("metrics") or {}
        promos = doc.get("promotions") or []
        promoted = [p["model_id"] for p in promos if p.get("promoted")]
        h = history.get(promoted[-1]) if promoted else None
        hold = (h or {}).get("holdout") or {}
        usage = doc.get("usage") or {}
        out.append({
            "round": doc["_id"],
            "attack_success": ((doc.get("attack") or {}).get("attack_success") or {}).get("value"),
            "candidate": promos[-1]["model_id"] if promos else None,
            "decision": (rep.get("decision") or {}).get("action"),
            "val_recall": _v(m.get("recall")),
            "val_fpr": _v(m.get("fpr")),
            "fpr_real": _v(m.get("fpr_real")),
            "layer2_recall": _v(m.get("layer2_recall")),
            "adaptive_recall": _v(m.get("adaptive_recall")),
            "holdout_recall": _v(hold.get("recall")),
            "holdout_fpr": _v(hold.get("fpr")),
            "tokens": (rep.get("cost") or {}).get("tokens"),
            "usd": (rep.get("cost") or {}).get("usd"),
            "hook_denials": len(usage.get("hook_denials") or []),
        })
    return out


def fmt(v, col=""):
    if v is None:
        return "-"
    if col == "usd":
        return f"${v:.3f}"
    if isinstance(v, float):
        return f"{v:.1%}" if v <= 1 else f"{v:.2f}"
    return str(v)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    data = rows()
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "report.json").write_text(json.dumps(data, indent=1, default=str))
    if a.json:
        print(json.dumps(data, indent=1, default=str))
        return 0
    cols = list(data[0]) if data else ["round"]
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for r in data:
        print("| " + " | ".join(fmt(r[c], c) for c in cols) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
