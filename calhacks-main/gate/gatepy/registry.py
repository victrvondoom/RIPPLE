"""Feature plugin registry. Modules in gate/features/ register pure functions of a GateInput with @feature.

A feature sees only the GateInput (mandate, the listing the Gate fetched itself, references the Gate looked up):
never the answer key, generator info, listing meta or where the listing came from.
"""
import builtins
import hashlib
import importlib
import math
import pkgutil
import socket
import sys
from collections.abc import Callable
from dataclasses import dataclass

from calhacks_contracts import GateInput

from gatepy import GATE_DIR
from gatepy.sandbox import FeaturePolicyError, enforce

enforce(GATE_DIR / "features")  # before the features package (and its __init__) is imported at all
import features as features_pkg  # noqa: E402

FeatureFn = Callable[[GateInput], float]


@dataclass(frozen=True)
class Feature:
    name: str
    fn: FeatureFn
    monotone: int
    module: str


REGISTRY: dict[str, Feature] = {}


def feature(name: str, monotone: int = 0):
    """Register a feature. monotone=-1: risk must not rise as the value rises; +1: must not fall; 0: free."""
    if monotone not in (-1, 0, 1):
        raise ValueError(f"monotone must be -1, 0 or 1, not {monotone!r}")

    def wrap(fn: FeatureFn) -> FeatureFn:
        if name in REGISTRY and REGISTRY[name].module != fn.__module__:
            raise ValueError(f"feature {name!r} registered twice ({REGISTRY[name].module}, {fn.__module__})")
        REGISTRY[name] = Feature(name, fn, monotone, fn.__module__)
        return fn

    return wrap


def discover() -> dict[str, Feature]:
    """Import (or re-import) every module in gate/features/ and return the registry.

    Raises FeaturePolicyError, without importing anything, if any feature file breaks the sandbox policy."""
    enforce(GATE_DIR / "features")
    REGISTRY.clear()
    for info in sorted(pkgutil.iter_modules(features_pkg.__path__), key=lambda m: m.name):
        mod = f"features.{info.name}"
        if mod in sys.modules:
            importlib.reload(sys.modules[mod])
        else:
            importlib.import_module(mod)
    return dict(REGISTRY)


def select(names: list[str] | str, exclude: list[str] = ()) -> list[Feature]:
    reg = REGISTRY or discover()
    chosen = sorted(reg) if names == "all" else list(names)
    missing = [n for n in chosen if n not in reg]
    if missing:
        raise KeyError(f"unknown features: {missing}")
    return [reg[n] for n in chosen if n not in exclude]


def compute(x: GateInput, feats: list[Feature]) -> list[float]:
    return [float(f.fn(x)) for f in feats]


def feature_code_hash() -> str:
    h = hashlib.sha256()
    for p in sorted((GATE_DIR / "features").glob("*.py")):
        h.update(p.name.encode())
        h.update(p.read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()


class _Forbidden(RuntimeError):
    pass


def _forbid(*_a, **_k):
    raise _Forbidden("features must not do I/O or use the network")


def self_test(feats: list[Feature], inputs: list[GateInput]) -> list[str]:
    """Every feature must return the same finite float twice, without opening files or sockets."""
    errors = []
    saved = builtins.open, socket.socket, socket.create_connection
    builtins.open, socket.socket, socket.create_connection = _forbid, _forbid, _forbid
    try:
        for f in feats:
            for x in inputs:
                lid = x.listing.listing_id
                try:
                    a, b = f.fn(x), f.fn(x)
                    if isinstance(a, bool) or not isinstance(a, (int, float)):
                        errors.append(f"{f.name}: returned {type(a).__name__} on {lid}")
                    elif not math.isfinite(a):
                        errors.append(f"{f.name}: non-finite {a!r} on {lid}")
                    elif a != b:
                        errors.append(f"{f.name}: not deterministic on {lid} ({a} vs {b})")
                except Exception as e:  # noqa: BLE001 - any failure fails the self-test
                    errors.append(f"{f.name}: {type(e).__name__}: {e} on {lid}")
                    break
    finally:
        builtins.open, socket.socket, socket.create_connection = saved
    return errors
