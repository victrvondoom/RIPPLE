"""Bitdeer Model Studio client (OpenAI-compatible): JSON-object mode, bounded retries, token tally.

JSON-object mode plus our own validation, rather than strict json_schema: strict schemas on Bitdeer produced
runs of whitespace instead of an answer.
"""
import json
import os
import threading
import time
from dataclasses import dataclass, field

from redteam.config import BITDEER_BASE

RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504}


def make_client():
    from openai import OpenAI
    key = os.environ.get("BITDEER_API_KEY")
    if not key:
        raise RuntimeError("BITDEER_API_KEY is not set (put it in <repo>/.env or .env.local)")
    return OpenAI(base_url=BITDEER_BASE, api_key=key, timeout=240, max_retries=0)


@dataclass
class Tally:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    calls: int = 0
    failures: int = 0
    by_model: dict = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, model: str, usage) -> None:
        p, c = (usage.prompt_tokens, usage.completion_tokens) if usage else (0, 0)
        with self._lock:
            self.calls += 1
            self.prompt_tokens += p
            self.completion_tokens += c
            m = self.by_model.setdefault(model, [0, 0])
            m[0] += p
            m[1] += c

    def fail(self) -> None:
        with self._lock:
            self.failures += 1

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def as_dict(self) -> dict:
        return {"prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens, "calls": self.calls,
                "failures": self.failures, "by_model": self.by_model}


CALL_DEADLINE_S = 300.0


def _create(client, deadline: float, **kw):
    """client.chat.completions.create with a wall-clock deadline. The client's own timeout bounds each socket wait,
    not the whole call, and a silent Bitdeer request once held a run for 20 minutes. A call that overruns is
    abandoned on a daemon thread (it can't be cancelled) and reported as a timeout."""
    out: dict = {}

    def call():
        try:
            out["resp"] = client.chat.completions.create(**kw)
        except BaseException as e:  # handed to the caller below
            out["err"] = e
    t = threading.Thread(target=call, daemon=True)
    t.start()
    t.join(deadline)
    if t.is_alive():
        raise TimeoutError(f"Bitdeer call exceeded {deadline:.0f}s")
    if "err" in out:
        raise out["err"]
    return out["resp"]


def complete_json(client, model: str, messages: list[dict], temperature: float, tally: Tally,
                  max_tokens: int = 12000, attempts: int = 3, sleep=time.sleep,
                  deadline: float | None = None) -> dict | None:
    """One chat completion parsed as JSON. Returns None after `attempts` failures (caller drops or retries the slots).
    Each attempt is cut off after `deadline` seconds (CALL_DEADLINE_S by default) and counts as a retryable failure."""
    for attempt in range(attempts):
        try:
            resp = _create(client, CALL_DEADLINE_S if deadline is None else deadline, model=model, messages=messages,
                           temperature=temperature, max_tokens=max_tokens, response_format={"type": "json_object"})
            tally.add(model, getattr(resp, "usage", None))
            content = resp.choices[0].message.content or ""
            return json.loads(content)
        except json.JSONDecodeError:
            tally.fail()
        except Exception as e:  # openai.APIStatusError, timeouts, connection errors
            tally.fail()
            status = getattr(e, "status_code", None)
            if status is not None and status not in RETRY_STATUS:
                return None
        sleep(min(30, 2 ** attempt * 2))
    return None
