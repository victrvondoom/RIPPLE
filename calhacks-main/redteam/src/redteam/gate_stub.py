"""Stand-in for the real Gate until feat/gate is merged. Same inputs and outputs as contracts/interfaces.md:
train -> {"model_id", "round", "kind", "features", "n_train", "n_val", "threshold", "val": RoundMetrics};
evaluate -> {"model_id", "metrics": RoundMetrics, "rows"?: [{..., "decision": GateDecision}]}.

Layer 1 follows the interfaces.md rule table. Layer 2 is a small logistic regression over eight hand-written features
of the GateInput (never the answer key). It ignores gate/features/*, so coordinator edits have no effect on it.
"""
import difflib
import hashlib
import json
import math
import re
import unicodedata
from datetime import date, datetime, timezone

from calhacks_contracts import AnswerKey, Case, Check, GateDecision, GateInput, Listing, Reason
from calhacks_contracts.db import ReferenceSet
from calhacks_contracts.families import allowlist, holdout_families, injection_patterns
from calhacks_contracts.splits import split_of

from redteam import scoring, store
from redteam.config import MAX_FPR, MODELS_DIR

TODAY = date(2026, 10, 24)
FEATURES = ["price_ratio", "known_wallet", "wallet_age_days", "injection_hits", "hidden_chars", "review_dup_max",
            "domain_sim"]
MONOTONE = [-1, -1, -1, 1, 1, 1, 1]


# ---------- Layer 1 ----------
def layer1(x: GateInput) -> list[Check]:
    a, l, m, refs = allowlist(), x.listing, x.mandate, x.references
    known = {k.pay_to.lower() for k in refs.known_sellers}
    is_known = l.checkout.pay_to.lower() in known
    t = l.checkout.max_timeout_seconds
    rows = [
        ("L1_PAYTO_MISMATCH", l.checkout.pay_to.lower() == l.seller.pay_to.lower()),
        ("L1_UNKNOWN_SELLER_CAP", is_known or l.item.price <= a["unknown_seller_cap_usd"]),
        ("L1_AMOUNT_MISMATCH", int(l.checkout.amount) == round(l.item.price * 10 ** a["usdc_decimals"])),
        ("L1_OVER_MAX", l.item.price <= m.max_price),
        ("L1_OVER_BUDGET", l.item.price <= m.spend_remaining),
        ("L1_NETWORK", l.checkout.network in a["networks"]),
        ("L1_ASSET", l.checkout.asset.lower() == a["assets"].get(l.checkout.network, "").lower()),
        ("L1_ITEM_MISMATCH", l.checkout.item_id == l.item.id),
        ("L1_PRODUCT_MISMATCH", l.item.product_key == m.product_key),
        ("L1_TIMEOUT", t is None or t <= a["max_timeout_s"]),
    ]
    return [Check(rule=r, passed=ok) for r, ok in rows]


# ---------- Layer 2 features ----------
def _days(d: str | None, default: float) -> float:
    if not d:
        return default
    try:
        return float((TODAY - date.fromisoformat(d[:10])).days)
    except ValueError:
        return default


def _tokens(s: str) -> set[str]:
    return set(re.findall(r"[a-z]+", s.lower()))


def featurize(x: GateInput) -> list[float]:
    l, refs = x.listing, x.references
    text = l.item.text + " " + " ".join(l.reviews)
    norm = unicodedata.normalize("NFKC", text)
    pats = [re.compile(p, re.I) for p in injection_patterns()["patterns"]]
    zw = set(injection_patterns()["zero_width_chars"])
    mixed = sum(1 for w in norm.split() if re.search(r"[a-zA-Z]", w) and re.search(r"[Ѐ-ӿ]", w))
    bodies = [_tokens(r) for r in l.reviews]
    dup = max((len(a & b) / max(1, len(a | b)) for i, a in enumerate(bodies) for b in bodies[i + 1:]), default=0.0)
    known = {k.pay_to.lower() for k in refs.known_sellers}
    domains = [k.domain for k in refs.known_sellers if k.domain != l.seller.domain]
    dsim = max((difflib.SequenceMatcher(None, l.seller.domain, d).ratio() for d in domains), default=0.0)
    return [
        l.item.price / refs.market_median if refs.market_median else 1.0,
        float(l.checkout.pay_to.lower() in known),
        min(_days(refs.pay_to_first_seen, 0.0), 3650.0),
        float(sum(bool(p.search(norm)) for p in pats)),
        float(sum(text.count(c) for c in zw) + mixed),
        dup,
        dsim,
    ]


def _sigmoid(z):
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def _fit(X, y, epochs=400, lr=0.3):
    cols = list(zip(*X))
    mu = [sum(c) / len(c) for c in cols]
    sd = [max(1e-6, (sum((v - m) ** 2 for v in c) / len(c)) ** 0.5) for c, m in zip(cols, mu)]
    Z = [[(v - m) / d for v, m, d in zip(x, mu, sd)] for x in X]
    w, b = [0.0] * len(mu), 0.0
    for _ in range(epochs):
        gw, gb = [0.0] * len(w), 0.0
        for z, t in zip(Z, y):
            e = _sigmoid(sum(a * c for a, c in zip(w, z)) + b) - t
            gw = [g + e * c for g, c in zip(gw, z)]
            gb += e
        w = [a - lr * g / len(Z) for a, g in zip(w, gw)]
        b -= lr * gb / len(Z)
    w = [0.0 if mo and a * mo < 0 else a for a, mo in zip(w, MONOTONE)]  # monotone constraints
    return {"mu": mu, "sd": sd, "w": w, "b": b}


