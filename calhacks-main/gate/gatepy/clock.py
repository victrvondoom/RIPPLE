"""The one "today" features may use for ages (wallet first seen).

Fixed per process: `GATE_AS_OF` (YYYY-MM-DD) if set, otherwise the date the process started. Model files record it.
"""
import os
from datetime import date

_AS_OF = date.fromisoformat(os.environ["GATE_AS_OF"]) if os.environ.get("GATE_AS_OF") else date.today()


def as_of() -> date:
    return _AS_OF


def days_since(iso: str | None) -> float:
    """Whole days from an ISO date to as_of(), floored at 0. None (unknown) gives 0."""
    if not iso:
        return 0.0
    return float(max(0, (_AS_OF - date.fromisoformat(iso[:10])).days))
