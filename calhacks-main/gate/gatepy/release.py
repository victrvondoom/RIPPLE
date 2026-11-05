"""gate-release: move a trained model between a run's models folder, the gates/ archive and the deployed Gate.

  gate-release export  MODEL_ID --models DIR [--gates gates/]   model + its exact feature code -> gates/MODEL_ID/
  gate-release install [MODEL_ID] [--gates gates/]              gates/MODEL_ID/ -> gate/models + gate/features
  gate-release verify  [MODEL_ID]                               feature-code hash check against the model file

A model only works with the feature code it was trained with, so a release is the model file plus that code (taken
from the model file's own `feature_sources`, never from a red-team worktree). `install` with no MODEL_ID uses
gates/CURRENT. The service (gatepy.app) refuses to start when `verify` would fail.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

from gatepy import GATE_DIR, MODELS, REPO
from gatepy.model_io import load

GATES = REPO / "gates"


def current(gates: Path = GATES) -> str:
    return (gates / "CURRENT").read_text(encoding="utf-8").strip()


def export(model_id: str, models_dir: Path, gates: Path = GATES) -> dict:
    """gates/MODEL_ID/: model.json, features/*.py and train_config.yaml exactly as the model was trained."""
    meta = load(model_id, models_dir).meta
    out = gates / model_id
    if out.exists():
        shutil.rmtree(out)
    (out / "features").mkdir(parents=True)
    shutil.copy2(models_dir / f"{model_id}.json", out / "model.json")
    for name, src in sorted(meta["feature_sources"].items()):
        (out / "features" / name).write_text(src, encoding="utf-8", newline="\n")
    (out / "train_config.yaml").write_text(meta["config_source"], encoding="utf-8", newline="\n")
    return {"model_id": model_id, "dir": str(out), "features": sorted(meta["feature_sources"]),
            "feature_code_hash": meta["feature_code_hash"]}


def install(model_id: str | None = None, gates: Path = GATES, gate_dir: Path = GATE_DIR,
            models_dir: Path | None = None) -> dict:
    """Replace the Gate's feature code with the release's and put its model file where the service loads it."""
    model_id = model_id or current(gates)
    src = gates / model_id
    if not (src / "model.json").exists():
        raise SystemExit(f"no release {model_id!r} in {gates}")
    models_dir = models_dir or gate_dir / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / "model.json", models_dir / f"{model_id}.json")
    feat = gate_dir / "features"
    for stale in feat.glob("*.py"):
        stale.unlink()
    for f in sorted((src / "features").glob("*.py")):
        shutil.copy2(f, feat / f.name)
    shutil.copy2(src / "train_config.yaml", gate_dir / "train_config.yaml")
    return {"model_id": model_id, **verify(model_id, models_dir, gate_dir)}


def code_hash(feat_dir: Path) -> str:
    """Same digest as registry.feature_code_hash, for any features folder."""
    import hashlib
    h = hashlib.sha256()
    for p in sorted(feat_dir.glob("*.py")):
        h.update(p.name.encode())
        h.update(p.read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()


def verify(model_id: str, models_dir: Path = MODELS, gate_dir: Path = GATE_DIR) -> dict:
    want = load(model_id, models_dir).meta["feature_code_hash"]
    have = code_hash(gate_dir / "features")
    if want != have:
        raise SystemExit(f"feature code does not match {model_id}: model {want[:12]}, gate/features {have[:12]}; "
                         f"run gate-release install {model_id}")
    return {"feature_code_hash": have, "verified": True}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="gate-release", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("model_id")
    e.add_argument("--models", type=Path, required=True)
    e.add_argument("--gates", type=Path, default=GATES)
    i = sub.add_parser("install")
    i.add_argument("model_id", nargs="?")
    i.add_argument("--gates", type=Path, default=GATES)
    v = sub.add_parser("verify")
    v.add_argument("model_id", nargs="?")
    a = ap.parse_args(argv)
    if a.cmd == "export":
        out = export(a.model_id, a.models.resolve(), a.gates.resolve())
    elif a.cmd == "install":
        out = install(a.model_id, a.gates.resolve())
    else:
        out = verify(a.model_id or current())
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
