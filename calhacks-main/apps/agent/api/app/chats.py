"""Saved chats: each finished Hunter run, kept in MongoDB so it shows up again after a reload and can be deleted.

Database `agent` (like each store's database, named after the app), collection `chats`, one document per chat:
{_id: chat id, owner, title, prompt, status, run, updatedAt}. There are no accounts yet, so `owner` is a random id
each browser makes for itself, and every read and delete is limited to that owner.

Self-check: python -m app.chats (from apps/agent/api)
"""

import os
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field
from pymongo import DESCENDING, AsyncMongoClient
from pymongo.errors import DuplicateKeyError

DB = "agent"
LIMIT = 100  # Chats listed per owner, newest first.
ID = r"^[A-Za-z0-9-]{8,64}$"

_client: AsyncMongoClient | None = None


class Chat(BaseModel):
    """A finished chat as the web app saves it. `run` is the run as the UI last showed it."""
    owner: str = Field(pattern=ID)
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=1000)
    status: Literal["ready", "bought", "stopped"]
    run: dict


def collection():
    """The chats collection. The client connects lazily, so the rest of the API runs without MONGODB_URI."""
    global _client
    if _client is None:
        if not (uri := os.environ.get("MONGODB_URI")):
            raise RuntimeError("MONGODB_URI missing (apps/agent/api/.env locally, a service variable on Railway)")
        _client = AsyncMongoClient(uri, appname="hunter-agent")
    return _client[DB]["chats"]


async def setup() -> None:
    await collection().create_index([("owner", 1), ("updatedAt", DESCENDING)])


async def list_chats(owner: str) -> list[dict]:
    cursor = collection().find({"owner": owner}, {"owner": 0}).sort("updatedAt", DESCENDING).limit(LIMIT)
    return [{"id": doc.pop("_id"), **doc, "updatedAt": doc["updatedAt"].isoformat()} async for doc in cursor]


async def save(chat_id: str, chat: Chat) -> bool:
    """Creates or replaces the chat. False when the id already belongs to another owner."""
    doc = {**chat.model_dump(), "updatedAt": datetime.now(UTC)}
    try:
        # Matching on the owner too means another owner's chat is never replaced: its id fails the insert instead.
        await collection().replace_one({"_id": chat_id, "owner": chat.owner}, doc, upsert=True)
        return True
    except DuplicateKeyError:
        return False


async def delete(chat_id: str, owner: str) -> bool:
    return (await collection().delete_one({"_id": chat_id, "owner": owner})).deleted_count == 1


if __name__ == "__main__":
    import asyncio
    from pathlib import Path
    from uuid import uuid4

    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")

    DB = f"agent_test_{uuid4().hex[:8]}"  # A throwaway database, dropped at the end.

    async def check():
        owner, other, chat_id = uuid4().hex, uuid4().hex, uuid4().hex
        try:
            chat = Chat(owner=owner, title="Fleece Jacket", prompt="a fleece", status="ready", run={"stage": 5})
            assert await save(chat_id, chat)
            assert await save(chat_id, chat.model_copy(update={"status": "bought"}))
            assert not await save(chat_id, chat.model_copy(update={"owner": other}))  # Not theirs to overwrite.
            [saved] = await list_chats(owner)
            assert (saved["id"], saved["status"], saved["run"]) == (chat_id, "bought", {"stage": 5}), saved
            assert await list_chats(other) == []
            assert not await delete(chat_id, other) and await delete(chat_id, owner)
            assert await list_chats(owner) == []
        finally:
            await _client.drop_database(DB)
        print("ok")

    asyncio.run(check())
