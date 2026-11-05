"""Paths, model ids and budgets. Everything else imports from here.

Data lives in MongoDB (calhacks_contracts.db); this module only holds local paths (models, round logs, holdout).
"""
import os
from pathlib import Path

from calhacks_contracts.db import load_env
from calhacks_contracts.families import families, holdout_families, legit_hard

REPO = Path(__file__).resolve().parents[3]
load_env(REPO)

GATE_DIR = REPO / "gate"  # the coordinator's cwd
MODELS_DIR = Path(os.environ.get("CALHACKS_MODELS", GATE_DIR / "models")).resolve()  # override is for tests only
DATA = Path(os.environ.get("CALHACKS_DATA", REPO / "data")).resolve()  # local logs only; listings are in MongoDB
ROUNDS = DATA / "rounds"
HOLDOUT = Path(os.environ.get("CALHACKS_HOLDOUT", REPO.parent / "calhacks-holdout")).resolve()
HOLDOUT_FILE = HOLDOUT / "holdout.v3.enc"
HOLDOUT_KEY_FILE = HOLDOUT / "holdout.key"
FACTORY_SETTINGS = REPO / "redteam" / "factory" / "settings.json"

BITDEER_BASE = "https://api-inference.bitdeer.ai/v1"
BULK_MODELS = ["zai-org/GLM-5.3-Flash", "deepseek-ai/DeepSeek-V4.1-Flash"]
HOLDOUT_MODEL = "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B"
COORDINATOR_MODEL = "custom:DeepSeek-V4.1-Flash-(Bitdeer)-0"
STRATEGIST_DROID = "attack-strategist"
PROMPT_VERSION = "v2"

# Approximate USD per 1M tokens (input, output), upper-bound Bitdeer list prices.
PRICES = {
    "zai-org/GLM-5.3": (1.40, 4.40),
    "zai-org/GLM-5.3-Flash": (0.15, 0.50),
    "deepseek-ai/DeepSeek-V4.1-Flash": (0.30, 1.20),
    HOLDOUT_MODEL: (0.30, 1.20),
}

BATCH_SIZE = 3           # LLM slots per Bitdeer call (the models spend ~2.3k output tokens per slot, mostly reasoning)
TOKENS_PER_SLOT = 5000   # max_tokens = slots * TOKENS_PER_SLOT; a too-small cap truncates the JSON
CONCURRENCY = 16
ROUND_BUDGET = {"usd": 5.0, "tokens": 3_000_000, "minutes": 20.0}  # C8, per round
ROUND_WALL_SECONDS = int(ROUND_BUDGET["minutes"] * 60)  # tools close near the end of this window
ROUND_FINISH_SECONDS = 6 * 60   # after the window: time to promote and write the CoordinatorOutput, then interrupted
MAX_TRAIN_CALLS = 6             # train_gate calls per round
FAMILY_ROUND_CAP = 40           # coordinator-generated scams per family per round (the base dataset covers the rest)
MIN_FAMILY_VAL = 3              # promotion needs at least this many val rows of every seen scam family

# C6 promotion rule
MAX_FPR = 0.02
MAX_FAMILY_DROP = 0.05

# Mandate defaults for synthetic cases (mirrors contracts-ingest)
MANDATE_PRICE_FACTOR = 1.25
MANDATE_SPEND = 100.0


def scam_families(include_holdout: bool = False) -> list[str]:
    hold = holdout_families()
    return [k for k, f in families().items() if f["label"] == "scam" and (include_holdout or k not in hold)]


def legit_families() -> list[str]:
    return [k for k, f in families().items() if f["label"] == "legit"]


def needs_llm(family: str) -> bool:
    return bool(families()[family]["needs_llm"])


def usd(model: str | None, prompt_tokens: int, completion_tokens: int) -> float:
    pi, po = PRICES.get(model or "", (0.30, 1.20))
    return prompt_tokens / 1e6 * pi + completion_tokens / 1e6 * po


def round_dir(n: int) -> Path:
    d = ROUNDS / f"R{n}"
    d.mkdir(parents=True, exist_ok=True)
    return d


__all__ = ["families", "holdout_families", "legit_hard"]
