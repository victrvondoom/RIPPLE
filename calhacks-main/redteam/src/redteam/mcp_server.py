"""stdio MCP server: the coordinator's only window on the red-team loop (plan C2, issue #1 schemas).

No tool scores the holdout or returns holdout rows. RoundInput carries holdout totals for the current promoted model
only (issue #1); they are computed inside promote_model, after the code-enforced promotion decision.

Env: REDTEAM_ROUND (current round), REDTEAM_MAX_LISTINGS (cap per round), HOLDOUT_KEY (only this process),
BITDEER_API_KEY, MONGODB_URI / MONGODB_DB_REDTEAM, REDTEAM_GATE.

Run: uv run --project redteam python -m redteam.mcp_server
"""
import builtins
import functools
import inspect
import json
import os
import threading
import time
from collections import Counter, defaultdict


from redteam import gate_client, holdout, promotion, roundstate, scoring, store
from redteam.config import (BULK_MODELS, FAMILY_ROUND_CAP, MAX_TRAIN_CALLS, ROUND_BUDGET, legit_families, needs_llm,
                            round_dir, scam_families)
from redteam.generate import SpecError, run_spec

MAX_CALL_LISTINGS = 60   # per generate_attacks call
CALL_TIME_BUDGET_S = 120.0  # droid fails an MCP call at 180 s and the server is lost for the round; stay well under
_GEN_LOCK = threading.Lock()  # one generation at a time: parallel calls slow each other past droid's limit
MAX_CALL_LLM = 24        # listings per call that need Bitdeer text rewrites (~3 per request, run in parallel)

NOT_BUILT = "not available: the storefront scam-store route (plan A4/B6) isn't built yet; judge offline instead"


def current_round() -> int:
    return int(os.environ.get("REDTEAM_ROUND", "0"))


def _log(tool: str, args: dict, result):
    r = current_round()
    with (round_dir(r) / "calls.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.time(), "tool": tool, "args": args,
                            "ok": not (isinstance(result, dict) and result.get("error"))}, default=str) + "\n")
    return result


def _budget(r: int) -> dict:
    doc = store.get_round(store.repo(), r) or {}
    return doc.get("generation") or {"tokens": 0, "usd": 0.0, "listings": 0}


def _add_budget(r: int, tokens: int, usd: float, listings: int) -> dict:
    b = _budget(r)
    b = {"tokens": b["tokens"] + tokens, "usd": round(b["usd"] + usd, 4), "listings": b["listings"] + listings}
    store.save_round(store.repo(), r, generation=b)
    return b


def _time_left() -> float | None:
    """Seconds until this round's tool window closes (REDTEAM_ROUND_DEADLINE, set by the coordinator), or None."""
    d = os.environ.get("REDTEAM_ROUND_DEADLINE")
    return float(d) - time.time() if d else None


def _closed(tool: str, args: dict, needs: float):
    """An error result when fewer than `needs` seconds are left in the round's window, else None."""
    left = _time_left()
    if left is not None and left < needs:
        return _log(tool, args, {"error": (
            "this round's time is up: no more generation or training. If you have a candidate that was not yet "
            "submitted, call promote_model on it; then write your CoordinatorOutput.")})
    return None


def _round_ids(r: int) -> list[str]:
    return store.listing_ids(store.repo(), rounds=[r], include_real=False)


# ---------- tools ----------
def get_round_input() -> dict:
    """The RoundInput for this round (issue #1), built by code. Start every round here."""
    r = current_round()
    # Built by the coordinator before the session: a cold build can outlast droid's 180 s tool limit.
    cached = round_dir(r) / "round_input.json"
    if cached.exists():
        out = json.loads(cached.read_text(encoding="utf-8"))
    else:
        out = roundstate.build_round_input(r).model_dump(mode="json")
    out["_help"] = {"attack_families": scam_families(), "legit_families": legit_families(),
                    "generator_models": BULK_MODELS,
                    "generation_used": _budget(r), "real_listings": len(store.repo().real_listing_ids())}
    return _log("get_round_input", {}, out)


def generate_attacks(spec: dict) -> dict:
    """Order test listings with an AttackSpec (issue #1): spec_id, family (or legit_hard), n, legit_ratio,
    mode (mutate_real|generate), base_listing_ids, target_weakness, attacker_knowledge (blind|white_box), model,
    temperature. Returns counts, drops per family and cost. Send one call at a time: a call made while another is
    running is refused at once. A call returns within about two minutes with whatever finished; slots it had no
    time for are listed as dropped ("call time budget reached") and can be requested again."""
    shut = _closed("generate_attacks", dict(spec or {}), CALL_TIME_BUDGET_S + 30)
    if shut:
        return shut
    if not _GEN_LOCK.acquire(blocking=False):
        return _log("generate_attacks", dict(spec or {}), {"error": (
            "another generate_attacks call is still running; send generate_attacks calls one at a time and wait for "
            "each to return")})
    try:
        return _generate_attacks(spec)
    finally:
        _GEN_LOCK.release()


