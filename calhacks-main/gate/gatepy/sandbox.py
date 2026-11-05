"""Static policy for gate/features/*.py, checked before any feature module is imported.

The coordinator may write feature code, and that code runs inside processes that see data the coordinator must not
(the holdout is scored in-process by the red-team MCP server). The runtime self-test only guards one call, so this
check keeps feature modules to pure computation:

- imports only from the allowlist below (no os, sys, io, pathlib, subprocess, socket, importlib, pickle, ...);
- no builtins that reach files, code or other objects by name (open, exec, eval, getattr, globals, __import__, ...);
- no private or dunder attribute access, no dunder names, and no string constants containing "__"
  (blocks object-graph and str.format escapes such as "{0.__globals__}").
"""
import ast
from pathlib import Path

ANY = "*"
# module -> names that may be imported from it (ANY = any public name).
FROM_IMPORTS: dict[str, set[str] | str] = {
    "__future__": {"annotations"},
    "calhacks_contracts": {"GateInput", "Listing", "Mandate", "References", "Seller", "Item", "Checkout",
                           "KnownSeller"},
    "calhacks_contracts.families": {"injection_patterns", "allowlist"},
    "gatepy.registry": {"feature"},
    "gatepy.clock": {"days_since", "as_of"},
    "features._text": ANY,
    "math": ANY,
    "unicodedata": ANY,
    "itertools": ANY,
    "re": {"compile", "sub", "subn", "search", "match", "fullmatch", "findall", "finditer", "split", "escape",
           "I", "IGNORECASE", "U", "UNICODE", "M", "MULTILINE", "S", "DOTALL", "X", "VERBOSE", "A", "ASCII"},
    "hashlib": {"sha256", "sha1", "md5", "blake2b"},
    "difflib": {"SequenceMatcher", "get_close_matches"},
    "statistics": {"mean", "fmean", "median", "pstdev", "stdev"},
    "collections": {"Counter", "defaultdict", "OrderedDict"},
    "functools": {"lru_cache", "cache", "reduce"},
    "typing": {"Any", "Optional", "Union", "Iterable", "Sequence", "Mapping", "Callable", "Literal"},
}
# `import X` is allowed for these; attribute access on X is then limited the same way.
PLAIN_IMPORTS = {"math", "unicodedata", "itertools", "re", "hashlib", "statistics"}
BANNED_NAMES = {
    "open", "exec", "eval", "compile", "__import__", "globals", "locals", "vars", "getattr", "setattr", "delattr",
    "input", "breakpoint", "help", "exit", "quit", "memoryview", "dir", "object",
}


# Attributes that read files or walk frames/code objects back to other modules' globals.
BANNED_ATTRS = {"parse_file", "load", "loads", "dump", "dumps", "mro", "func_globals"}
BANNED_ATTR_PREFIXES = ("f_", "gi_", "cr_", "ag_", "tb_", "co_")


class FeaturePolicyError(ValueError):
    """A feature module breaks the sandbox policy; it is never imported."""


def _allowed(module: str, name: str) -> bool:
    rule = FROM_IMPORTS.get(module)
    if rule is None or name.startswith("_"):
        return False
    return rule == ANY or name in rule


def check_source(src: str, filename: str = "<feature>") -> list[str]:
    """Policy violations in one module's source (empty list = allowed)."""
    try:
        tree = ast.parse(src, filename=filename)
    except SyntaxError as e:
        return [f"{filename}: syntax error: {e.msg} (line {e.lineno})"]
    errors = []
    modules: dict[str, str] = {}  # local alias -> module, for `import re`
    for node in ast.walk(tree):
        where = f"{filename}:{getattr(node, 'lineno', '?')}"
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name not in PLAIN_IMPORTS:
                    errors.append(f"{where}: import {a.name} is not allowed in features")
                modules[a.asname or a.name] = a.name
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if node.level:  # relative: `from ._text import x` or `from . import _text`
                mod = "features" + ("." + mod if mod else "")
            for a in node.names:
                if mod == "features" and a.name == "_text":
                    modules[a.asname or a.name] = "features._text"
                elif a.name == "*" or not _allowed(mod, a.name):
                    errors.append(f"{where}: from {mod} import {a.name} is not allowed in features")
        elif isinstance(node, ast.Name):
            if node.id in BANNED_NAMES or node.id.startswith("__"):
                errors.append(f"{where}: name {node.id!r} is not allowed in features")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                errors.append(f"{where}: private attribute .{node.attr} is not allowed in features")
            elif node.attr in BANNED_ATTRS or node.attr.startswith(BANNED_ATTR_PREFIXES):
                errors.append(f"{where}: attribute .{node.attr} is not allowed in features")
            elif isinstance(node.value, ast.Name) and node.value.id in modules:
                if not _allowed(modules[node.value.id], node.attr):
                    errors.append(f"{where}: {node.value.id}.{node.attr} is not allowed in features")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "__" in node.value:
            errors.append(f"{where}: string constants containing '__' are not allowed in features")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name.startswith("__"):
            errors.append(f"{where}: dunder definition {node.name!r} is not allowed in features")
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            errors.append(f"{where}: global/nonlocal is not allowed in features")
    return errors


def check_dir(features_dir: Path) -> list[str]:
    """Check every .py file in gate/features/ (including __init__.py and shared helpers)."""
    errors = []
    for p in sorted(features_dir.glob("*.py")):
        errors += check_source(p.read_text(encoding="utf-8"), f"features/{p.name}")
    return errors


def enforce(features_dir: Path) -> None:
    errors = check_dir(features_dir)
    if errors:
        raise FeaturePolicyError("feature sandbox: " + "; ".join(errors[:8]))
