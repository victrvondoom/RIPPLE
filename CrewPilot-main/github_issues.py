"""Resolve a GitHub issue URL into plain text for the triage agent."""

from __future__ import annotations

import re
from dataclasses import dataclass

import aiohttp

GITHUB_ISSUE_RE = re.compile(
    r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\d+)"
)
MAX_ISSUE_CHARS = 8_000


class IssueFetchError(RuntimeError):
    """Raised when a referenced GitHub issue cannot be fetched."""


@dataclass(frozen=True)
class IssueInput:
    text: str
    source: str


async def load_issue(raw_input: str, github_token: str | None = None) -> IssueInput:
    """Return issue text from a GitHub URL, or pass raw message text through."""
    text = raw_input.strip()
    match = GITHUB_ISSUE_RE.search(text)
    if not match:
        return IssueInput(text=text[:MAX_ISSUE_CHARS], source="message text")

    owner, repo, number = match.groups()
    api_url = f"https://api.github.com/repos/{owner}/{repo}/issues/{number}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "CrewPilot-AutoTriager",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(api_url, headers=headers) as response:
                if response.status == 404:
                    raise IssueFetchError(
                        f"Issue not found: {owner}/{repo}#{number}. "
                        "Check the URL or set GITHUB_TOKEN for private repos."
                    )
                if response.status == 403:
                    raise IssueFetchError(
                        "GitHub API rate limit reached. Set GITHUB_TOKEN in .env and retry."
                    )
                response.raise_for_status()
                data = await response.json()
    except aiohttp.ClientResponseError as exc:
        raise IssueFetchError(f"GitHub returned HTTP {exc.status} for this issue.") from exc
    except aiohttp.ClientError as exc:
        raise IssueFetchError(f"Could not reach GitHub: {exc}") from exc

    title = data.get("title") or "(untitled issue)"
    body = (data.get("body") or "(no description provided)").strip()
    issue_text = f"Repository: {owner}/{repo}\nIssue #{number}: {title}\n\n{body}"

    return IssueInput(
        text=issue_text[:MAX_ISSUE_CHARS],
        source=f"{owner}/{repo}#{number}",
    )
