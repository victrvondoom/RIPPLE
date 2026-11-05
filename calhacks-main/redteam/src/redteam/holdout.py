"""Holdout custody (plan B6). Built once by us, never by the coordinator, and never written to MongoDB.

Contents, all mutated from the real listings in MongoDB:
  (a) the held-out families (families.json: urgency_pressure, lookalike_domain), with honest listings mixed in;
  (b) a slice of every other scam family.
No base listing gets more than max_per_base (3) copies, and copies are spread over as many bases as there are; LLM
slots that fail are re-requested a bounded number of times and any remaining shortfall is recorded in the meta file.
LLM text is written by the holdout model (Nemotron), which is never used for training. The listings, their answer
keys, cases and the simulated references they need (wallet first-seen dates) are stored together, encrypted,
outside the repo. Only the MCP server process gets the key (HOLDOUT_KEY env). Scoring overlays the simulated
references on a MongoDB reference snapshot in memory and returns totals only.

totals() gives the coordinator recall and false blocks (policy-bounded families excluded from recall, as everywhere).
The operator gets more, written only to the holdout folder (holdout.v3.history.jsonl, never to gate/ or the store):
Layer 2 false blocks, policy-bounded recall, recall on seen vs held-out families, and 95% intervals from a bootstrap
clustered by base listing (copies of one listing are not independent evidence).

Usage:
  uv run --project redteam python -m redteam.holdout build [--force] [--per-family 60] [--slice 20]
  uv run --project redteam python -m redteam.holdout totals --model <model_id|promoted>
  uv run --project redteam python -m redteam.holdout status
"""
import argparse
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

from calhacks_contracts import AnswerKey, Case, GenInfo, HoldoutTotals, Rate, SyntheticListing, rate
from calhacks_contracts.families import policy_bounded_families
from calhacks_contracts.splits import group_of
from cryptography.fernet import Fernet

from redteam import gate_client, scoring, store
from redteam.config import HOLDOUT, HOLDOUT_FILE, HOLDOUT_KEY_FILE, HOLDOUT_MODEL, REPO, holdout_families, scam_families
from redteam.generate import run_spec

META_FILE = HOLDOUT / "holdout.v3.meta.json"
HISTORY_FILE = HOLDOUT / "holdout.v3.history.jsonl"  # operator-only per-model reports
MAX_PER_BASE = 3
FAMILY_WORKERS = 4  # specs generated at once; each also runs its LLM chunks concurrently
RETRIES = 2          # re-requests of slots dropped by the LLM (or by mutation), per spec
CALL_DEADLINE_S = 120.0  # per Bitdeer call; a slow slot is dropped, re-requested, and any rest recorded as shortfall
BOOTSTRAP = 1000


def _key(create: bool = False) -> bytes:
    env = os.environ.get("HOLDOUT_KEY")
    if env:
        return env.encode()
    if HOLDOUT_KEY_FILE.exists():
        return HOLDOUT_KEY_FILE.read_bytes().strip()
    if not create:
        raise RuntimeError("no holdout key: set HOLDOUT_KEY or build the holdout first")
    key = Fernet.generate_key()
    HOLDOUT.mkdir(parents=True, exist_ok=True)
    HOLDOUT_KEY_FILE.write_bytes(key)
    return key


def key_for_mcp_env() -> str:
    """The key string handed to the MCP server process (and nothing else)."""
    return _key().decode()


def available() -> bool:
    return HOLDOUT_FILE.exists() and bool(os.environ.get("HOLDOUT_KEY") or HOLDOUT_KEY_FILE.exists())


def _assert_outside_repo():
    try:
        HOLDOUT.resolve().relative_to(REPO.resolve())
    except ValueError:
        return
    raise RuntimeError(f"holdout dir {HOLDOUT} must be outside the repo {REPO}")


