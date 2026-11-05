"""Tests for GitHub issue URL parsing and resolution."""

from __future__ import annotations

import aiohttp
import pytest

from github_issues import GITHUB_ISSUE_RE, IssueFetchError, load_issue


def test_github_issue_regex() -> None:
    match = GITHUB_ISSUE_RE.search(
        "Check this https://github.com/vincenzo-afk/CrewPilot/issues/42 now"
    )
    assert match is not None
    owner, repo, number = match.groups()
    assert owner == "vincenzo-afk"
    assert repo == "CrewPilot"
    assert number == "42"


def test_github_issue_regex_no_match() -> None:
    assert GITHUB_ISSUE_RE.search("There is a bug in login flow") is None
    assert GITHUB_ISSUE_RE.search("https://github.com/vincenzo-afk/CrewPilot/pull/42") is None


async def test_load_issue_plain_text_passthrough() -> None:
    raw = "The application crashes on startup with zero division error."
    result = await load_issue(raw)
    assert result.source == "message text"
    assert result.text == raw


class _FakeResponse:
    def __init__(self, status: int, data: dict[str, object] | None = None) -> None:
        self.status = status
        self._data = data or {}

    async def __aenter__(self) -> _FakeResponse:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        pass

    async def json(self) -> dict[str, object]:
        return self._data

    def raise_for_status(self) -> None:
        if self.status >= 400:
            request_info = aiohttp.RequestInfo(
                url="https://api.github.com/test",
                method="GET",
                headers={},
                real_url="https://api.github.com/test",
            )
            raise aiohttp.ClientResponseError(
                request_info=request_info,
                history=(),
                status=self.status,
            )


class _FakeClientSession:
    def __init__(self, response: _FakeResponse | Exception) -> None:
        self._response = response
        self.last_headers: dict[str, str] = {}

    def __call__(self, *args: object, **kwargs: object) -> _FakeClientSession:
        return self

    async def __aenter__(self) -> _FakeClientSession:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        pass

    def get(self, url: str, headers: dict[str, str] | None = None) -> _FakeResponse:
        self.last_headers = headers or {}
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


async def test_load_issue_success(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_data = {
        "title": "Fix websocket reconnection bug",
        "body": "Reconnection drops messages when cursor is missing.",
    }
    fake_session = _FakeClientSession(_FakeResponse(200, fake_data))
    monkeypatch.setattr(aiohttp, "ClientSession", fake_session)

    issue = await load_issue("https://github.com/owner/repo/issues/10", github_token="fake-token")
    assert issue.source == "owner/repo#10"
    assert "Repository: owner/repo" in issue.text
    assert "Issue #10: Fix websocket reconnection bug" in issue.text
    assert "Reconnection drops messages when cursor is missing." in issue.text
    assert fake_session.last_headers.get("Authorization") == "Bearer fake-token"


async def test_load_issue_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aiohttp, "ClientSession", _FakeClientSession(_FakeResponse(404)))

    with pytest.raises(IssueFetchError, match="Issue not found: owner/repo#404"):
        await load_issue("https://github.com/owner/repo/issues/404")


async def test_load_issue_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aiohttp, "ClientSession", _FakeClientSession(_FakeResponse(403)))

    with pytest.raises(IssueFetchError, match="GitHub API rate limit reached"):
        await load_issue("https://github.com/owner/repo/issues/99")


async def test_load_issue_server_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aiohttp, "ClientSession", _FakeClientSession(_FakeResponse(500)))

    with pytest.raises(IssueFetchError, match="GitHub returned HTTP 500"):
        await load_issue("https://github.com/owner/repo/issues/500")


async def test_load_issue_network_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        aiohttp,
        "ClientSession",
        _FakeClientSession(aiohttp.ClientConnectionError("Connection refused")),
    )

    with pytest.raises(IssueFetchError, match="Could not reach GitHub"):
        await load_issue("https://github.com/owner/repo/issues/1")