def _score(coef, x):
    z = [(v - m) / d for v, m, d in zip(x, coef["mu"], coef["sd"])]
    contrib = [a * c for a, c in zip(coef["w"], z)]
    return _sigmoid(sum(contrib) + coef["b"]), contrib


def decide(model: dict, x: GateInput) -> GateDecision:
    checks = layer1(x)
    failed = next((c.rule for c in checks if not c.passed), None)
    if failed:
        return GateDecision(decision="skip", decided_by="layer1", failed_rule=failed, model_version=model["model_id"],
                            checks=checks)
    feats = featurize(x)
    risk, contrib = _score(model["coef"], feats)
    top = sorted(zip(FEATURES, feats, contrib), key=lambda t: -t[2])[:3]
    skip = risk >= model["threshold"]
    return GateDecision(decision="skip" if skip else "buy", decided_by="layer2" if skip else None,
                        risk_score=round(risk, 4), threshold=model["threshold"],
                        top_reasons=[Reason(feature=f, value=round(v, 4), contribution=round(c, 4)) for f, v, c in top],
                        model_version=model["model_id"], checks=checks)


# ---------- train / evaluate ----------
def gate_input(listing: Listing, case: Case, refs: ReferenceSet) -> GateInput:
    return GateInput(mandate=case.mandate, listing=listing, references=refs.for_listing(listing))


def _row(model, item, refs) -> dict:
    listing, case, key = item
    d = decide(model, gate_input(listing, case, refs))
    return {"listing_id": listing.listing_id, "label": key.label, "family": key.family,
            "attacker_knowledge": key.attacker_knowledge, "decision": d.model_dump(mode="json")}


def load(model_id: str) -> dict:
    if model_id == "promoted":
        model_id = json.loads((MODELS_DIR / "promoted.json").read_text())["model_id"]
    return json.loads((MODELS_DIR / f"{model_id}.json").read_text())


def train(round_: int) -> dict:
    r = store.repo()
    refs = r.reference_snapshot()
    ids = store.listing_ids(r, rounds=range(0, round_ + 1))
    its = [it for it in store.items(r, ids) if it[2].family not in holdout_families()]
    side = {it[0].listing_id: split_of(it[0].listing_id, it[2].base_listing_id) for it in its}
    tr = [it for it in its if side[it[0].listing_id] == "train"]
    va = [it for it in its if side[it[0].listing_id] == "val"]
    cal = [it for it in its if side[it[0].listing_id] == "calibrate"] or va
    if not tr or not va or len({it[2].label for it in tr}) < 2:
        return {"error": f"need train and val rows with both labels (train={len(tr)}, val={len(va)})"}
    X = [featurize(gate_input(l, c, refs)) for l, c, _ in tr]
    coef = _fit(X, [1 if k.label == "scam" else 0 for _, _, k in tr])
    # threshold: lowest cut whose Layer-2 false-block rate on calibrate legit rows (that pass Layer 1) stays <= MAX_FPR
    legit_risks = sorted((_score(coef, featurize(gi))[0] for l, c, k in cal if k.label == "legit"
                          for gi in [gate_input(l, c, refs)] if all(ch.passed for ch in layer1(gi))), reverse=True)
    allowed = int(MAX_FPR * len(legit_risks))
    threshold = round(legit_risks[allowed] + 1e-6, 6) if len(legit_risks) > allowed else 0.5
    data_hash = hashlib.sha256("".join(sorted(l.listing_id for l, _, _ in tr)).encode()).hexdigest()[:12]
    model_id = f"r{round_}-stub-{data_hash[:6]}"
    model = {"model_id": model_id, "round": round_, "kind": "stub", "features": FEATURES, "monotone": MONOTONE,
             "threshold": threshold, "coef": coef, "train_data_hash": data_hash, "feature_code_hash": "stub"}
    val = scoring.metrics([_row(model, it, refs) for it in va]).model_dump(mode="json")
    model["val_metrics"] = val
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / f"{model_id}.json").write_text(json.dumps(model, indent=1))
    return {"model_id": model_id, "round": round_, "kind": "stub", "features": FEATURES, "n_train": len(tr),
            "n_val": len(va), "threshold": threshold, "val": val}


def evaluate_items(model_id: str, its: list[tuple[Listing, Case, AnswerKey]], refs: ReferenceSet,
                   rows: bool = False) -> dict:
    try:
        model = load(model_id)
    except FileNotFoundError:
        return {"error": f"unknown model {model_id!r}"}
    out_rows = [_row(model, it, refs) for it in its]
    out = {"model_id": model["model_id"], "metrics": scoring.metrics(out_rows).model_dump(mode="json")}
    if rows:
        out["rows"] = out_rows
    return out


def evaluate(model_id: str, split: str = "all", ids: list[str] | None = None, rows: bool = False) -> dict:
    r = store.repo()
    ids = ids if ids is not None else store.listing_ids(r, split=split)
    if split != "all":
        sides = store.split_map(r, ids)
        ids = [i for i in ids if sides[i] == split]
    return evaluate_items(model_id, store.items(r, ids), r.reference_snapshot(), rows)


def features() -> list[str]:
    return list(FEATURES)



def set_promoted(model_id: str, val: dict, holdout: dict | None) -> dict:
    """Same promoted.json shape as gatepy.model_io.set_promoted."""
    p = MODELS_DIR / "promoted.json"
    state = json.loads(p.read_text()) if p.exists() else {"model_id": None, "history": []}
    state["model_id"] = model_id
    state["history"].append({"model_id": model_id, "round": load(model_id).get("round"),
                             "promoted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "val": val, "holdout": holdout})
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=1))
    return state