def _generate_attacks(spec: dict) -> dict:
    r = current_round()
    spec = {k: v for k, v in dict(spec or {}).items() if v is not None}  # null means "use the default"
    spec.setdefault("spec_id", f"R{r}-{spec.get('family', 'x')}-{int(time.time() * 1000) % 10 ** 8}")
    spec.setdefault("mode", "mutate_real")
    spec.setdefault("legit_ratio", 0.4)
    forced = os.environ.get("REDTEAM_ATTACKER_KNOWLEDGE")  # dry runs: force blind or white_box attackers
    if forced:
        spec["attacker_knowledge"] = forced
    used = _budget(r)
    if used["tokens"] >= ROUND_BUDGET["tokens"] or used["usd"] >= ROUND_BUDGET["usd"]:
        return _log("generate_attacks", spec, {"error": f"round {r} generation budget exhausted: {used}"})
    cap = int(os.environ.get("REDTEAM_MAX_LISTINGS", "100000"))
    n = spec.get("n")
    if isinstance(n, int) and used["listings"] + n > cap:
        return _log("generate_attacks", spec, {"error": f"round {r} listing cap {cap} reached "
                                                        f"({used['listings']} generated); request at most "
                                                        f"{max(0, cap - used['listings'])}"})
    # Keep every call well under the MCP client's request timeout: a timed-out call makes droid restart this server.
    try:
        from redteam.generate import parse_spec, plan_families
        parsed = parse_spec(spec)
        planned = plan_families(parsed, __import__("random").Random(0))
        n_llm = len(planned) if parsed.mode == "generate" else sum(needs_llm(f) for f in planned)
    except SpecError:
        n_llm = 0  # run_spec reports the validation error below
        parsed = None
    if parsed:
        have = Counter(k.family for k in store.repo().answer_keys({"_id": {"$in": _round_ids(r)}}))
        want = Counter(f for f in planned if f in scam_families())
        over = {f: max(0, FAMILY_ROUND_CAP - have[f]) for f in want if have[f] + want[f] > FAMILY_ROUND_CAP}
        if over:
            return _log("generate_attacks", spec, {"error": (
                f"per-family cap: at most {FAMILY_ROUND_CAP} scams of one family per round "
                f"(room left: {over}); spread this round's attacks over more families")})
    if parsed and (parsed.n > MAX_CALL_LISTINGS or n_llm > MAX_CALL_LLM):
        return _log("generate_attacks", spec, {"error": (
            f"spec too large for one call ({parsed.n} listings, {n_llm} needing text rewrites); split it into calls of "
            f"at most {MAX_CALL_LISTINGS} listings with at most {MAX_CALL_LLM} text rewrites each, one call at a time")})
    white_box = None
    if spec.get("attacker_knowledge") == "white_box":
        model_id = promotion.current()["model_id"]
        reasons = [f"{t.feature}={t.value}" for m in roundstate.val_misses(model_id, 20) for t in m.top_reasons]
        white_box = {"features": roundstate.current_model_features(model_id), "reasons": reasons}
    try:
        out = run_spec(spec, round_=r, white_box=white_box, seed=int(os.environ.get("REDTEAM_SEED", "0")),
                       token_budget=ROUND_BUDGET["tokens"] - used["tokens"], time_budget=CALL_TIME_BUDGET_S)
    except SpecError as e:
        return _log("generate_attacks", spec, {"error": str(e)})
    for k in ("_items", "_refs", "_dropped"):
        out.pop(k)
    out["generation_used"] = _add_budget(r, out["tokens"]["prompt_tokens"] + out["tokens"]["completion_tokens"],
                                         out["usd"], out["kept"])
    return _log("generate_attacks", spec, out)


def score_round(round: int | None = None) -> dict:
    """The promoted model vs. this round's fresh attacks so far (a working view for the coordinator; the round's
    recorded attack success is computed once by code at the end of the round, with the model promoted at its start)."""
    r = current_round() if round is None else round
    model_id = promotion.current()["model_id"]
    if not model_id:
        return _log("score_round", {"round": r}, {"error": "no promoted model yet: train_gate then promote_model"})
    ids = _round_ids(r)
    if not ids:
        return _log("score_round", {"round": r}, {"error": f"no synthetic listings in round {r} yet"})
    m = gate_client.evaluate(model_id, split="all", ids=ids)
    if m.get("error"):
        return _log("score_round", {"round": r}, m)
    m["attack_success"] = builtins.round(1 - m["metrics"]["recall"]["value"], 4)  # `round` is a tool parameter here
    return _log("score_round", {"round": r}, m)


