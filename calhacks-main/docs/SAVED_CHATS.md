# Saved chats

[← Back to the README](../README.md)

Finished chats are saved in MongoDB (`app/chats.py`): database `agent`, collection `chats`, one document per chat
(`_id`, `owner`, `title`, `prompt`, `status`, `run`, `updatedAt`), indexed on `owner` and `updatedAt`.

- There are no accounts yet, so each browser makes a random owner id (`hunter-owner` in localStorage,
  `apps/agent/web/lib/chats.ts`) and the API only lists, saves and deletes that owner's chats.
- `GET /chats?owner=` lists them, newest first (up to 100). `PUT /chats/{id}` saves a chat when its run finishes
  (`run` is the run as the UI last showed it, so it reopens exactly as it ended); a chat id that belongs to another
  owner is refused with 403. `DELETE /chats/{id}?owner=` deletes one (404 when it isn't theirs).
- Only finished chats are saved, so reloading the page never starts a purchase again.
- In the sidebar, a delete button appears on a chat when you hover it (always shown on touch screens). Deleting the
  open chat goes back to New Chat, and a failed delete puts the chat back.
- Self-check: `uv run python -m app.chats` (from `apps/agent/api`, uses a throwaway database).
