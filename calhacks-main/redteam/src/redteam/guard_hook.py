"""PreToolUse guard for the coordinator (plan B6/C3/C5). Wired by coordinator.py into gate/.factory/hooks.json.

Protocol (Factory PreToolUse hooks): event JSON on stdin; exit 2 blocks the call and stderr is
shown to the model; exit 0 allows it.

Policy, by path rather than by keyword (the old hook blocked any input containing the word "holdout"):
  - every path in the input must resolve inside --root (the coordinator's cwd, gate/), and no path may name holdout data;
  - edits only to features/<name>.py (including shared helpers such as features/_text.py) or train_config.yaml:
    no subfolders, no __pycache__, no other file types;
  - Task only for the attack-strategist droid;
  - no shell, web, Skill or automation tools; MCP tools only from the redteam server.

Usage (in hooks.json): python guard_hook.py --root <gate dir> --log <jsonl path>
"""
import argparse
import json
import re
import sys
from pathlib import Path

EDIT_TOOLS = {"Edit", "MultiEdit", "Create", "ApplyPatch", "Write", "NotebookEdit"}
ALLOWED_EDIT = ("features/<name>.py", "train_config.yaml")
EDITABLE = re.compile(r"^(features/[A-Za-z0-9_]+\.py|train_config\.yaml)$")
DENY_TOOLS = {"Execute", "FetchUrl", "WebSearch", "Skill", "ConnectApp", "Bash", "PowerShell"}
STRATEGIST = "attack-strategist"
SEARCH_TOOLS = {"Grep", "Glob"}
PATH_KEYS = {"file_path", "path", "directory_path", "dir", "cwd", "target_file", "notebook_path", "folder"}
LIST_PATH_KEYS = {"paths", "file_paths", "files"}
PATTERN_KEYS = {"glob_pattern", "pattern", "glob"}
CONTENT_KEYS = {"content", "new_string", "old_string", "patch", "input", "edits", "new_source"}
HOLDOUT_TOKENS = ("calhacks-holdout", "holdout.key", "holdout.jsonl", "holdout.meta", "holdout.v2", "holdout.v3")
ABS_PATH = re.compile(r"(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]|file://|~[\\/])")
PARENT_SEG = re.compile(r"(?:^|[\\/])\.\.(?:[\\/]|$)")


def collect(inp, key=None, paths=None, patterns=None, strings=None):
    """Walk the tool input, sorting values into explicit paths, glob patterns and other free-text strings."""
    paths, patterns, strings = (paths if paths is not None else []), (patterns if patterns is not None else []), \
        (strings if strings is not None else [])
    if isinstance(inp, dict):
        for k, v in inp.items():
            collect(v, k, paths, patterns, strings)
    elif isinstance(inp, list):
        for v in inp:
            collect(v, key if key in LIST_PATH_KEYS else key, paths, patterns, strings)
    elif isinstance(inp, str):
        if key in PATH_KEYS or key in LIST_PATH_KEYS:
            paths.append(inp)
        elif key in PATTERN_KEYS:
            patterns.append(inp)
        elif key not in CONTENT_KEYS:
            strings.append(inp)
    return paths, patterns, strings


def patch_paths(inp: dict) -> list[str]:
    text = str(inp.get("patch", inp.get("input", "")))
    return [l.split(":", 1)[1].strip() for l in text.splitlines()
            if l.startswith(("*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"))]


def rel_inside(root: Path, p: str) -> str | None:
    """Root-relative posix path, or None if p resolves outside root."""
    p = p.strip().strip('"').removeprefix("file://")
    try:
        full = (root / p).resolve() if not Path(p).is_absolute() else Path(p).resolve()
        return full.relative_to(root).as_posix()
    except (ValueError, OSError):
        return None


def check(event: dict, root: Path) -> str | None:
    """Reason to deny, or None to allow."""
    tool = event.get("tool_name", "") or ""
    inp = event.get("tool_input") or {}
    if tool in DENY_TOOLS or "Automation" in tool:
        return f"tool {tool} is disabled for the coordinator"
    if "___" in tool and not tool.startswith("redteam___"):
        return f"only redteam MCP tools are allowed, not {tool}"
    if tool == "Task" and inp.get("subagent_type") != STRATEGIST:
        return f"Task may only run the {STRATEGIST} droid"

    blob = json.dumps(inp).replace("\\\\", "/").lower()
    if any(t in blob for t in HOLDOUT_TOKENS):
        return "holdout data is off-limits"
    paths, patterns, strings = collect(inp)
    if tool == "ApplyPatch":
        paths += patch_paths(inp)
    for p in paths:
        r = rel_inside(root, p)
        if r is None:
            return f"path outside the coordinator workspace: {p}"
        if any("holdout" in part.lower() for part in r.split("/")):
            return "holdout data is off-limits"
        if "tests" in r.split("/"):
            return "test files are off-limits; read features/, gatepy/ or layer1/ instead"
    for pat in patterns:
        if ABS_PATH.search(pat) or PARENT_SEG.search(pat):
            return f"pattern reaches outside the workspace: {pat}"
    for s in strings:
        if ABS_PATH.search(s) or PARENT_SEG.search(s):
            for m in re.findall(r"(?:[A-Za-z]:[\\/]|\\\\|file://|~[\\/]|\.\.[\\/])[^\s'\"]*", s):
                if rel_inside(root, m) is None:
                    return f"reference outside the coordinator workspace: {m[:80]}"

    if tool in SEARCH_TOOLS and not [p for p in paths if (rel_inside(root, p) or "") not in ("", ".")]:
        return "search inside a folder (features/, gatepy/ or layer1/), not the whole workspace"
    if tool in EDIT_TOOLS:
        targets = paths or ["<unknown>"]
        for p in targets:
            r = rel_inside(root, p) if p != "<unknown>" else None
            if not r or not EDITABLE.match(r):
                return f"edits are allowed only in {ALLOWED_EDIT}, not {p}"
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--log")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("Blocked by red-team policy: unreadable hook event", file=sys.stderr)
        return 2
    why = check(event, root)
    if a.log:
        with open(a.log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"tool": event.get("tool_name"), "decision": "deny" if why else "allow",
                                "why": why, "session": event.get("session_id")}) + "\n")
    if why:
        print(f"Blocked by red-team policy: {why}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
