"""Factory Droid coordinator: one SDK session per red-team round (plan C1-C8).

Usage:
  uv run --project redteam python -m redteam.coordinator --round 1
  uv run --project redteam python -m redteam.coordinator --round 1 --resume <session_id>
  uv run --project redteam python -m redteam.coordinator --round 1 --max-listings 60   # cheap run

The coordinator sees the world only through the redteam MCP server (stdio), works in gate/, may edit only
gate/features/* and gate/train_config.yaml, and has no path to the holdout (see guard_hook.py and mcp_server.py).
Its prompt is built from the round's RoundInput (issue #1); it returns a CoordinatorOutput (its diagnosis and changes),
and code assembles the RoundReport, filling in metrics, the promotion decision and cost itself.
"""
import argparse
import asyncio
import json
import os
import sys
import time

from calhacks_contracts import CoordinatorOutput, Cost, PromotionDecision, RoundMetrics, RoundReport, rate

from redteam import gate_client, holdout, promotion, roundstate, store
from redteam.config import FAMILY_ROUND_CAP, MAX_TRAIN_CALLS, ROUND_FINISH_SECONDS
from redteam.config import (COORDINATOR_MODEL, DATA, FACTORY_SETTINGS, GATE_DIR, ROUND_WALL_SECONDS, STRATEGIST_DROID,
                            round_dir, usd)

COORD_TOKEN_BUDGET = 2_000_000
COORD_PRICE_MODEL = {COORDINATOR_MODEL: "deepseek-ai/DeepSeek-V4.1-Flash"}
ALLOWED_EDIT = ("features/", "train_config.yaml")
DISABLED_TOOLS = ["Execute", "FetchUrl", "WebSearch", "ReadAutomation", "ListAutomations", "ListAutomationTemplates",
                  "ConnectApp"]


# ---------- policy ----------
def _rel(p) -> str:
    from pathlib import Path
    try:
        return Path(p).resolve().relative_to(GATE_DIR.resolve()).as_posix()
    except Exception:
        return f"<outside>/{p}"


def make_permission_handler(allow_edits: bool, log: list):
    from droid_sdk import ToolConfirmationOutcome as O
    from droid_sdk.permissions import ApplyPatchAction, CreateFile, EditAction, ExecuteAction, McpToolAction

    def edit_ok(path):
        r = _rel(path)
        return allow_edits and "holdout" not in r and any(r == a or r.startswith(a) for a in ALLOWED_EDIT)

    def on_permission(req):
        offered = {o.value for o in req.options}
        ok = True
        for a in req.actions:
            if isinstance(a, (EditAction, CreateFile)):
                good = edit_ok(a.file_path)
                log.append(("edit", _rel(a.file_path), good))
            elif isinstance(a, ApplyPatchAction):
                paths = [f.file_path for f in getattr(a, "files", [])] or [getattr(a, "file_path", "?")]
                good = all(edit_ok(p) for p in paths)
                log.append(("patch", [_rel(p) for p in paths], good))
            elif isinstance(a, McpToolAction):
                good = (a.server_name or "") == "redteam" or a.tool_name.startswith("redteam___")
                log.append(("mcp", a.tool_name, good))
            elif isinstance(a, ExecuteAction):
                good = False
                log.append(("exec", a.command[:80], False))
            else:
                good = False
                log.append((type(a).__name__, "", False))
            ok = ok and good
        choice = O.PROCEED_ONCE if ok and O.PROCEED_ONCE in offered else O.CANCEL
        return req.respond(choice, comment=None if ok else "Blocked by red-team policy.")
    return on_permission


