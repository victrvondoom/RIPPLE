"""Triage workflow running as a native agent inside Switch rooms.

Chat text arrives from Switch over SSE; results are posted back with Switch
operations. Switch's Discord bridge mirrors both directions to the channel, so
this module never talks to Discord directly.

The human approval step is a message: mention the agent and reply `approve`,
or mention it with `changes <feedback>`. Approvals live in memory and are
recorded in the room; this MVP does not write labels back to GitHub.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from agent.triage_agent import TriageAgent, TriageError, TriageResult
from github_issues import GITHUB_ISSUE_RE, IssueFetchError, load_issue
from switch.agent_client import SwitchAgentClient, SwitchAuthError, SwitchError

logger = logging.getLogger(__name__)

MAX_MESSAGE_CHARS = 1_900
MAX_SEEN_MESSAGES = 500
MAX_SUMMARY_CHARS = 500
MAX_STEP_CHARS = 240
MAX_ERROR_CHARS = 400

APPROVE_RE = re.compile(
    r"^(?:please\s+)?(?:approve|approved|lgtm|looks good|ship it)(?:\s+plan)?[.!]*$",
    re.IGNORECASE,
)
CHANGES_RE = re.compile(
    r"^(?:please\s+)?"
    r"(?:changes?|request(?:ed)? changes|needs changes|reject(?:ed)?|decline|deny)"
    r"\b[:,;\s-]*(.*)$",
    re.IGNORECASE | re.DOTALL,
)
HELP_RE = re.compile(r"^/?(?:help|usage|commands)[.!]?$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class PendingTriage:
    requester_id: str
    requester_name: str
    source: str
    summary: str
    request_key: str


class SwitchTriageConnector:
    """Routes addressed Switch messages through the triage agent and back."""

    def __init__(
        self,
        *,
        client: SwitchAgentClient,
        triage_agent: TriageAgent,
        agent_name: str,
        github_token: str | None = None,
    ) -> None:
        self._client = client
        self._agent = triage_agent
        self.agent_name = agent_name
        self._github_token = github_token
        self._pending: dict[tuple[str, str | None], PendingTriage] = {}
        self._seen_messages: OrderedDict[str, None] = OrderedDict()

    async def handle_event(self, event: dict[str, Any]) -> None:
        """Handle one Switch event. Only addressed messages do work."""
        if event.get("type") != "message":
            return

        payload = event.get("payload")
        if not isinstance(payload, dict) or payload.get("addressed") is False:
            return

        room_id = str(event.get("room_id") or "")
        body = str(payload.get("body") or "").strip()
        if not room_id or not body:
            return

        sender_name = str(payload.get("sender_name") or "there").strip() or "there"
        if sender_name.casefold() == self.agent_name.casefold():
            return  # Never react to our own posts.

        message_id = str(payload.get("message_id") or "")
        if message_id:
            if message_id in self._seen_messages:
                logger.debug("Ignoring duplicate Switch message %s", message_id)
                return
            self._seen_messages[message_id] = None
            if len(self._seen_messages) > MAX_SEEN_MESSAGES:
                self._seen_messages.popitem(last=False)

        raw_thread = payload.get("thread_id")
        thread_id = str(raw_thread) if raw_thread else None
        sender_id = str(payload.get("sender") or sender_name)
        normalized = self._normalize(body)

        if HELP_RE.fullmatch(normalized):
            await self._send(room_id, self._help_text(), thread_id)
            return

        pending_key, pending = self._find_pending(room_id, thread_id)
        if pending is not None:
            decision = self._parse_decision(normalized)
            if decision is not None:
                await self._handle_decision(
                    room_id=room_id,
                    thread_id=thread_id,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    pending_key=pending_key,
                    pending=pending,
                    decision=decision,
                )
                return
        elif self._parse_decision(normalized) is not None:
            await self._send(
                room_id,
                "There is no triage waiting for approval here. "
                "Mention me with an issue first.",
                thread_id,
            )
            return

        issue_text = self._issue_text(body)
        if not issue_text:
            await self._send(room_id, self._help_text(), thread_id)
            return

        # Require an explicit intent so ordinary conversation does not invoke
        # the LLM: a GitHub issue URL, or the word "triage".
        if (
            GITHUB_ISSUE_RE.search(body) is None
            and re.search(r"\btriage\b", normalized, re.IGNORECASE) is None
        ):
            await self._send(room_id, self._help_text(), thread_id)
            return

        request_key = self._request_key(issue_text)
        duplicate = self._find_pending_for_request(room_id, request_key)
        if duplicate is not None:
            await self._send(
                room_id,
                f"This issue is already awaiting a decision ({duplicate.source}). "
                "Approve the existing plan or request changes first.",
                thread_id,
            )
            return

        await self._triage(
            room_id=room_id,
            thread_id=thread_id,
            sender_id=sender_id,
            sender_name=sender_name,
            issue_text=issue_text,
            request_key=request_key,
        )

    async def _triage(
        self,
        *,
        room_id: str,
        thread_id: str | None,
        sender_id: str,
        sender_name: str,
        issue_text: str,
        request_key: str,
    ) -> None:
        logger.info("Triaging issue from %s in room %s", sender_name, room_id)
        await self._send(
            room_id,
            "Triaging... I'll post the plan in a few seconds.",
            thread_id,
        )

        try:
            issue = await load_issue(issue_text, self._github_token)
            result = await asyncio.to_thread(self._agent.triage, issue.text)
        except (IssueFetchError, TriageError) as exc:
            logger.warning("Triage failed: %s", exc)
            await self._send(
                room_id,
                f"Triage failed: {_clip(str(exc), MAX_ERROR_CHARS)}",
                thread_id,
            )
            return
        except Exception:
            logger.exception("Unexpected triage failure in room %s", room_id)
            await self._send(
                room_id,
                "Triage failed unexpectedly. Check the agent logs.",
                thread_id,
            )
            return

        try:
            await self._client.post_message(
                room_id,
                self._format_triage(result, issue.source),
                thread_id,
            )
        except SwitchAuthError:
            raise
        except SwitchError as exc:
            logger.error("Could not post triage result: %s", exc)
            return

        self._pending[(room_id, thread_id)] = PendingTriage(
            requester_id=sender_id,
            requester_name=sender_name,
            source=issue.source,
            summary=result.summary,
            request_key=request_key,
        )
        logger.info(
            "Posted triage for %s (category=%s severity=%s difficulty=%s)",
            issue.source,
            result.category,
            result.severity,
            result.difficulty,
        )

    async def _handle_decision(
        self,
        *,
        room_id: str,
        thread_id: str | None,
        sender_id: str,
        sender_name: str,
        pending_key: tuple[str, str | None] | None,
        pending: PendingTriage,
        decision: tuple[str, str],
    ) -> None:
        if sender_id != pending.requester_id:
            await self._send(
                room_id,
                f"Only {pending.requester_name} can approve this triage.",
                thread_id,
            )
            return

        verdict, feedback = decision
        if verdict == "approve":
            message = (
                f"Approved by {sender_name}. {pending.source}: "
                f"{_clip(pending.summary, 300)}\n\n"
                "Approval recorded in the room. No GitHub changes were made."
            )
        else:
            message = (
                f"Changes requested by {sender_name} for {pending.source}.\n"
                f"Feedback: {_clip(feedback or 'No feedback supplied.', MAX_ERROR_CHARS)}"
            )

        if await self._send(room_id, message, thread_id) and pending_key is not None:
            self._pending.pop(pending_key, None)
            logger.info(
                "Triage %s for %s by %s",
                "approved" if verdict == "approve" else "returned for changes",
                pending.source,
                sender_name,
            )

    def _find_pending(
        self, room_id: str, thread_id: str | None
    ) -> tuple[tuple[str, str | None] | None, PendingTriage | None]:
        exact = (room_id, thread_id)
        if exact in self._pending:
            return exact, self._pending[exact]
        # A decision may arrive in a thread (or top level) different from where
        # the plan was posted; fall back to the room's most recent triage.
        for key in reversed(self._pending):
            if key[0] == room_id:
                return key, self._pending[key]
        return None, None

    def _find_pending_for_request(
        self, room_id: str, request_key: str
    ) -> PendingTriage | None:
        for pending_key, pending in reversed(self._pending.items()):
            if pending_key[0] == room_id and pending.request_key == request_key:
                return pending
        return None

    @staticmethod
    def _request_key(issue_text: str) -> str:
        match = GITHUB_ISSUE_RE.search(issue_text)
        if match:
            owner, repo, number = match.groups()
            return f"github:{owner.lower()}/{repo.lower()}#{number}"
        normalized = re.sub(r"\s+", " ", issue_text).strip().lower()
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
        return f"text:{digest}"

    @staticmethod
    def _normalize(body: str) -> str:
        without_mentions = re.sub(r"@\S+", " ", body)
        return re.sub(r"\s+", " ", without_mentions).strip()

    def _issue_text(self, body: str) -> str:
        text = re.sub(
            rf"@{re.escape(self.agent_name)}\b", " ", body, flags=re.IGNORECASE
        )
        text = re.sub(r"^\s*@\S+\s+", "", text).strip()
        text = re.sub(r"^triage\b[:\s]*", "", text, flags=re.IGNORECASE).strip()
        return text

    @staticmethod
    def _parse_decision(normalized: str) -> tuple[str, str] | None:
        if APPROVE_RE.fullmatch(normalized):
            return "approve", ""
        changes = CHANGES_RE.match(normalized)
        if changes:
            return "changes", changes.group(1).strip()
        return None

    def _format_triage(self, result: TriageResult, source: str) -> str:
        header = (
            "**Issue triage**\n"
            f"Source: {_clip(source, 120)}\n"
            f"Category: {result.category.title()} | "
            f"Severity: {result.severity.title()} | "
            f"Difficulty: {result.difficulty.title()}\n\n"
            "**Summary**\n"
            f"{_clip(result.summary, MAX_SUMMARY_CHARS)}\n\n"
            "**Suggested fix plan**\n"
        )
        footer = (
            "\n\nTo decide, mention me and reply `approve` "
            "or `changes <feedback>`."
        )
        budget = MAX_MESSAGE_CHARS - len(header) - len(footer)

        lines: list[str] = []
        for index, step in enumerate(result.suggested_fix_plan, start=1):
            line = f"{index}. {_clip(step, MAX_STEP_CHARS)}"
            if len("\n".join([*lines, line])) > budget:
                break
            lines.append(line)

        if len(lines) < len(result.suggested_fix_plan):
            lines.append("(remaining steps omitted for length)")
        if not lines:
            lines.append("See the issue for details.")

        return header + "\n".join(lines) + footer

    def _help_text(self) -> str:
        return (
            "**CrewPilot Auto-Triager**\n"
            "Mention me with:\n"
            "`triage <GitHub issue URL or description>`\n"
            "`approve` to accept the latest plan\n"
            "`changes <feedback>` to request revisions\n"
            "`help` to show this message"
        )

    async def _send(self, room_id: str, body: str, thread_id: str | None) -> bool:
        try:
            await self._client.post_message(
                room_id, _clip(body, MAX_MESSAGE_CHARS), thread_id
            )
            return True
        except SwitchAuthError:
            raise
        except SwitchError:
            logger.exception("Could not post to Switch room %s", room_id)
            return False


def _clip(text: str, limit: int) -> str:
    cleaned = str(text).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."
