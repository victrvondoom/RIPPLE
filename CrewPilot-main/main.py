"""Entrypoint for CrewPilot running as a native Switch agent.

Wiring:
    Settings -> TriageAgent
             -> SwitchAgentClient (SSE + HTTP operations)
             -> SwitchTriageConnector (room workflow)

Run with: python main.py
"""

from __future__ import annotations

import asyncio
import logging

from agent.triage_agent import TriageAgent
from config import ConfigError, Settings
from switch.agent_client import SwitchAgentClient, SwitchAuthError
from switch.switch_connector import SwitchTriageConnector

logger = logging.getLogger("crewpilot")


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


async def run() -> None:
    try:
        settings = Settings.from_env()
    except ConfigError as exc:
        raise SystemExit(f"Configuration error: {exc}") from exc

    configure_logging(settings.log_level)

    triage_agent = TriageAgent.from_settings(settings)
    client = SwitchAgentClient(
        api_url=settings.switch_api_url,
        agent_id=settings.switch_agent_id,
        api_key=settings.switch_api_key,
        agent_name=settings.switch_agent_name,
    )
    connector = SwitchTriageConnector(
        client=client,
        triage_agent=triage_agent,
        agent_name=settings.switch_agent_name,
        github_token=settings.github_token,
    )

    logger.info(
        "Starting CrewPilot as Switch agent '%s' at %s",
        settings.switch_agent_name,
        settings.switch_api_url,
    )
    try:
        await client.run(connector.handle_event)
    except SwitchAuthError as exc:
        raise SystemExit(f"Switch authentication failed: {exc}") from exc


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
