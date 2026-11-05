"""Attack families, the held-out families and the static policy files that live next to them."""
import json
from functools import cache
from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parents[2]


def _load(name: str) -> dict:
    return json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))


@cache
def families() -> dict[str, dict]:
    return {f["id"]: f for f in _load("families.json")["families"]}


@cache
def holdout_families() -> frozenset[str]:
    return frozenset(_load("families.json")["holdout_families"])


@cache
def holdout_generator_models() -> tuple[str, ...]:
    return tuple(_load("families.json")["holdout_generator_models"])


@cache
def legit_hard() -> tuple[str, ...]:
    return tuple(_load("families.json")["legit_hard"])


@cache
def policy_bounded_families() -> frozenset[str]:
    """Families reported apart from recall: bounded by policy (the unknown-seller cap), not learnable today."""
    return frozenset(f["id"] for f in _load("families.json")["families"] if f.get("policy_bounded"))


REAL_FAMILY = "real"


def label_of(family: str) -> str:
    """'legit' for real listings and legit_* families, otherwise the family's label."""
    if family == REAL_FAMILY:
        return "legit"
    return families()[family]["label"]


@cache
def allowlist() -> dict:
    return _load("allowlist.json")


@cache
def injection_patterns() -> dict:
    return _load("injection_patterns.json")