def write_hooks() -> None:
    """gate/.factory/hooks.json (gitignored): the guard hook runs before every tool call, subagents included if droid applies it."""
    log = DATA / "guard.log"
    DATA.mkdir(parents=True, exist_ok=True)
    cmd = f'"{sys.executable}" -m redteam.guard_hook --root "{GATE_DIR}" --log "{log}"'
    hooks = {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": cmd, "timeout": 30}]}]}
    (GATE_DIR / ".factory").mkdir(parents=True, exist_ok=True)
    (GATE_DIR / ".factory" / "hooks.json").write_text(json.dumps(hooks, indent=1))


def mcp_server(round_: int, max_listings: int):
    from droid_sdk import StdioMcpServerConfig
    env = {"REDTEAM_ROUND": str(round_), "CALHACKS_DATA": str(DATA), "REDTEAM_GATE": gate_client.GATE_BACKEND,
           "REDTEAM_MAX_LISTINGS": str(max_listings), "PYTHONIOENCODING": "utf-8", "UV_SYSTEM_CERTS": "1"}
    for k in ("BITDEER_API_KEY", "CALHACKS_HOLDOUT", "CALHACKS_MODELS", "MONGODB_URI", "MONGODB_DB_REDTEAM",
              "REDTEAM_MONGOMOCK", "REDTEAM_LOCAL_STORE", "REDTEAM_ATTACKER_KNOWLEDGE", "REDTEAM_SEED", "GATE_AS_OF",
              "REDTEAM_ROUND_DEADLINE", "REDTEAM_REQUIRE_COVERAGE",
              "PATH", "NODE", "SYSTEMROOT"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    try:
        env["HOLDOUT_KEY"] = holdout.key_for_mcp_env()  # only the MCP server process gets the key
    except RuntimeError:
        pass
    return StdioMcpServerConfig(name="redteam", command=sys.executable, args=["-m", "redteam.mcp_server"], env=env)


def build_session(round_: int, *, model: str, max_listings: int = 300,
                  allow_edits: bool = True, perm_log: list | None = None, resume: str | None = None):
    from droid_sdk import Autonomy, InteractionHandlers, Runtime, Session, SessionConfig
    os.environ.pop("HOLDOUT_KEY", None)  # never inherited by droid itself
    write_hooks()
    perm_log = perm_log if perm_log is not None else []
    handlers = InteractionHandlers(on_permission=make_permission_handler(allow_edits, perm_log))
    runtime = Runtime(args=["--settings", str(FACTORY_SETTINGS)],
                      env={k: v for k, v in os.environ.items() if k.startswith("BITDEER")})
    servers = [mcp_server(round_, max_listings)]
    if resume:
        return Session.resume(resume, interactions=handlers, mcp_servers=servers, runtime=runtime,
                              disabled_tools=DISABLED_TOOLS, disable_builtin_skills=True)
    cfg = SessionConfig(autonomy=Autonomy.HIGH, mcp_servers=servers, disabled_tools=DISABLED_TOOLS,
                        disable_builtin_skills=True)
    return Session(cwd=GATE_DIR, model=model, config=cfg, interactions=handlers, runtime=runtime)


def round_input_brief(round_: int) -> str:
    """The RoundInput as compact JSON for the prompt (misses trimmed). The full object is built here once and cached
    for get_round_input, so the coordinator's first tool call doesn't pay for a cold build."""
    full = roundstate.build_round_input(round_).model_dump(mode="json")
    (round_dir(round_) / "round_input.json").write_text(json.dumps(full, ensure_ascii=False), encoding="utf-8")
    ri = json.loads(json.dumps(full))
    ri["misses"] = ri["misses"][:8]
    for m in ri["misses"]:
        m["listing"]["item"]["text"] = m["listing"]["item"]["text"][:300]
        m["listing"]["reviews"] = [x[:140] for x in m["listing"]["reviews"][:3]]
    if ri["last_report"]:
        ri["last_report"] = {k: ri["last_report"][k] for k in ("round", "failures_by_cluster", "feature_changes",
                                                               "decision")}
    return json.dumps(ri, separators=(",", ":"), ensure_ascii=False)


def round_prompt(round_: int, allow_edits: bool, max_listings: int, brief: str) -> str:
    editing = (
        "Then fix the Gate by editing feature files under features/ (relative to your working directory) or "
        "train_config.yaml. A feature is a pure function of the GateInput (mandate, listing, references) registered "
        "with the decorator below; it must be deterministic, return a finite float, and do no file or network I/O. "
        "Feature files are checked before import: they may import only math, re, unicodedata, itertools, difflib, "
        "statistics, collections, functools, calhacks_contracts models, gatepy.registry.feature, gatepy.clock and "
        "features._text, and may not use open/eval/exec/getattr or private or dunder attributes. Edit only "
        "features/<name>.py files:\n"
        "    from gatepy.registry import feature\n"
        "    @feature(\"name\", monotone=-1|0|1)   # -1: risk must not rise as the value rises\n"
        "    def name(x) -> float: ...\n"
        "Read the existing files in features/ first and follow their style."
        if allow_edits else
        "Feature editing is disabled in this run (the stub gate ignores features). Describe the feature changes you "
        "would make in feature_changes instead.")
    return f"""You are the red-team lead for a payment Gate that protects an AI shopping agent from scam listings.
This is round {round_}. Goal: find where the Gate is weak, attack it there, and make it stronger without blocking
honest sellers. Listings have one shape: seller (id, domain, pay_to), item (id, product_key, condition, price, text),
reviews, checkout (what the 402 demands). The Gate also looks up known wallets, the market median and when the wallet
was first seen. A known wallet is trusted; an unknown wallet is paid only up to $100, and then the risk model decides.

You act only through the redteam tools (get_round_input, generate_attacks, score_round, inspect_failures,
train_gate, eval_gate, promote_model) and the {STRATEGIST_DROID} subagent (Task tool, subagent_type
"{STRATEGIST_DROID}"). There is no shell. Only the attack families listed by get_round_input are available; do not
try to find or read any holdout data.

This round's RoundInput (built by code; call get_round_input for the full object):
{brief}

Procedure:
Budget: you have {ROUND_WALL_SECONDS // 60} minutes. Generation and training close a few minutes before the end, and
at most {MAX_TRAIN_CALLS} train_gate calls are allowed. Send generate_attacks calls one at a time. The training data
already holds a base set covering every family, so spend this round on the families where the Gate is weakest; no
family may get more than {FAMILY_ROUND_CAP} new scams in one round.

1. If current_model_id is null, run train_gate(round=0) and promote_model on it as the baseline.
2. Give the {STRATEGIST_DROID} the per-family numbers and misses, and ask for new attack specs.
3. generate_attacks for 2-4 AttackSpecs: the weakest families, families with low coverage, and the strategist's best
   ideas. Use mode "mutate_real". Include one attacker_knowledge "white_box" spec. Stay within {max_listings}
   listings this round in total.
4. score_round (how last round's model holds up against the fresh attacks), then inspect_failures.
5. {editing}
6. train_gate, then promote_model on the new model id. Code decides promotion (validation recall must go up,
   false blocks <= 2%, no family drops more than 5 points). If it is refused you may make one more fix and retry,
   within the training limit.
7. Finish with your CoordinatorOutput: failures_by_cluster (cause, family, count, example_ids), feature_changes
   (feature, action add|modify|remove, rationale), train_params, and short notes. Metrics and the promotion decision
   are filled in by code; don't report them.
"""


def _guard_denials(session_id: str) -> list[dict]:
    """Denials the guard hook logged for this session (SDK hook events don't reliably carry the exit code)."""
    log = DATA / "guard.log"
    if not log.exists():
        return []
    rows = []
    for line in log.read_text(encoding="utf-8").splitlines():
        try:  # hook processes append concurrently, so a line can be partial
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return [{"tool": r["tool"], "why": r["why"]} for r in rows if r["decision"] == "deny" and r.get("session") == session_id]


def record_audit(round_: int) -> dict:
    """Artifact audit of this round's synthetic listings against real ones (redteam.audit). Families whose listings
    can be told apart from real listings by traits the attack should not touch are recorded in the round doc."""
    from redteam import audit
    r = store.repo()
    ids = store.listing_ids(r, rounds=[round_], include_real=False)
    try:
        res = audit.audit_repo(r, os.environ.get("GATE_AS_OF") or time.strftime("%Y-%m-%d"), ids)
        out = {"failing": res["failing"], "n": len(ids),
               "families": {k: {"auc": v["auc"], "p": v["p"], "n": v["n_pos"], "top": v["top_traits"][:1]}
                            for k, v in list(res["families"].items()) + list(res["checks"].items())}}
    except Exception as e:  # an audit problem must not lose the round
        out = {"failing": None, "n": len(ids), "error": f"{type(e).__name__}: {e}"}
    store.save_round(r, round_, audit=out)
    return out


def start_model_for(round_: int) -> str | None:
    """The model this round's attacks are scored against: the one promoted when the round first started. Recorded on
    the first attempt, before the MCP server starts (it loads the store when it launches); a resumed attempt keeps it,
    since a model promoted during the round was trained on these attacks."""
    r = store.repo()
    prior = store.get_round(r, round_) or {}
    if "start_model" in prior:
        return prior["start_model"]
    model = promotion.current()["model_id"]
    store.save_round(r, round_, start_model=model)
    store.flush()
    return model


def record_attack_success(round_: int, start_model: str | None) -> dict | None:
    """The round's attack success, computed once by code: the share of this round's scam listings (policy-bounded
    families excluded, as in recall) that the model promoted at the round's start let through."""
    r = store.repo()
    ids = store.listing_ids(r, rounds=[round_], include_real=False)
    if not start_model or not ids:
        store.save_round(r, round_, attack={"model_id": start_model, "attack_success": None, "n": len(ids)})
        return None
    m = gate_client.evaluate_as_trained(start_model, split="all", ids=ids)
    if m.get("error"):
        store.save_round(r, round_, attack={"model_id": start_model, "attack_success": None, "error": m["error"]})
        return None
    rec = m["metrics"]["recall"]
    out = {"model_id": start_model, "attack_success": rate(rec["n"] - rec["k"], rec["n"]).model_dump(), "n": rec["n"],
           "policy_bounded_recall": m["metrics"].get("policy_bounded_recall")}
    store.save_round(r, round_, attack=out)
    return out


def assemble_report(round_: int, output: CoordinatorOutput | None, session_id: str | None,
                    coord_usage: dict, model: str) -> RoundReport:
    """Code-filled RoundReport: metrics from the last candidate evaluated this round (or the promoted model),
    the promotion decision from promote_model, and cost from the coordinator's usage plus generation spend."""
    r = store.repo()
    doc = store.get_round(r, round_) or {}
    promos = doc.get("promotions") or []
    last = promos[-1] if promos else None
    if last and last.get("candidate_val"):
        metrics = RoundMetrics.model_validate(last["candidate_val"])
        decision = PromotionDecision.model_validate(last["decision"])
    else:
        # No promotion was requested: report the promoted model, else the round's last trained candidate, else zeros.
        model_id = promotion.current()["model_id"] or (doc.get("candidates") or [None])[-1]
        ev = gate_client.evaluate(model_id, split="val") if model_id else {"error": "no model"}
        metrics = RoundMetrics.model_validate(ev["metrics"]) if not ev.get("error") else RoundMetrics(
            layer1_catches=0, layer2_recall=rate(0, 0), fpr_real=rate(0, 0), per_family={}, recall=rate(0, 0),
            fpr=rate(0, 0))
        decision = PromotionDecision.model_validate(last["decision"]) if last else \
            PromotionDecision(action="revert", reason="no candidate was submitted for promotion this round")
    gen = doc.get("generation") or {"tokens": 0, "usd": 0.0}
    ci, co = coord_usage.get("input_tokens") or 0, coord_usage.get("output_tokens") or 0
    coord_usd = usd(COORD_PRICE_MODEL.get(model, "deepseek-ai/DeepSeek-V4.1-Flash"), ci, co)
    out = output or CoordinatorOutput(failures_by_cluster=[], feature_changes=[], notes="no structured output")
    return RoundReport(round=round_, session_id=session_id, failures_by_cluster=out.failures_by_cluster,
                       feature_changes=out.feature_changes, train_params=out.train_params, metrics=metrics,
                       decision=decision,
                       cost=Cost(usd=round(coord_usd + gen["usd"], 4), tokens=ci + co + gen["tokens"]))


async def run_round(round_: int, *, model: str, max_listings: int, resume: str | None, timeout: float) -> dict:
    allow_edits = gate_client.GATE_BACKEND != "stub"
    out_dir = round_dir(round_)
    perm_log, events, tokens, stopping = [], [], {"in": 0, "out": 0}, False
    brief = round_input_brief(round_)
    # The MCP server's tools close at this time; set before build_session, which copies it into the server's env.
    os.environ["REDTEAM_ROUND_DEADLINE"] = str(time.time() + timeout)
    session = build_session(round_, model=model, max_listings=max_listings, allow_edits=allow_edits,
                            perm_log=perm_log, resume=resume)
    prompt = round_prompt(round_, allow_edits, max_listings, brief) if not resume else \
        "Continue this round from where you stopped, then produce your CoordinatorOutput."
    started = time.time()
    start_model = start_model_for(round_)
    async with session as s:
        # Written after the session: during it the MCP server owns the store (a local dry-run store is a set of files,
        # and an earlier write from this process would be overwritten by the server's, or overwrite them).
        start_fields = {"session_id": s.id, "coordinator_model": model, "started": started, "resumed_from": resume,
                        "start_model": start_model}
        async with s.stream(prompt, output=CoordinatorOutput, timeout=timeout + ROUND_FINISH_SECONDS) as st:
            async for ev in st:
                kind = type(ev).__name__
                if kind == "ToolCall":
                    events.append({"t": round(time.time() - started, 1), "tool": ev.name})
                elif kind == "HookExecution" and ev.status == "completed" and ev.exit_code == 2:
                    events.append({"t": round(time.time() - started, 1), "hook_denied": (ev.stderr or "")[:200]})
                if time.time() > started + timeout + ROUND_FINISH_SECONDS and not stopping:
                    stopping = True
                    events.append({"budget": "round time exceeded; interrupting"})
                    await s.interrupt()
                if kind == "TokenUsageUpdate":
                    tokens = {"in": ev.input_tokens, "out": ev.output_tokens}
                    if ev.input_tokens + ev.output_tokens > COORD_TOKEN_BUDGET:
                        events.append({"budget": "coordinator token budget exceeded; interrupting"})
                        await s.interrupt()
            result = st.result
    u = result.usage
    usage = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
             "cache_read_tokens": u.cache_read_tokens, "thinking_tokens": u.thinking_tokens} if u else \
        {"input_tokens": tokens["in"], "output_tokens": tokens["out"]}
    summary = {"round": round_, "session_id": result.session_id, "subtype": result.subtype,
               "seconds": round(time.time() - started), "turns": result.turn_count, "usage": usage,
               "tool_calls": len([e for e in events if "tool" in e]),
               "hook_denials": _guard_denials(result.session_id), "permission_log": perm_log}
    output = result.output if isinstance(result.output, CoordinatorOutput) else None
    store.reload()  # pick up what the MCP server wrote (local dry runs)
    store.save_round(store.repo(), round_, **start_fields)
    record_attack_success(round_, start_model)
    record_audit(round_)
    report = assemble_report(round_, output, result.session_id, usage, model)
    store.save_round(store.repo(), round_, report=report.model_dump(mode="json"), usage=summary,
                     coordinator_text=None if output else (result.text or "")[-2000:])
    store.flush()
    (out_dir / "usage.json").write_text(json.dumps(summary, indent=1, default=str))
    (out_dir / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    (out_dir / "report.json").write_text(report.model_dump_json(indent=1))
    return {"summary": summary, "report": report.model_dump(mode="json")}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--round", type=int, required=True)
    ap.add_argument("--resume")
    ap.add_argument("--model", default=COORDINATOR_MODEL)
    ap.add_argument("--max-listings", type=int, default=300)
    ap.add_argument("--timeout", type=float, default=ROUND_WALL_SECONDS)
    a = ap.parse_args(argv)
    out = asyncio.run(run_round(a.round, model=a.model, max_listings=a.max_listings, resume=a.resume,
                                timeout=a.timeout))
    print(json.dumps(out, indent=1, default=str))
    return 0 if out["summary"]["subtype"] == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