def build(*, force: bool = False, per_family: int = 60, slice_n: int = 20, seed: int = 7, client=None,
          r=None, include_real: bool = False, max_per_base: int = MAX_PER_BASE, retries: int = RETRIES) -> dict:
    """Build the sealed holdout from the real listings in `r`.

    include_real (local dry runs, where `r` holds only the locked-test listings): also seal those real listings
    unmodified as legit rows, plus their wallet first-seen dates, so the holdout measures false blocks on real
    listings the Gate never trained on."""
    _assert_outside_repo()
    if HOLDOUT_FILE.exists() and not force:
        raise RuntimeError(f"{HOLDOUT_FILE} already exists; the holdout is built once (use --force to rebuild)")
    r = r or store.repo()
    specs = [{"spec_id": f"H-{f}", "family": f, "n": per_family, "legit_ratio": 0.3, "mode": "mutate_real"}
             for f in sorted(holdout_families())]
    specs += [{"spec_id": f"H-slice-{f}", "family": f, "n": slice_n, "legit_ratio": 0.0, "mode": "mutate_real"}
              for f in scam_families()]
    items, wallets, dropped, tokens, shortfall = [], {}, Counter(), [], {}
    base_use = Counter()
    gen = lambda spec: run_spec(spec, round_=0, r=r, client=client, write=False, allow_holdout=True, seed=seed,
                                models=[HOLDOUT_MODEL], id_prefix="H", base_use=base_use, max_per_base=max_per_base,
                                call_deadline=CALL_DEADLINE_S)

    def one(spec):
        """All of one spec's listings, re-requesting dropped slots. Specs run in parallel (FAMILY_WORKERS at a time);
        base_use is shared under a lock in run_spec, so the per-base cap holds across threads."""
        outs = []
        n_legit = round(spec["n"] * spec["legit_ratio"])
        want = {"scam": spec["n"] - n_legit, "legit": n_legit}
        have = Counter()
        for attempt in range(retries + 1):
            need = {lab: want[lab] - have[lab] for lab in want if want[lab] > have[lab]}
            if not need:
                break
            # the first call is the spec itself (both labels); re-requests ask for the missing label only
            subs = [spec] if attempt == 0 else [
                {**spec, "spec_id": f"{spec['spec_id']}-r{attempt}{lab[0]}", "n": n,
                 "legit_ratio": 1.0 if lab == "legit" else 0.0} for lab, n in sorted(need.items())]
            for sub in subs:
                out = gen(sub)
                outs.append(out)
                have.update(s.answer_key.label for s, _ in out["_items"])
        return outs, {lab: want[lab] - have[lab] for lab in want if want[lab] > have[lab]}

    with ThreadPoolExecutor(FAMILY_WORKERS) as ex:
        for spec, (outs, short) in zip(specs, ex.map(one, specs)):
            for out in outs:
                items += out["_items"]
                wallets.update(out["_refs"].wallets)
                dropped.update(out["drops_by_family"])
                tokens.append(out["tokens"])
            if short:
                shortfall[spec["spec_id"]] = short
    if include_real:
        ids = r.real_listing_ids()
        cases = r.cases(ids)
        for l in r.listings(ids):
            items.append((SyntheticListing(
                listing=l, answer_key=AnswerKey(listing_id=l.listing_id, label="legit", family="real"),
                gen=GenInfo(listing_id=l.listing_id, model=None, spec_id="H-real")), cases[l.listing_id]))
        wallets = {**r.reference_snapshot().wallets, **wallets}
    payload = {"version": 3, "items": [{"synthetic": s.model_dump(mode="json"), "case": c.model_dump(mode="json")}
                                       for s, c in items],
               "refs": {"wallets": wallets}}
    HOLDOUT.mkdir(parents=True, exist_ok=True)
    HOLDOUT_FILE.write_bytes(Fernet(_key(create=True)).encrypt(json.dumps(payload).encode()))
    synth = [s for s, _ in items if s.answer_key.family != "real"]
    meta = {"n": len(items), "by_family": dict(Counter(s.answer_key.family for s, _ in items)),
            "models": sorted({s.gen.model for s, _ in items if s.gen.model}), "dropped": dict(dropped),
            "shortfall": shortfall, "max_per_base": max_per_base,
            "bases": len({s.answer_key.base_listing_id for s in synth}),
            "max_copies": max(Counter(s.answer_key.base_listing_id for s in synth).values(), default=0),
            "tokens": {"prompt": sum(t["prompt_tokens"] for t in tokens),
                       "completion": sum(t["completion_tokens"] for t in tokens)}}
    META_FILE.write_text(json.dumps(meta, indent=1))
    return meta


def _load():
    payload = json.loads(Fernet(_key()).decrypt(HOLDOUT_FILE.read_bytes()))
    items = []
    for row in payload["items"]:
        s = SyntheticListing.model_validate(row["synthetic"])
        items.append((s.listing, Case.model_validate(row["case"]), s.answer_key))
    return items, payload["refs"]["wallets"]


