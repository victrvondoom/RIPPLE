"""Local storage for credentials issued by a Switch server."""

from __future__ import annotations

import json
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_PATH = PROJECT_ROOT / ".switch" / "agent.json"

_KEYS = ("api_url", "agent_id", "api_key", "agent_name")


def load_saved_credentials() -> dict[str, str]:
    """Return credentials saved by `python -m switch.register_agent`, if any."""
    try:
        raw = CREDENTIALS_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}

    return {
        key: data[key].strip()
        for key in _KEYS
        if isinstance(data.get(key), str) and data[key].strip()
    }


def save_credentials(values: dict[str, str]) -> Path:
    """Persist credentials locally, readable only by the current user where possible."""
    credentials = {key: values[key] for key in _KEYS if values.get(key)}
    CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_PATH.write_text(
        json.dumps(credentials, indent=2) + "\n",
        encoding="utf-8",
    )
    try:
        os.chmod(CREDENTIALS_PATH, 0o600)
    except OSError:
        pass
    return CREDENTIALS_PATH
