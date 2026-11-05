"""LLM-backed triage agent.

The agent is deliberately independent of Discord and Switch: it accepts plain
issue text and returns a validated TriageResult. That separation lets the same
agent run behind a different chat platform or middleware later.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from agent.prompts import SYSTEM_PROMPT

if TYPE_CHECKING:
    from config import Settings

CATEGORIES = {"bug", "feature", "question", "chore"}
SEVERITIES = {"critical", "high", "medium", "low"}
DIFFICULTIES = {"easy", "medium", "hard"}

MAX_ISSUE_CHARS = 12_000
MAX_PLAN_STEPS = 8

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


class TriageError(RuntimeError):
    """Raised when the agent cannot produce a valid triage result."""


@dataclass(frozen=True)
class TriageResult:
    category: str
    severity: str
    difficulty: str
    summary: str
    suggested_fix_plan: list[str] = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "TriageResult":
        """Validate and normalize the model's JSON into a safe, display-ready result."""
        if not isinstance(payload, dict):
            raise TriageError("Triage payload must be a JSON object.")

        plan = _normalize_plan(payload.get("suggested_fix_plan"))
        if not plan:
            raise TriageError("Triage payload is missing 'suggested_fix_plan'.")

        summary = str(payload.get("summary") or "").strip()
        return cls(
            category=_pick(payload.get("category"), CATEGORIES, "bug"),
            severity=_pick(payload.get("severity"), SEVERITIES, "medium"),
            difficulty=_pick(payload.get("difficulty"), DIFFICULTIES, "medium"),
            summary=summary or "The model did not provide a summary.",
            suggested_fix_plan=plan,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "severity": self.severity,
            "difficulty": self.difficulty,
            "summary": self.summary,
            "suggested_fix_plan": self.suggested_fix_plan,
        }


class TriageAgent:
    """Turns free-form issue text into a structured triage result via an LLM."""

    def __init__(
        self,
        provider: str,
        api_key: str,
        model: str,
        *,
        base_url: str | None = None,
    ) -> None:
        self._provider = provider
        self._api_key = api_key
        self._model = model
        self._base_url = base_url

    @classmethod
    def from_settings(cls, settings: "Settings") -> "TriageAgent":
        if settings.llm_provider == "anthropic":
            return cls("anthropic", settings.anthropic_api_key or "", settings.anthropic_model)
        if settings.llm_provider == "groq":
            return cls(
                "groq",
                settings.groq_api_key or "",
                settings.groq_model,
                base_url=settings.groq_base_url,
            )
        return cls("openai", settings.openai_api_key or "", settings.openai_model)

    def triage(self, issue_text: str) -> TriageResult:
        cleaned = issue_text.strip()
        if not cleaned:
            raise TriageError("The issue text is empty.")

        try:
            raw = self._complete(cleaned[:MAX_ISSUE_CHARS])
        except TriageError:
            raise
        except Exception as exc:  # SDK/network errors become a user-safe message
            raise TriageError(f"LLM request failed: {exc}") from exc

        return TriageResult.from_payload(_extract_json(raw))

    def _complete(self, issue_text: str) -> str:
        user_prompt = f"<issue>\n{issue_text}\n</issue>"
        if self._provider == "openai":
            return self._complete_openai(user_prompt)
        if self._provider == "anthropic":
            return self._complete_anthropic(user_prompt)
        if self._provider == "groq":
            return self._complete_groq(user_prompt)
        raise TriageError(f"Unsupported LLM provider: {self._provider}")

    def _complete_openai(self, user_prompt: str) -> str:
        return self._complete_openai_compatible(user_prompt)

    def _complete_groq(self, user_prompt: str) -> str:
        # Groq exposes an OpenAI-compatible chat-completions API.
        return self._complete_openai_compatible(
            user_prompt, base_url=self._base_url
        )

    def _complete_openai_compatible(
        self,
        user_prompt: str,
        *,
        base_url: str | None = None,
    ) -> str:
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise TriageError(
                "The 'openai' package is not installed. Run: pip install -r requirements.txt"
            ) from exc

        client_options: dict[str, object] = {
            "api_key": self._api_key,
            "timeout": 45.0,
        }
        if base_url:
            client_options["base_url"] = base_url
        client = OpenAI(**client_options)
        response = client.chat.completions.create(
            model=self._model,
            temperature=0.2,
            max_tokens=900,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
        content = response.choices[0].message.content
        if not content:
            raise TriageError(f"{self._provider.title()} returned an empty response.")
        return content

    def _complete_anthropic(self, user_prompt: str) -> str:
        try:
            from anthropic import Anthropic
        except ImportError as exc:
            raise TriageError(
                "The 'anthropic' package is not installed. Run: pip install -r requirements.txt"
            ) from exc

        client = Anthropic(api_key=self._api_key, timeout=45.0)
        response = client.messages.create(
            model=self._model,
            max_tokens=1200,
            temperature=0.2,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        text = "".join(
            block.text for block in response.content if getattr(block, "type", "") == "text"
        )
        if not text.strip():
            raise TriageError("Anthropic returned an empty response.")
        return text


def _extract_json(raw: str) -> dict[str, Any]:
    """Parse JSON even if the model wrapped it in markdown fences or prose."""
    cleaned = _FENCE_RE.sub("", raw.strip())
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise TriageError("The model response did not contain a JSON object.")

    try:
        payload = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise TriageError(f"The model returned invalid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise TriageError("The model returned JSON that is not an object.")
    return payload


def _normalize_plan(value: Any) -> list[str]:
    """Accept a list or a newline-separated string and strip list numbering."""
    if isinstance(value, str):
        value = value.splitlines()
    if not isinstance(value, list):
        return []

    steps: list[str] = []
    for item in value:
        step = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", str(item)).strip()
        if step:
            steps.append(step)
    return steps[:MAX_PLAN_STEPS]


def _pick(value: Any, allowed: set[str], default: str) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if candidate in allowed else default
