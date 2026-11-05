"""The red team's only door into the Gate (contracts/interfaces.md).

Backends (REDTEAM_GATE): "real" (default) is the Gate in gate/; "stub" (redteam.gate_stub) is a fast stand-in kept
for unit tests that don't need LightGBM or Node.

How the real Gate is called:
  - against MongoDB: the gate-train / gate-eval CLIs in a subprocess. Coordinator-written feature code runs there,
    with the holdout key and location stripped from its environment;
  - against an in-memory (mongomock) database, which a subprocess can't see: gatepy in-process with that Repo;
  - the holdout (never in MongoDB): gatepy in-process, after the feature sandbox has checked the code.
Models live in MODELS_DIR, which is passed to the Gate as GATE_MODELS.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from calhacks_contracts import AnswerKey, Case, Listing
from calhacks_contracts.db import ReferenceSet

from redteam import gate_stub, store
from redteam.config import GATE_DIR, MODELS_DIR, REPO

GATE_BACKEND = os.environ.get("REDTEAM_GATE", "real")
# Gate subprocesses run coordinator-written feature code; they never need the holdout.
SUBPROCESS_DROP = ("HOLDOUT_KEY", "CALHACKS_HOLDOUT")


class StubModelError(RuntimeError):
    pass


def subprocess_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k not in SUBPROCESS_DROP}
    env["UV_SYSTEM_CERTS"] = "1"
    env["GATE_MODELS"] = str(MODELS_DIR)
    return env


def _in_process() -> bool:
    """True when the red team's database is in-memory, so the Gate must share this process to see it."""
    return type(store.repo().db).__module__.startswith("mongomock")


def _check_real(model_id: str | None) -> None:
    """The real Gate can't load stub models; a leftover stub promoted.json must be cleared first."""
    if model_id and "-stub-" in model_id:
        raise StubModelError(f"{model_id} is a stub model; delete {MODELS_DIR}/promoted.json and the stub model "
                             "files before using the real Gate")


def _run(args: list[str], timeout: int = 1800) -> dict:
    proc = subprocess.run(["uv", "run", "--project", str(GATE_DIR), *args], cwd=REPO, capture_output=True,
                          text=True, encoding="utf-8", timeout=timeout, env=subprocess_env())
    out = proc.stdout.strip()
    try:
        return json.loads(out[out.index("{"):])  # the CLIs print exactly one JSON object
    except ValueError:
        return {"error": f"{args[0]} exited {proc.returncode} without JSON: {proc.stderr[-800:]}"}


def _errors_as_json(fn, *a, **kw) -> dict:
    """In-process calls report failures the way the CLIs do: {"error": ...} instead of raising."""
    from gatepy.dataset import GateInputError
    from gatepy.sandbox import FeaturePolicyError
    try:
        return fn(*a, **kw)
    except (GateInputError, FeaturePolicyError, FileNotFoundError, KeyError, StubModelError,
            json.JSONDecodeError) as e:
        return {"error": str(e)}


def train(round_: int) -> dict:
    if GATE_BACKEND == "stub":
        return gate_stub.train(round_)
    try:
        _check_real(_promoted_id())
    except (StubModelError, json.JSONDecodeError) as e:  # a corrupt promoted.json too
        return {"error": str(e)}
    if _in_process():
        from gatepy.train import train as gate_train
        return _errors_as_json(gate_train, round_, out=MODELS_DIR, repo=store.repo())
    return _run(["gate-train", "--round", str(round_)])


