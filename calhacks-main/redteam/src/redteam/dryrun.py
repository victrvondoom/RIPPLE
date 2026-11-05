"""Local dry runs: the full red-team loop on a frozen scrape snapshot, with every artifact on disk (no MongoDB).

  python -m redteam.dryrun init    --run DIR --snapshot SNAP [--seed N] [--knowledge blind|white_box] [--all-known]
  python -m redteam.dryrun holdout --run DIR [--per-family 60] [--slice 20]
  python -m redteam.dryrun round   --run DIR --round N [--max-listings 300]
  python -m redteam.dryrun summary --run DIR

Run each dry run from its own git worktree: the coordinator edits gate/features in the worktree that runs it, and
`round` saves those edits as DIR/diffs/R{n}.diff. DIR must be outside the repo (the holdout lives in DIR/holdout).

Layout of DIR: run.json, store/ (the local database, one JSONL file per collection), models/ (models and
promoted.json), data/ (round logs, guard log), holdout/ (encrypted locked test set), diffs/, summary.json, summary.md.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


def env_for(run: Path, cfg: dict) -> dict:
    env = {"REDTEAM_LOCAL_STORE": str(run / "store"), "CALHACKS_MODELS": str(run / "models"),
           "CALHACKS_DATA": str(run / "data"), "CALHACKS_HOLDOUT": str(run / "holdout"), "REDTEAM_GATE": "real",
           "GATE_AS_OF": cfg["as_of"], "REDTEAM_SEED": str(cfg["seed"]), "UV_SYSTEM_CERTS": "1",
           "PYTHONIOENCODING": "utf-8"}
    if cfg.get("knowledge"):
        env["REDTEAM_ATTACKER_KNOWLEDGE"] = cfg["knowledge"]
    if cfg.get("base_store"):  # every seen family is in the data, so promotion can insist on checking each one
        env["REDTEAM_REQUIRE_COVERAGE"] = "1"
    return env


def _cfg(run: Path) -> dict:
    return json.loads((run / "run.json").read_text(encoding="utf-8"))


def _apply_env(run: Path) -> dict:
    cfg = _cfg(run)
    os.environ.update(env_for(run, cfg))
    return cfg


# ---------- seeding ----------
def _jsonl(path: Path, model):
    return [model.model_validate_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def seed_repo(r, snap: Path, side: str, all_known: bool, as_of: str) -> dict:
    """Load one side of a snapshot into a Repo: real listings (answer key real/legit), cases, the known-wallet list,
    the train-side medians and wallet first-seen dates."""
    from calhacks_contracts import AnswerKey, Case, KnownSeller, Listing, ListingMeta
    d = snap / side
    listings, meta, cases = _jsonl(d / "listings.jsonl", Listing), _jsonl(d / "meta.jsonl", ListingMeta), \
        _jsonl(d / "cases.jsonl", Case)
    r.put_listings(listings, meta)
    r.put_answer_keys([AnswerKey(listing_id=l.listing_id, label="legit", family="real") for l in listings])
    r.put_cases(cases)
    known = [KnownSeller.model_validate(k) for k in
             json.loads((snap / ("known_sellers_all.json" if all_known else "known_sellers.json")).read_text())]
    for k in known:
        r.put_known_seller(k)
    for m in json.loads((snap / "medians.json").read_text()):
        r.put_median(m["product_key"], m["condition"], m["median"], m["n"], f"scrape:{m['level']}", as_of)
    history = json.loads((snap / "manifest.json").read_text()).get("wallet_history", True)  # v1 snapshots had it
    wallets = json.loads((d / "wallets.json").read_text())
    if all_known and history:  # every real seller is vouched for: give their wallets the known-wallet history
        old = (date.fromisoformat(as_of) - timedelta(days=365)).isoformat()
        wallets = {w: old for w in wallets}
    for w, seen in wallets.items():
        r.touch_wallet(w, seen)
    for k in known if history else ():
        r.touch_wallet(k.pay_to, (date.fromisoformat(as_of) - timedelta(days=365)).isoformat())
    return {"listings": len(listings), "known_sellers": len(known)}


BASE_COLLECTIONS = ("listings", "listing_meta", "answer_keys", "cases", "gen", "specs")


def add_base_dataset(r, base_store: Path) -> dict:
    """Copy the synthetic listings of a base dataset (a store generated evenly over every seen family from the same
    snapshot side) into `r` as round 0. The coordinator's data is added on top, so no seen family can drop out of
    training or validation whatever it chooses to generate."""
    from redteam import store
    b = store.load_local(base_store)
    if set(b.real_listing_ids()) != set(r.real_listing_ids()):
        raise SystemExit(f"{base_store} was not built from this snapshot side (its real listings differ)")
    synthetic = [k["_id"] for k in b.db.answer_keys.find({"family": {"$ne": "real"}}, {"_id": 1})]
    for name in BASE_COLLECTIONS:
        docs = list(b.db[name].find({} if name == "specs" else {"_id": {"$in": synthetic}}))
        for d in docs:
            if name == "specs":
                d["round"] = 0
        if docs:
            r.db[name].insert_many(docs)
    return {"base_listings": len(synthetic)}


def copy_holdout(src: Path, run: Path) -> dict:
    """Reuse a sealed holdout (built once per snapshot; the coordinator never sees it): the encrypted file, its key and
    meta, without the earlier run's history."""
    dst = run / "holdout"
    dst.mkdir(parents=True, exist_ok=True)
    files = [f for f in src.iterdir() if f.is_file() and not f.name.endswith("history.jsonl")]
    if not any(f.name.endswith(".enc") for f in files):
        raise SystemExit(f"no sealed holdout in {src}")
    for f in files:
        shutil.copy2(f, dst / f.name)
    return {"holdout_files": sorted(f.name for f in files)}


