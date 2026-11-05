"""Tests for triage agent parsing, normalization, and validation."""

from __future__ import annotations

import pytest

from agent.triage_agent import (
    TriageAgent,
    TriageError,
    TriageResult,
    _extract_json,
    _normalize_plan,
    _pick,
)


def test_extract_json_clean_object() -> None:
    raw = '{"category": "bug", "severity": "high", "difficulty": "easy", "summary": "Fix login crash", "suggested_fix_plan": ["check null", "add test"]}'
    data = _extract_json(raw)
    assert data["category"] == "bug"
    assert data["summary"] == "Fix login crash"


def test_extract_json_markdown_fence() -> None:
    raw = """```json
    {
        "category": "feature",
        "severity": "low",
        "difficulty": "medium",
        "summary": "Add dark mode toggle",
        "suggested_fix_plan": ["update CSS", "add setting"]
    }
    ```"""
    data = _extract_json(raw)
    assert data["category"] == "feature"
    assert data["summary"] == "Add dark mode toggle"


def test_extract_json_surrounding_prose() -> None:
    raw = 'Here is the triage output:\n{"category": "chore", "suggested_fix_plan": ["update deps"]}\nHope this helps!'
    data = _extract_json(raw)
    assert data["category"] == "chore"


def test_extract_json_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(TriageError, match="did not contain a JSON object"):
        _extract_json("no json here")

    with pytest.raises(TriageError, match="invalid JSON"):
        _extract_json('{"invalid": foo}')

    monkeypatch.setattr("agent.triage_agent.json.loads", lambda _: ["not", "a", "dict"])
    with pytest.raises(TriageError, match="not an object"):
        _extract_json('{"valid": "json"}')


def test_normalize_plan_list_and_numbering() -> None:
    raw_plan = [
        "1. Identify reproduction steps",
        "2) Patch the database connection",
        "- Run pytest test suite",
        "* Deploy to staging",
    ]
    cleaned = _normalize_plan(raw_plan)
    assert cleaned == [
        "Identify reproduction steps",
        "Patch the database connection",
        "Run pytest test suite",
        "Deploy to staging",
    ]


def test_normalize_plan_multiline_string() -> None:
    text = "Step one\nStep two\nStep three"
    cleaned = _normalize_plan(text)
    assert cleaned == ["Step one", "Step two", "Step three"]


def test_normalize_plan_invalid() -> None:
    assert _normalize_plan(123) == []
    assert _normalize_plan(None) == []


def test_pick_allowed_values() -> None:
    allowed = {"bug", "feature", "question", "chore"}
    assert _pick("BUG", allowed, "bug") == "bug"
    assert _pick("feature", allowed, "bug") == "feature"
    assert _pick("invalid_category", allowed, "bug") == "bug"
    assert _pick(None, allowed, "chore") == "chore"


def test_triage_result_from_payload_success() -> None:
    payload = {
        "category": "BUG",
        "severity": "CRITICAL",
        "difficulty": "HARD",
        "summary": "Memory leak under high load",
        "suggested_fix_plan": ["Profile heap", "Fix circular ref", "Verify GC"],
    }
    result = TriageResult.from_payload(payload)
    assert result.category == "bug"
    assert result.severity == "critical"
    assert result.difficulty == "hard"
    assert result.summary == "Memory leak under high load"
    assert len(result.suggested_fix_plan) == 3
    assert result.to_dict()["category"] == "bug"


def test_triage_result_missing_plan_fails() -> None:
    payload = {
        "category": "bug",
        "severity": "low",
        "difficulty": "easy",
        "summary": "Small issue",
    }
    with pytest.raises(TriageError, match="missing 'suggested_fix_plan'"):
        TriageResult.from_payload(payload)


def test_triage_agent_empty_issue_fails() -> None:
    agent = TriageAgent(provider="openai", api_key="sk-test", model="gpt-4o-mini")
    with pytest.raises(TriageError, match="The issue text is empty"):
        agent.triage("   ")


def test_triage_agent_successful_mocked_triage(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = TriageAgent(provider="openai", api_key="sk-test", model="gpt-4o-mini")
    mock_json = (
        '{"category": "bug", "severity": "high", "difficulty": "medium", '
        '"summary": "Fix SSE reconnection loop", '
        '"suggested_fix_plan": ["1. Handle 409", "2. Reconnect"]}'
    )
    monkeypatch.setattr(agent, "_complete", lambda prompt: mock_json)

    result = agent.triage("Switch client reconnects indefinitely on 409")
    assert result.category == "bug"
    assert result.severity == "high"
    assert result.difficulty == "medium"
    assert result.summary == "Fix SSE reconnection loop"
    assert result.suggested_fix_plan == ["Handle 409", "Reconnect"]