def evaluate(model_id: str, split: str = "all", ids: list[str] | None = None, rows: bool = False) -> dict:
    """{"model_id", "metrics": RoundMetrics, "rows"?}. ids restricts to those listings (e.g. one round's attacks)."""
    if GATE_BACKEND == "stub":
        return gate_stub.evaluate(model_id, split, ids, rows)
    try:
        _check_real(_promoted_id() if model_id == "promoted" else model_id)
    except (StubModelError, json.JSONDecodeError) as e:  # a corrupt promoted.json too
        return {"error": str(e)}
    if _in_process():
        from gatepy.evaluate import evaluate_repo
        return _errors_as_json(evaluate_repo, model_id, store.repo(), split, ids, None, rows, MODELS_DIR)
    args = ["gate-eval", "--model", model_id, "--split", split]
    tmp = None
    if ids is not None:
        tmp = Path(tempfile.mkstemp(prefix="rt-ids-", suffix=".txt")[1])
        tmp.write_text("\n".join(ids), encoding="utf-8")
        args += ["--ids", str(tmp)]
    try:
        return _run(args + (["--rows"] if rows else []))
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


def evaluate_items(model_id: str, items: list[tuple[Listing, Case, AnswerKey]], refs: ReferenceSet,
                   rows: bool = False) -> dict:
    """In-process scoring of listings that are not in MongoDB (the holdout)."""
    if GATE_BACKEND == "stub":
        return gate_stub.evaluate_items(model_id, items, refs, rows)
    from gatepy.evaluate import evaluate as gate_evaluate
    from gatepy.model_io import load
    from gatepy.registry import discover

    def run():
        _check_real(model_id)
        discover()  # enforces the feature sandbox before the holdout reaches any feature code
        return gate_evaluate(load(model_id, MODELS_DIR), items, refs, with_rows=rows)
    return _errors_as_json(run)


def set_promoted(model_id: str, val: dict, holdout: dict | None) -> dict:
    """Move the promoted pointer (the C6 decision is made in redteam.promotion before this is called)."""
    if GATE_BACKEND == "stub":
        return gate_stub.set_promoted(model_id, val, holdout)
    from gatepy.model_io import set_promoted as gate_set_promoted
    return gate_set_promoted(model_id, val=val, holdout=holdout, models_dir=MODELS_DIR)


def model_features(model_id: str | None) -> list[str]:
    if not model_id:
        return []
    try:
        return list(json.loads((MODELS_DIR / f"{model_id}.json").read_text())["features"])
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return []


def restore_features(model_id: str) -> None:
    """After a refused promotion, put the promoted model's feature code back (the coordinator edits in place)."""
    if GATE_BACKEND == "stub":
        return
    from gatepy.model_io import restore_features as gate_restore
    gate_restore(model_id, models_dir=MODELS_DIR)


def evaluate_as_trained(model_id: str, split: str = "all", ids: list[str] | None = None,
                        rows: bool = False) -> dict:
    """evaluate() with the model's own feature code, even if the coordinator has edited gate/features since.

    The current feature files are snapshotted, the model's are restored for the call, then the snapshot is put back."""
    if GATE_BACKEND == "stub":
        return evaluate(model_id, split, ids, rows)
    feat_dir, cfg = GATE_DIR / "features", GATE_DIR / "train_config.yaml"
    snap = {p: p.read_bytes() for p in [*feat_dir.glob("*.py"), cfg] if p.exists()}
    try:
        restore_features(model_id)
        return evaluate(model_id, split, ids, rows)
    finally:
        for p in feat_dir.glob("*.py"):
            if p not in snap:
                p.unlink()
        for p, b in snap.items():
            p.write_bytes(b)


def preload() -> None:
    """Import the real Gate (numpy, LightGBM, scikit-learn) on the calling thread.

    The MCP server must call this on its main thread at startup: FastMCP runs tools in worker threads, and on
    Windows a first import of these native extensions from a worker thread while the main thread is serving stdio
    deadlocks inside the DLL loader."""
    if GATE_BACKEND == "stub":
        return
    import gatepy.evaluate  # noqa: F401
    import gatepy.model_io  # noqa: F401
    import gatepy.train  # noqa: F401


def _promoted_id() -> str | None:
    p = MODELS_DIR / "promoted.json"
    return json.loads(p.read_text()).get("model_id") if p.exists() else None
