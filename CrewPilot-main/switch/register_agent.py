"""Register CrewPilot as a custom always-on agent on a Switch server.

Usage:
    python -m switch.register_agent --name crewpilot --description "..."

The registration token belongs to a Switch user and becomes the agent's owner.
It is not the agent API key. The API key returned here is shown once by the
server, so this command saves it to .switch/agent.json for the runtime.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys

import aiohttp
from dotenv import load_dotenv

from switch.credentials import load_saved_credentials, save_credentials

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
DEFAULT_DESCRIPTION = (
    "Triages GitHub issues or pasted bug reports into a category, severity, "
    "difficulty, and an actionable fix plan, then records human approval."
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m switch.register_agent",
        description="Register CrewPilot as an always-on custom agent on Switch.",
    )
    parser.add_argument("--name", help="Agent identifier (lowercase, e.g. crewpilot)")
    parser.add_argument("--description", help="What the agent does, shown in Switch")
    parser.add_argument("--api-url", help="Switch bridge base URL, e.g. http://localhost:8000")
    parser.add_argument(
        "--token",
        help="Switch registration token (default: SWITCH_REGISTRATION_TOKEN)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing agent with the same name and issue a new API key",
    )
    return parser


async def _register(args: argparse.Namespace) -> int:
    saved = load_saved_credentials()
    name = (args.name or os.getenv("SWITCH_AGENT_NAME") or saved.get("agent_name") or "crewpilot").strip()
    description = (
        args.description
        or os.getenv("SWITCH_AGENT_DESCRIPTION")
        or DEFAULT_DESCRIPTION
    ).strip()
    api_url = (
        args.api_url
        or os.getenv("SWITCH_API_URL")
        or saved.get("api_url")
        or "http://localhost:8000"
    ).strip().rstrip("/")
    token = (args.token or os.getenv("SWITCH_REGISTRATION_TOKEN") or "").strip()

    if not NAME_RE.fullmatch(name):
        print(
            "Invalid agent name. Use lowercase letters, digits, '.', '_' or '-', "
            "starting with a letter or digit.",
            file=sys.stderr,
        )
        return 2
    if not description:
        print("A non-empty --description is required.", file=sys.stderr)
        return 2
    if not (api_url.startswith("http://") or api_url.startswith("https://")):
        print("--api-url must start with http:// or https://.", file=sys.stderr)
        return 2
    if not token:
        print(
            "A registration token is required. Set SWITCH_REGISTRATION_TOKEN in .env "
            "or pass --token.",
            file=sys.stderr,
        )
        return 2

    payload = {
        "name": name,
        "description": description,
        "connector_type": "custom",
        "overwrite": bool(args.overwrite),
        "integration_profile": {
            "connection_model": "always_on",
            "message_exchange": True,
            "pre_invocation_mediation": [],
            "post_invocation_mediation": [],
            "event_reporting": [],
        },
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    timeout = aiohttp.ClientTimeout(total=30)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{api_url}/agents", json=payload, headers=headers
            ) as response:
                text = await response.text()
                status = response.status
    except aiohttp.ClientError as exc:
        print(f"Could not reach Switch at {api_url}: {exc}", file=sys.stderr)
        return 1

    if status in {401, 403}:
        print(
            "Switch rejected the registration token. Check SWITCH_REGISTRATION_TOKEN.",
            file=sys.stderr,
        )
        return 1
    if status == 409:
        print(
            f"An agent named '{name}' already exists on this server. "
            "Use --overwrite to replace it (this issues a new API key).",
            file=sys.stderr,
        )
        return 1
    if status == 404:
        print(
            f"Switch returned 404. Is {api_url} the agent bridge/API URL "
            "(not the Gateway UI URL)?",
            file=sys.stderr,
        )
        return 1
    if status >= 400:
        print(f"Registration failed (HTTP {status}): {text[:500]}", file=sys.stderr)
        return 1

    try:
        body = json.loads(text)
        agent_id = body["id"]
        api_key = body["api_key"]
    except (json.JSONDecodeError, KeyError, TypeError):
        print(f"Unexpected registration response: {text[:500]}", file=sys.stderr)
        return 1

    path = save_credentials(
        {
            "api_url": api_url,
            "agent_id": agent_id,
            "api_key": api_key,
            "agent_name": name,
        }
    )

    print(f"Registered Switch agent '{name}' (id: {agent_id}).")
    print(f"API credentials saved to {path}.")
    print("The API key is not printed here; it is stored once by Switch.")
    print()
    print("Next steps:")
    print("  1. Make sure the Discord channel is already a Switch room.")
    print(f"  2. Invite the agent: !invite-agent @{name}")
    print("  3. Start the agent: python main.py")
    return 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    args = _parser().parse_args(argv)
    try:
        return asyncio.run(_register(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