def promote_baseline(run: Path) -> dict:
    """Train the Gate on round 0 (real listings plus the base dataset) with the committed features and make it the
    incumbent, so round 1's candidates must beat it rather than nothing."""
    _apply_env(run)
    from redteam import gate_client, holdout, promotion, store
    store.reload()
    t = gate_client.train(0)
    if t.get("error"):
        raise SystemExit(f"baseline training failed: {t['error']}")
    res = promotion.promote(t["model_id"], holdout.totals if holdout.available() else None)
    if not res["promoted"]:  # the incumbent is the baseline whatever its numbers; record why it would be refused
        h = holdout.totals(t["model_id"]) if holdout.available() else None
        gate_client.set_promoted(t["model_id"], res.get("candidate_val") or t.get("val"),
                                 h.model_dump(mode="json") if h else None)
    return {"baseline": t["model_id"], "baseline_refusals": res["reasons"]}


def init(run: Path, snap: Path, seed: int, knowledge: str | None, all_known: bool, base_store: Path | None = None,
         holdout_from: Path | None = None) -> dict:
    if (run / "run.json").exists():
        raise SystemExit(f"{run} already initialised")
    manifest = json.loads((snap / "manifest.json").read_text())
    cfg = {"snapshot": str(snap), "snapshot_hashes": manifest["hashes"], "as_of": manifest["as_of"], "seed": seed,
           "knowledge": knowledge, "all_known": all_known, "base_store": base_store and str(base_store),
           "holdout_from": holdout_from and str(holdout_from),
           "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    for sub in ("store", "models", "data", "holdout", "diffs"):
        (run / sub).mkdir(parents=True, exist_ok=True)
    (run / "run.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    _apply_env(run)
    from redteam import store
    r = store.empty_local_repo()
    out = seed_repo(r, snap, "train", all_known, cfg["as_of"])
    if base_store:
        out.update(add_base_dataset(r, base_store))
    store.write_local(r, run / "store")
    if holdout_from:
        out.update(copy_holdout(holdout_from, run))
    if base_store:
        out.update(promote_baseline(run))
    return {"run": str(run), **out}


def build_holdout(run: Path, per_family: int, slice_n: int) -> dict:
    cfg = _apply_env(run)
    from redteam import bitdeer, holdout, store
    locked = store.empty_local_repo()
    seed_repo(locked, Path(cfg["snapshot"]), "locked_test", cfg["all_known"], cfg["as_of"])
    meta = holdout.build(per_family=per_family, slice_n=slice_n, seed=cfg["seed"], client=bitdeer.make_client(),
                         r=locked, include_real=True)
    return meta


# ---------- rounds ----------
def run_round(run: Path, round_: int, max_listings: int, timeout_s: int) -> dict:
    cfg = _apply_env(run)  # before redteam.config is imported: it reads its paths once
    from redteam.config import REPO
    env = {**os.environ, **env_for(run, cfg)}
    n = 1
    while (run / "data" / f"coordinator-R{round_}-a{n}.log").exists():
        n += 1
    log = run / "data" / f"coordinator-R{round_}-a{n}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as f:
        try:
            proc = subprocess.run([sys.executable, "-m", "redteam.coordinator", "--round", str(round_),
                                   "--max-listings", str(max_listings)], cwd=REPO, env=env, stdout=f,
                                  stderr=subprocess.STDOUT, timeout=timeout_s)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            code = "timeout"
    subprocess.run(["git", "add", "--intent-to-add", "--", "gate/features"], cwd=REPO, capture_output=True)  # new files
    diff = subprocess.run(["git", "diff", "--", "gate/features", "gate/train_config.yaml"], cwd=REPO,
                          capture_output=True, text=True, encoding="utf-8").stdout
    (run / "diffs" / f"R{round_}.diff").write_text(diff, encoding="utf-8")
    s = summary(run)
    return {"round": round_, "exit": code, "diff_lines": diff.count("\n"), "log": str(log),
            "row": next((x for x in s["rounds"] if x["round"] == round_), None), "spend_usd": s["spend_usd"]}


# ---------- summary ----------
def _rate(m: dict | None, key: str):
    v = (m or {}).get(key)
    return None if v is None else {"value": round(v["value"], 4), "lo": round(v["lo"], 4), "hi": round(v["hi"], 4),
                                   "n": v["n"]}


def summary(run: Path) -> dict:
    cfg = _apply_env(run)
    from redteam import holdout, store
    from redteam.config import HOLDOUT, HOLDOUT_MODEL, usd
    store.reload()
    r = store.repo()
    promoted = json.loads((run / "models" / "promoted.json").read_text()) if (run / "models" / "promoted.json").exists() \
        else {"model_id": None, "history": []}
    hist = {h["model_id"]: h for h in promoted["history"]}
    rows = []
    for doc in store.all_rounds(r):
        rep, attack = doc.get("report") or {}, doc.get("attack") or {}
        promos = doc.get("promotions") or []
        kept = [p for p in promos if p.get("promoted")]
        last = kept[-1] if kept else (promos[-1] if promos else {})  # a round that kept a model reports that model
        m = last.get("candidate_val") or rep.get("metrics") or {}
        h = hist.get(last.get("model_id")) if last.get("promoted") else None
        op = (holdout.history(last["model_id"]) or [None])[-1] if h else None  # operator-only holdout report
        diff = run / "diffs" / f"R{doc['_id']}.diff"
        rows.append({
            "round": doc["_id"],
            "attack_success": _rate(attack, "attack_success"), "attack_model": attack.get("model_id"),
            "policy_bounded_recall": _rate(m, "policy_bounded_recall"),
            "recall": _rate(m, "recall"), "fpr": _rate(m, "fpr"), "fpr_real": _rate(m, "fpr_real"),
            "layer2_fpr": _rate(m, "layer2_fpr"),
            "layer2_recall": _rate(m, "layer2_recall"), "layer1_catches": m.get("layer1_catches"),
            "adaptive_recall": _rate(m, "adaptive_recall"),
            "holdout_recall": _rate((h or {}).get("holdout"), "recall"),
            "holdout_fpr": _rate((h or {}).get("holdout"), "fpr"),
            "holdout_operator": None if not op else {
                "layer2_fpr": _rate(op["totals"], "layer2_fpr"),
                "policy_bounded_recall": _rate(op["totals"], "policy_bounded_recall"),
                "recall_seen": _rate(op["groups"], "seen"), "recall_held_out": _rate(op["groups"], "held_out"),
                "ci95_cluster": op["ci95_cluster"], "clusters": op["clusters"]},
            "decision": "kept" if kept else ("revert" if promos or rep else None),
            "reason": (last.get("decision") or rep.get("decision") or {}).get("reason"),
            "kept_models": [p["model_id"] for p in kept], "promotion_requests": len(promos),
            "model": last.get("model_id"), "promoted_model": promoted["model_id"],
            "generation": doc.get("generation"), "cost": rep.get("cost"),
            "feature_changes": rep.get("feature_changes"), "session_id": doc.get("session_id"),
            "diff": str(diff) if diff.exists() and diff.stat().st_size else None,
            "audit_failing": (doc.get("audit") or {}).get("failing"),
        })
    hold_meta = HOLDOUT / "holdout.v3.meta.json"
    hold = json.loads(hold_meta.read_text()) if hold_meta.exists() else None
    hold_usd = usd(HOLDOUT_MODEL, hold["tokens"]["prompt"], hold["tokens"]["completion"]) if hold else 0.0
    spend = round(sum((x["cost"] or {}).get("usd", 0) for x in rows) + hold_usd, 4)
    out = {"run": str(run), "config": cfg, "holdout": hold, "holdout_usd": round(hold_usd, 4), "rounds": rows,
           "spend_usd": spend}
    (run / "summary.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")
    (run / "summary.md").write_text(markdown(out), encoding="utf-8")
    return out


def _pct(x):
    return "—" if x is None else f"{x['value'] * 100:.1f}% (n={x['n']})"


def markdown(s: dict) -> str:
    c = s["config"]
    lines = [f"# Dry run `{Path(s['run']).name}`", "",
             f"- Snapshot `{Path(c['snapshot']).name}` (as of {c['as_of']}), seed {c['seed']}, "
             f"attackers: {c.get('knowledge') or 'coordinator decides (blind by default)'}, "
             f"known list: {'every real seller' if c['all_known'] else 'top reputable sellers'}",
             f"- Holdout: {s['holdout']['n'] if s['holdout'] else 0} listings, ${s['holdout_usd']:.4f}",
             f"- Total spend (estimate): **${s['spend_usd']:.4f}**",
             "- Attack success = share of this round's scam listings that the model promoted at the round's start let "
             "through, computed once by code at the end of the round (95% interval in brackets). Recall excludes "
             "policy-bounded families (unknown_seller), reported apart. Metrics are the kept model's (or the last "
             "candidate's) on validation.", "",
             "| Round | Attack success | Recall | Policy-bounded recall | False blocks | False blocks (real) | "
             "L2 false blocks | L2 recall | L1 catches | White-box recall | Holdout recall | Holdout false blocks | "
             "Audit fails | Decision | Cost |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for x in s["rounds"]:
        a = x["attack_success"]
        aud = x.get("audit_failing")
        lines.append(" | ".join([
            f"| R{x['round']}", "—" if a is None else f"{a['value'] * 100:.1f}% [{a['lo'] * 100:.0f}–{a['hi'] * 100:.0f}]",
            _pct(x["recall"]), _pct(x["policy_bounded_recall"]), _pct(x["fpr"]),
            _pct(x["fpr_real"]), _pct(x["layer2_fpr"]), _pct(x["layer2_recall"]), str(x["layer1_catches"]), _pct(x["adaptive_recall"]),
            _pct(x["holdout_recall"]), _pct(x["holdout_fpr"]),
            "—" if aud is None else (", ".join(aud) or "none"), x["decision"] or "—",
            "—" if not x["cost"] else f"${x['cost']['usd']:.4f}"]) + " |")
    lines.append("")
    for x in s["rounds"]:
        lines.append(f"## R{x['round']}")
        lines.append(f"- Decision: {x['decision']} ({x['reason']}); kept: {', '.join(x['kept_models']) or 'none'} "
                     f"of {x['promotion_requests']} promotion request(s)")
        for fc in x["feature_changes"] or []:
            lines.append(f"- Feature {fc['action']}: `{fc['feature']}`: {fc['rationale']}")
        lines.append(f"- Diff: {x['diff'] or 'no feature edits'}")
        op = x.get("holdout_operator")
        if op:
            ci = lambda k: "" if not op["ci95_cluster"].get(k) else                 f" [{op['ci95_cluster'][k][0] * 100:.0f}–{op['ci95_cluster'][k][1] * 100:.0f}]"
            lines.append(f"- Holdout (operator only, 95% intervals clustered over {op['clusters']} base listings): "
                         f"seen families {_pct(op['recall_seen'])}{ci('recall_seen')}, held-out families "
                         f"{_pct(op['recall_held_out'])}{ci('recall_held_out')}, L2 false blocks "
                         f"{_pct(op['layer2_fpr'])}{ci('layer2_fpr')}, policy-bounded "
                         f"{_pct(op['policy_bounded_recall'])}{ci('policy_bounded_recall')}")
        if x.get("audit_failing"):
            lines.append(f"- Audit: **{', '.join(x['audit_failing'])}** can be told apart from real listings by "
                         f"traits the attack should not touch; treat this round's numbers for them with care")
        lines.append("")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--snapshot", type=Path, required=True)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--knowledge", choices=["blind", "white_box"])
    p.add_argument("--all-known", action="store_true")
    p.add_argument("--base-store", type=Path, help="store whose synthetic listings seed round 0 (and a baseline model)")
    p.add_argument("--holdout-from", type=Path, help="folder holding a sealed holdout to reuse")
    p = sub.add_parser("holdout")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--per-family", type=int, default=60)
    p.add_argument("--slice", type=int, default=20)
    p = sub.add_parser("round")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--round", type=int, required=True)
    p.add_argument("--max-listings", type=int, default=300)
    p.add_argument("--timeout", type=int, default=35 * 60)
    p = sub.add_parser("summary")
    p.add_argument("--run", type=Path, required=True)
    a = ap.parse_args(argv)
    run = a.run.resolve()
    if a.cmd == "init":
        out = init(run, a.snapshot.resolve(), a.seed, a.knowledge, a.all_known,
                   a.base_store and a.base_store.resolve(), a.holdout_from and a.holdout_from.resolve())
    elif a.cmd == "holdout":
        out = build_holdout(run, a.per_family, a.slice)
    elif a.cmd == "round":
        out = run_round(run, a.round, a.max_listings, a.timeout)
    else:
        out = summary(run)
        out = {"spend_usd": out["spend_usd"], "rounds": len(out["rounds"])}
    print(json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