def inspect_failures(round: int | None = None, limit: int = 12) -> dict:
    """This round's misses (scams bought) and false blocks (legit skipped) under the promoted model, clustered by
    family and top Layer-2 reason, each with a few full listings (issue #1 Miss)."""
    r = current_round() if round is None else round
    model_id = promotion.current()["model_id"]
    if not model_id:
        return _log("inspect_failures", {"round": r}, {"error": "no promoted model to inspect"})
    rep = store.repo()
    ids = _round_ids(r) + store.listing_ids(rep, rounds=[], split="val")
    m = gate_client.evaluate(model_id, split="all", ids=ids, rows=True)
    if m.get("error"):
        return _log("inspect_failures", {"round": r}, m)
    bad = scoring.misses(m["rows"])
    listings = {l.listing_id: l for l in rep.listings([x["listing_id"] for x in bad])}
    clusters = defaultdict(list)
    for x in bad:
        d = x["decision"]
        kind = "missed_scam" if x["label"] == "scam" else "false_block"
        top = d["top_reasons"][0]["feature"] if d.get("top_reasons") else (d.get("failed_rule") or "none")
        clusters[(kind, x["family"], top)].append(x)
    out = []
    for (kind, fam, top), xs in sorted(clusters.items(), key=lambda kv: -len(kv[1]))[:limit]:
        out.append({"kind": kind, "family": fam, "top_reason": top, "count": len(xs),
                    "examples": [{"listing": listings[x["listing_id"]].model_dump(mode="json"),
                                  "decision": x["decision"]} for x in xs[:2] if x["listing_id"] in listings]})
    return _log("inspect_failures", {"round": r}, {"model_id": model_id, "round": r, "n_failures": len(bad),
                                                   "clusters": out})


def train_gate(round: int | None = None) -> dict:
    """Train a candidate Gate on every train-split listing so far (holdout families never included). Models are
    always labelled with the current round."""
    r = current_round()
    shut = _closed("train_gate", {"round": r}, 90)
    if shut:
        return shut
    done = len((store.get_round(store.repo(), r) or {}).get("candidates", []))
    if done >= MAX_TRAIN_CALLS:
        return _log("train_gate", {"round": r}, {"error": (
            f"training limit reached ({MAX_TRAIN_CALLS} candidates per round): promote your best candidate if you "
            "haven't, then write your CoordinatorOutput")})
    out = gate_client.train(r)
    if not out.get("error"):
        store.repo().db.rounds.update_one({"_id": current_round()}, {"$push": {"candidates": out["model_id"]}},
                                          upsert=True)
    return _log("train_gate", {"round": r}, out)


def eval_gate(model_id: str, split: str) -> dict:
    """Metrics for a model on the train or val split. The holdout is not available here."""
    if split not in ("train", "val"):
        return _log("eval_gate", {"model_id": model_id, "split": split},
                    {"error": "split must be 'train' or 'val'; the holdout is not available to the coordinator"})
    return _log("eval_gate", {"model_id": model_id, "split": split}, gate_client.evaluate(model_id, split=split))


def promote_model(model_id: str) -> dict:
    """Ask to promote a candidate. Code decides (val recall up, false blocks <= 2%, no family drops > 5 points)."""
    r = current_round()
    res = promotion.promote(model_id, holdout.totals if holdout.available() else None)
    store.repo().db.rounds.update_one({"_id": r}, {"$push": {"promotions": res}}, upsert=True)
    shown = {k: v for k, v in res.items() if k not in ("candidate_val", "incumbent_val")}
    shown["candidate_val"] = {k: res.get("candidate_val", {}).get(k) for k in ("recall", "fpr", "fpr_real")} \
        if res.get("candidate_val") else None
    return _log("promote_model", {"model_id": model_id}, shown)


def render_store(listing_ids: list[str]) -> dict:
    return _log("render_store", {"n": len(listing_ids)}, {"error": NOT_BUILT})


def run_agent_batch(listing_ids: list[str]) -> dict:
    return _log("run_agent_batch", {"n": len(listing_ids)}, {"error": NOT_BUILT})


TOOLS = [get_round_input, generate_attacks, score_round, inspect_failures, train_gate, eval_gate, promote_model,
         render_store, run_agent_batch]


def build_server():
    from mcp.server.fastmcp import FastMCP
    server = FastMCP("redteam")
    for fn in TOOLS:
        server.tool()(_jsonify(fn))
    return server


def _jsonify(fn):
    """Return results as a JSON string, the result shape droid reads reliably."""
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return json.dumps(fn(*a, **kw), default=str)
        except Exception as e:  # never crash the server on one bad call
            return json.dumps({"error": f"{type(e).__name__}: {e}"})
        finally:
            store.flush()  # local dry runs: persist after every tool call (no-op against MongoDB)
    wrapper.__signature__ = inspect.signature(fn).replace(return_annotation=str)
    wrapper.__annotations__ = {**fn.__annotations__, "return": str}
    return wrapper


if __name__ == "__main__":
    gate_client.preload()  # main thread, before serving (see gate_client.preload)
    build_server().run()