def _bootstrap(rows: list[dict], groups: list[str], pick, n: int = BOOTSTRAP, seed: int = 0) -> list[float] | None:
    """95% interval of a rate, resampling whole clusters (base listings) with replacement."""
    per = defaultdict(lambda: [0, 0])
    for row, g in zip(rows, groups):
        hit = pick(row)
        if hit is not None:
            per[g][0] += hit
            per[g][1] += 1
    if not per:
        return None
    cl = list(per.values())
    rng = random.Random(seed)
    stats = []
    for _ in range(n):
        k = m = 0
        for _ in cl:
            a, b = cl[rng.randrange(len(cl))]
            k, m = k + a, m + b
        stats.append(k / m if m else 0.0)
    stats.sort()
    return [round(stats[int(0.025 * n)], 4), round(stats[min(n - 1, int(0.975 * n))], 4)]


def report(model_id: str, r=None) -> dict:
    """Operator view of one model on the holdout: totals, recall on seen vs held-out families, and 95% intervals
    clustered by base listing. Never rows."""
    items, wallets = _load()
    refs = (r or store.repo()).reference_snapshot().overlay(wallets=wallets)
    m = gate_client.evaluate_items(model_id, items, refs, rows=True)
    if m.get("error"):
        raise RuntimeError(m["error"])
    rows = m["rows"]
    base = {l.listing_id: k.base_listing_id for l, _, k in items}
    groups = [group_of(x["listing_id"], base.get(x["listing_id"])) for x in rows]
    held, bounded = holdout_families(), policy_bounded_families()
    skip = lambda x: x["decision"]["decision"] == "skip"
    scam = lambda x: x["label"] == "scam"
    seen_fam = lambda f: f not in bounded | held
    picks = {
        "recall": lambda x: skip(x) if scam(x) and x["family"] not in bounded else None,
        "fpr": lambda x: skip(x) if not scam(x) else None,
        "layer2_fpr": lambda x: skip(x) if not scam(x) and x["decision"]["decided_by"] != "layer1" else None,
        "policy_bounded_recall": lambda x: skip(x) if scam(x) and x["family"] in bounded else None,
        "recall_seen": lambda x: skip(x) if scam(x) and seen_fam(x["family"]) else None,
        "recall_held_out": lambda x: skip(x) if scam(x) and x["family"] in held else None,
    }
    met = scoring.metrics(rows).model_dump(mode="json")
    out = {"model_id": m["model_id"], "at": time.time(), "n": len(rows), "clusters": len(set(groups)),
           "totals": {k: met.get(k) for k in ("recall", "fpr", "layer2_fpr", "policy_bounded_recall")},
           "groups": {}, "ci95_cluster": {}}
    for g, keep in (("seen", seen_fam), ("held_out", lambda f: f in held)):
        rs = [x for x in rows if scam(x) and keep(x["family"])]
        out["groups"][g] = rate(sum(map(skip, rs)), len(rs)).model_dump(mode="json") if rs else None
    for k, pick in picks.items():
        out["ci95_cluster"][k] = _bootstrap(rows, groups, pick)
    return out


def totals(model_id: str, r=None) -> HoldoutTotals | None:
    """Aggregate holdout recall and false-block rate for one model (what the coordinator may see). Never returns rows.
    The fuller operator report is appended to HISTORY_FILE, outside the repo."""
    if not available():
        return None
    rep = report(model_id, r)
    with HISTORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rep) + "\n")
    t = rep["totals"]
    opt = lambda k: Rate.model_validate(t[k]) if t.get(k) else None
    return HoldoutTotals(model_id=rep["model_id"], recall=Rate.model_validate(t["recall"]),
                         fpr=Rate.model_validate(t["fpr"]), layer2_fpr=opt("layer2_fpr"),
                         policy_bounded_recall=opt("policy_bounded_recall"))


def history(model_id: str | None = None) -> list[dict]:
    """Operator-only per-model holdout reports (latest last)."""
    if not HISTORY_FILE.exists():
        return []
    rows = [json.loads(l) for l in HISTORY_FILE.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [x for x in rows if model_id is None or x["model_id"] == model_id]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--force", action="store_true")
    b.add_argument("--per-family", type=int, default=60)
    b.add_argument("--slice", type=int, default=20)
    t = sub.add_parser("totals")
    t.add_argument("--model", required=True)
    sub.add_parser("status")
    a = ap.parse_args(argv)
    if a.cmd == "build":
        out = build(force=a.force, per_family=a.per_family, slice_n=a.slice)
    elif a.cmd == "totals":
        out = report(a.model) if available() else {"error": "no holdout built"}
    else:
        out = json.loads(META_FILE.read_text()) if META_FILE.exists() else {"error": "no holdout built"}
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
