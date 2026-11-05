"""Artifact audit: can generated listings be told apart from real ones by anything other than the attack itself?

  uv run --project redteam python -m redteam.audit --store <local store dir> [--json out.json]

The coordinator also runs it after every round on that round's synthetic listings (audit_repo, ids=...).

For every family with enough rows, a small classifier tries to separate that family's listings from real listings,
using only "untouched" traits: features derived from fields the family's attack is not supposed to change. Real
listings are restricted to those that can reach Layer 2 (known wallet, or unknown wallet within the cap), the same
pool the generator draws Layer 2 bases from. Cross-validation is grouped by base listing, so copies of one listing never
sit in both the training and the test fold.

AUC 0.5 = indistinguishable (good). A family whose AUC is well above 0.5 carries a tell the Gate can learn instead of the
scam; the report names the trait that separates it most.
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

import numpy as np

from calhacks_contracts.families import allowlist

# Trait groups, and which groups each family's attack may legitimately change (so they are excluded for that family).
TRAITS = {
    "name": ["name_len", "name_digits", "name_trailing_digits", "name_has_sep", "name_upper_ratio", "name_word_digits"],
    "wallet": ["wallet_age_days"],
    "reviews": ["review_count", "review_len_mean", "review_len_std"],
    "text": ["text_len", "text_words", "text_lines"],
}
TOUCHES = {
    "hidden_text": {"text"}, "prompt_injection": {"text", "reviews"}, "urgency_pressure": {"text", "reviews"},
    "fake_reviews": {"reviews"}, "legit_mixed_reviews": {"reviews"}, "legit_real_discount": {"text"},
    "legit_rewrite": {"text"},  # rewrites the text by design; its style is checked against LLM-written scams
    # the wallet is the attack; a lookalike also imitates a known seller's name
    "payment_mismatch": {"wallet"}, "lookalike_payto": {"wallet", "name"},
    # a new seller legitimately has a new wallet, but its name should still look like a real seller's
    "unknown_seller": {"wallet"}, "legit_new_seller": {"wallet"}, "lookalike_domain": {"wallet"},
}
SYNTHETIC_NAME = re.compile(r"[a-z]{8,}\d{3,4}$")  # the shape dry-3's coach learned to spot
AUC_LIMIT = 0.60
MIN_ROWS = 15
PERMUTATIONS = 20   # label shuffles per comparison: small families are noisy (20 random real rows reach 0.6+ ~10%)
P_LIMIT = 0.05      # fail only if AUC > AUC_LIMIT and chance rarely matches it


def traits(listing: dict, wallets: dict[str, str | None], as_of: str) -> dict[str, float]:
    from datetime import date
    name = listing["seller"]["id"].split(":", 1)[-1]
    trailing = re.search(r"\d+$", name)
    seen = wallets.get(listing["checkout"]["pay_to"].lower())
    age = (date.fromisoformat(as_of) - date.fromisoformat(seen[:10])).days if seen else -1
    revs = [len(r) for r in listing["reviews"]]
    text = listing["item"]["text"]
    return {
        "name_len": len(name), "name_digits": sum(c.isdigit() for c in name),
        "name_trailing_digits": len(trailing.group(0)) if trailing else 0,
        "name_has_sep": float(bool(re.search(r"[-_. ]", name))),
        "name_upper_ratio": sum(c.isupper() for c in name) / max(1, len(name)),
        "name_word_digits": float(bool(SYNTHETIC_NAME.search(name))),
        "wallet_age_days": float(age),
        "review_count": float(len(revs)), "review_len_mean": float(np.mean(revs)) if revs else 0.0,
        "review_len_std": float(np.std(revs)) if revs else 0.0,
        "text_len": float(len(text)), "text_words": float(len(text.split())), "text_lines": float(text.count("\n") + 1),
    }


def _auc(y, p) -> float:
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(y, p))


def compare(pos: list[dict], neg: list[dict], cols: list[str], groups_pos: list[str], groups_neg: list[str],
            permutations: int = 0) -> dict:
    """Grouped-CV AUC of a small random forest separating pos from neg, plus the single most separating trait.
    With permutations > 0, also a permutation p-value: how often shuffled labels score at least as high."""
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import GroupKFold, cross_val_predict
    X = np.array([[r[c] for c in cols] for r in pos + neg])
    y = np.array([1] * len(pos) + [0] * len(neg))
    g = np.array(groups_pos + groups_neg)
    folds = min(5, len(set(g)))
    clf = RandomForestClassifier(n_estimators=200, max_depth=4, random_state=0, class_weight="balanced")
    p = cross_val_predict(clf, X, y, cv=GroupKFold(n_splits=folds), groups=g, method="predict_proba")[:, 1]
    auc = _auc(y, p)
    pval = None
    if permutations:
        rng = np.random.default_rng(0)
        fast = RandomForestClassifier(n_estimators=60, max_depth=4, random_state=0, class_weight="balanced")
        hits = 0
        for _ in range(permutations):
            ys = rng.permutation(y)
            ps = cross_val_predict(fast, X, ys, cv=GroupKFold(n_splits=folds), groups=g, method="predict_proba")[:, 1]
            hits += _auc(ys, ps) >= auc
        pval = (hits + 1) / (permutations + 1)
    uni = {}
    for j, c in enumerate(cols):
        if len(set(X[:, j])) > 1:
            a = _auc(y, X[:, j])
            uni[c] = max(a, 1 - a)
    top = sorted(uni.items(), key=lambda kv: -kv[1])[:3]
    return {"auc": round(auc, 3), "p": None if pval is None else round(pval, 3), "n_pos": len(pos),
            "n_neg": len(neg), "top_traits": [[c, round(a, 3)] for c, a in top]}


def audit(store_dir: Path, as_of: str) -> dict:
    """Audit a local store directory (one JSONL file per collection)."""
    rd = lambda name: [json.loads(l) for l in (store_dir / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
                       if l.strip()] if (store_dir / f"{name}.jsonl").exists() else []  # e.g. no wallet history
    return _audit(rd, as_of)


def audit_repo(r, as_of: str, ids: Iterable[str] | None = None) -> dict:
    """Audit a Repo (Mongo, mongomock or a loaded local store). With ids, only those synthetic listings are audited
    (e.g. one round's); real listings always come from the whole store."""
    keep = None if ids is None else set(ids)
    rd = lambda name: list(r.db[name].find())
    return _audit(rd, as_of, keep)


def _audit(rd, as_of: str, keep: set[str] | None = None) -> dict:
    listings = {d["_id"]: d for d in rd("listings")}
    keys = {d["_id"]: d for d in rd("answer_keys")
            if keep is None or d["family"] == "real" or d["_id"] in keep}
    wallets = {d["_id"]: d.get("first_seen") for d in rd("wallets")}
    gen = {d["_id"]: d for d in rd("gen")}
    known = {d["pay_to"].lower() for d in rd("known_sellers")}
    cap = allowlist()["unknown_seller_cap_usd"]
    t = {lid: traits(l, wallets, as_of) for lid, l in listings.items() if lid in keys}
    all_real = [lid for lid, k in keys.items() if k["family"] == "real"]
    real = [lid for lid in all_real
            if listings[lid]["checkout"]["pay_to"].lower() in known or listings[lid]["item"]["price"] <= cap]
    from calhacks_contracts.families import families as _families
    fam_meta = _families()
    fam_rows = defaultdict(list)
    for lid, k in keys.items():
        if k["family"] != "real":
            fam_rows[k["family"]].append(lid)
    all_cols = [c for grp in TRAITS.values() for c in grp]
    out = {"real_pool": len(real), "families": {}, "checks": {}}
    base_of = lambda lid: keys[lid].get("base_listing_id") or lid
    for fam, ids in sorted(fam_rows.items()):
        if len(ids) < MIN_ROWS:
            continue
        cols = [c for grp, cs in TRAITS.items() if grp not in TOUCHES.get(fam, set()) for c in cs]
        # Layer 1 families draw bases from every real listing, Layer 2 and honest ones only from those reaching Layer 2
        pool = all_real if (fam_meta.get(fam) or {}).get("expected_layer") == "layer1" else real
        out["families"][fam] = compare([t[i] for i in ids], [t[i] for i in pool], cols,
                                       [base_of(i) for i in ids], pool, PERMUTATIONS)
    legit = [i for f, ids in fam_rows.items() if f.startswith("legit") for i in ids]
    if len(legit) >= MIN_ROWS:
        # seller traits only: text and reviews are rewritten by some honest families on purpose (checked per family
        # and by the LLM-style check below)
        seller_cols = TRAITS["name"] + TRAITS["wallet"]
        out["checks"]["honest_generated_vs_real_seller"] = compare([t[i] for i in legit], [t[i] for i in real],
                                                                   seller_cols, [base_of(i) for i in legit], real, PERMUTATIONS)
    llm_scam = [i for f, ids in fam_rows.items() if not f.startswith("legit") for i in ids if (gen.get(i) or {}).get("model")]
    llm_legit = [i for f, ids in fam_rows.items() if f.startswith("legit") for i in ids if (gen.get(i) or {}).get("model")]
    if len(llm_scam) >= MIN_ROWS and len(llm_legit) >= MIN_ROWS:
        style = TRAITS["text"] + TRAITS["reviews"]
        out["checks"]["llm_scam_vs_llm_honest_style"] = compare(
            [t[i] for i in llm_scam], [t[i] for i in llm_legit], style,
            [base_of(i) for i in llm_scam], [base_of(i) for i in llm_legit], PERMUTATIONS)
    rows = list(out["families"].items()) + list(out["checks"].items())
    out["failing"] = sorted(k for k, v in rows if failing(v))
    out["auc_limit"], out["p_limit"] = AUC_LIMIT, P_LIMIT
    return out


def failing(v: dict) -> bool:
    return v["auc"] > AUC_LIMIT and (v.get("p") is None or v["p"] < P_LIMIT)


def table(res: dict) -> str:
    lines = [f"real pool (reaches Layer 2): {res['real_pool']}   fail = AUC > {res['auc_limit']} and "
             f"permutation p < {res['p_limit']}",
             f"{'comparison':34}{'AUC':>7}{'p':>7}{'rows':>7}  top traits"]
    for k, v in list(res["families"].items()) + list(res["checks"].items()):
        mark = "FAIL" if failing(v) else "ok"
        tops = ", ".join(f"{c} {a}" for c, a in v["top_traits"])
        lines.append(f"{k:34}{v['auc']:>7}{str(v.get('p')):>7}{v['n_pos']:>7}  {mark:4} {tops}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", type=Path, required=True)
    ap.add_argument("--as-of", default="2026-10-24")
    ap.add_argument("--json", type=Path)
    a = ap.parse_args(argv)
    res = audit(a.store, a.as_of)
    if a.json:
        a.json.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(table(res))
    return 1 if res["failing"] else 0


if __name__ == "__main__":
    sys.exit(main())
