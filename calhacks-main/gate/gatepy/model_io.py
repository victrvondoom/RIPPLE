"""Model files (gate/models/{model_id}.json), the promoted pointer, and risk + explanation from a loaded model."""
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
from calhacks_contracts import Reason

from gatepy import GATE_DIR, MODELS

PROMOTED = "promoted.json"


@dataclass
class Model:
    meta: dict
    _booster: lgb.Booster | None = field(default=None, repr=False)

    @property
    def model_id(self) -> str:
        return self.meta["model_id"]

    @property
    def features(self) -> list[str]:
        return self.meta["features"]

    @property
    def threshold(self) -> float:
        return float(self.meta["threshold"])

    def _raw(self, X: np.ndarray) -> np.ndarray:
        c = self.meta["coef"]
        return (X - np.array(c["mean"])) / np.array(c["scale"])

    def predict_risk(self, X: np.ndarray) -> np.ndarray:
        if len(X) == 0:
            return np.zeros(0)
        if self.meta["kind"] == "lightgbm":
            return self._booster.predict(X)
        c = self.meta["coef"]
        z = c["intercept"] + self._raw(X) @ np.array(c["weights"])
        return 1.0 / (1.0 + np.exp(-z))

    def contributions(self, X: np.ndarray) -> np.ndarray:
        """Per-feature contribution to the log-odds of risk, shape (n, n_features)."""
        if len(X) == 0:
            return np.zeros((0, len(self.features)))
        if self.meta["kind"] == "lightgbm":
            return self._booster.predict(X, pred_contrib=True)[:, :-1]
        return self._raw(X) * np.array(self.meta["coef"]["weights"])

    def top3(self, x: np.ndarray, contrib: np.ndarray) -> list[Reason]:
        """The three features that moved this listing's risk the most (G5)."""
        order = np.argsort(-np.abs(contrib), kind="stable")[:3]
        return [Reason(feature=self.features[i], value=round(float(x[i]), 4), contribution=round(float(contrib[i]), 4))
                for i in order]


def from_meta(meta: dict) -> Model:
    booster = lgb.Booster(model_str=meta["booster"]) if meta["kind"] == "lightgbm" else None
    return Model(meta, booster)


def save(meta: dict, models_dir: Path = MODELS) -> Path:
    models_dir.mkdir(parents=True, exist_ok=True)
    path = models_dir / f"{meta['model_id']}.json"
    path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return path


def read_promoted(models_dir: Path = MODELS) -> dict | None:
    p = models_dir / PROMOTED
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def load(model_id: str = "promoted", models_dir: Path = MODELS) -> Model:
    if model_id == "promoted":
        pointer = read_promoted(models_dir)
        if not pointer:
            raise FileNotFoundError(f"no promoted model in {models_dir}")
        model_id = pointer["model_id"]
    path = models_dir / f"{model_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"no model {model_id!r} in {models_dir}")
    return from_meta(json.loads(path.read_text(encoding="utf-8")))


def set_promoted(model_id: str, val: dict | None = None, holdout: dict | None = None,
                 models_dir: Path = MODELS) -> dict:
    """Point promoted.json at model_id and append to its history. The promotion *rule* lives in redteam."""
    model = load(model_id, models_dir)
    pointer = read_promoted(models_dir) or {"model_id": None, "history": []}
    pointer["model_id"] = model_id
    pointer["history"].append({
        "model_id": model_id, "round": model.meta["round"],
        "promoted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "val": val if val is not None else model.meta.get("val_metrics"), "holdout": holdout,
    })
    (models_dir / PROMOTED).write_text(json.dumps(pointer, indent=1), encoding="utf-8")
    return pointer


def restore_features(model_id: str = "promoted", models_dir: Path = MODELS, gate_dir: Path = GATE_DIR) -> list[str]:
    """Rewrite gate/features/*.py and train_config.yaml exactly as they were when model_id was trained.

    Used on revert: the coordinator edits features in place, so a rejected candidate must not leave its
    feature code behind for the promoted model. Returns the files written."""
    meta = load(model_id, models_dir).meta
    written = []
    feat_dir = gate_dir / "features"
    for stale in feat_dir.glob("*.py"):
        if stale.name not in meta["feature_sources"]:
            stale.unlink()
            written.append(f"features/{stale.name} (removed)")
    for name, src in meta["feature_sources"].items():
        (feat_dir / name).write_text(src, encoding="utf-8", newline="\n")
        written.append(f"features/{name}")
    if meta.get("config_is_default"):
        (gate_dir / "train_config.yaml").write_text(meta["config_source"], encoding="utf-8", newline="\n")
        written.append("train_config.yaml")
    return written
