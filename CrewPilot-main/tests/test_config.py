"""Tests for configuration parsing and validation."""

from __future__ import annotations

import pytest

from config import ConfigError, Settings


def test_settings_from_env_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWITCH_API_URL", "http://localhost:8000")
    monkeypatch.setenv("SWITCH_AGENT_ID", "agent-123")
    monkeypatch.setenv("SWITCH_API_KEY", "secret-key")
    monkeypatch.setenv("SWITCH_AGENT_NAME", "crewpilot")
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")

    settings = Settings.from_env()
    assert settings.switch_api_url == "http://localhost:8000"
    assert settings.switch_agent_id == "agent-123"
    assert settings.switch_api_key == "secret-key"
    assert settings.switch_agent_name == "crewpilot"
    assert settings.llm_provider == "openai"
    assert settings.openai_api_key == "sk-test-openai"


def test_settings_secrets_excluded_from_repr() -> None:
    settings = Settings(
        switch_api_url="https://switch.example.com",
        switch_agent_id="agent-uuid",
        switch_api_key="super-secret-key",
        switch_agent_name="crewpilot",
        llm_provider="openai",
        openai_api_key="sk-secret-key",
    )
    rep = repr(settings)
    assert "super-secret-key" not in rep
    assert "sk-secret-key" not in rep
    assert "agent-uuid" not in rep


def test_invalid_llm_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWITCH_API_URL", "http://localhost:8000")
    monkeypatch.setenv("SWITCH_AGENT_ID", "agent-123")
    monkeypatch.setenv("SWITCH_API_KEY", "secret-key")
    monkeypatch.setenv("LLM_PROVIDER", "unsupported_provider")

    with pytest.raises(ConfigError, match="LLM_PROVIDER must be 'openai', 'anthropic', or 'groq'"):
        Settings.from_env()


def test_missing_switch_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWITCH_API_URL", "http://localhost:8000")
    monkeypatch.delenv("SWITCH_AGENT_ID", raising=False)
    monkeypatch.delenv("SWITCH_API_KEY", raising=False)
    monkeypatch.setattr("config.load_saved_credentials", lambda: {})

    with pytest.raises(ConfigError, match="Switch agent credentials are missing"):
        Settings.from_env()


def test_missing_openai_key_when_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWITCH_API_URL", "http://localhost:8000")
    monkeypatch.setenv("SWITCH_AGENT_ID", "agent-123")
    monkeypatch.setenv("SWITCH_API_KEY", "secret-key")
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(ConfigError, match="OPENAI_API_KEY is required"):
        Settings.from_env()


def test_missing_anthropic_key_when_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWITCH_API_URL", "http://localhost:8000")
    monkeypatch.setenv("SWITCH_AGENT_ID", "agent-123")
    monkeypatch.setenv("SWITCH_API_KEY", "secret-key")
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(ConfigError, match="ANTHROPIC_API_KEY is required"):
        Settings.from_env()


def test_missing_groq_key_when_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWITCH_API_URL", "http://localhost:8000")
    monkeypatch.setenv("SWITCH_AGENT_ID", "agent-123")
    monkeypatch.setenv("SWITCH_API_KEY", "secret-key")
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    with pytest.raises(ConfigError, match="GROQ_API_KEY is required"):
        Settings.from_env()


def test_invalid_switch_api_url_scheme() -> None:
    settings = Settings(
        switch_api_url="ftp://invalid-url",
        switch_agent_id="agent-123",
        switch_api_key="secret-key",
        switch_agent_name="crewpilot",
        llm_provider="openai",
        openai_api_key="sk-test",
    )
    with pytest.raises(ConfigError, match="SWITCH_API_URL must be the Switch agent bridge"):
        settings.validate()
