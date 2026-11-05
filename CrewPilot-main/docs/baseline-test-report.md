# CrewPilot Baseline Test & Verification Report

**Date:** 2026-11-01
**Phase:** Pre-Hackathon Preparation Baseline
**Target Repository:** `vincenzo-afk/CrewPilot`
**Git Branch:** `prep/hackathon-readiness`

---

## 1. Environment & Runtime Specifications

- **Operating System:** Windows 11 (AMD64)
- **Python Version:** 3.12.7 (`py -3.12`)
- **Virtual Environment:** Clean local `.venv` (created via `python -m venv .venv`)

### Pinned Dependencies Installed in `.venv`:

| Package | Version | Purpose |
| :--- | :--- | :--- |
| `aiohttp` | `3.14.5` | SSE client and HTTP operations |
| `openai` | `2.54.0` | OpenAI & Groq LLM completions |
| `anthropic` | `0.125.0` | Anthropic LLM completions |
| `python-dotenv` | `1.2.4` | Environment variable management |
| `pytest` | `9.2.0` | Test framework |
| `pytest-asyncio`| `1.4.1` | Async test fixtures & runner |
| `ruff` | `0.17.3` | Linter and code formatter |

---

## 2. Verification Gate Commands & Results

All 5 release gate checks were executed directly in the project `.venv` without global plugin interference:

```bash
# 1. Bytecode compilation
.\.venv\Scripts\python -m compileall -q .
# Result: PASS (exit code 0)

# 2. Ruff linter
.\.venv\Scripts\python -m ruff check .
# Result: PASS (exit code 0 - All checks passed!)

# 3. Ruff format validation
.\.venv\Scripts\python -m ruff format --check .
# Result: PASS (exit code 0 - 25 files formatted / unchanged)

# 4. Pytest test suite
.\.venv\Scripts\python -m pytest -q
# Result: PASS (exit code 0 - 44 passed in 0.38s)

# 5. Git diff whitespace check
git diff --check
# Result: PASS (exit code 0 - clean whitespace)
```

---

## 3. Test Suite Breakdown (44 Tests, 100% Pass)

| Test Module | Test Count | Scope & Covered Behaviors |
| :--- | :--- | :--- |
| [`tests/test_config.py`](file:///tests/test_config.py) | 8 | Valid env configuration parsing; secret repr masking; missing required keys for providers (OpenAI, Anthropic, Groq); invalid URL schemes and provider validation. |
| [`tests/test_github_issues.py`](file:///tests/test_github_issues.py) | 7 | GitHub issue URL regex parsing; plain text passthrough; HTTP 404 Not Found handling; HTTP 403 Rate Limit handling; HTTP 500 server error handling; network connection failure handling; issue body formatting. |
| [`tests/test_triage_agent.py`](file:///tests/test_triage_agent.py) | 11 | JSON extraction from plain objects, markdown fences, and surrounding prose; malformed JSON error handling; plan normalization (numbering, bullets, multiline); category/severity/difficulty fallback picking; `TriageResult` schema validation; empty issue rejection. |
| [`tests/test_switch_agent_client.py`](file:///tests/test_switch_agent_client.py) | 7 | SSE multiline framing; comment keepalives; `id:` cursor tracking; `connection_state` cursor/heartbeat updating; `gap` warning recovery; `evicted` exception raising; `message` dispatch; `call_operation` request wrapping and envelope unwrapping; auth failure handling. |
| [`tests/test_switch_connector.py`](file:///tests/test_switch_connector.py) | 11 | Non-addressed event filtering; self-message ignore; message deduplication by `message_id`; help command routing; full triage flow; requester-only approval gate; non-requester rejection; duplicate pending triage detection; decision without pending triage warning; documented room-fallback defect. |

---

## 4. Known Defects & P0 Blockers Documented for Hackathon

1. **Approval Room Fallback Vulnerability (Documented in `test_cross_thread_room_fallback_finding_documented`):**
   - In [`switch/switch_connector.py`](file:///switch/switch_connector.py#L278-L283), `_find_pending` falls back to the most recent pending triage in the room if the thread ID does not match.
   - **Impact:** In a multi-task room, an approval in an unknown thread can erroneously bind to an unintended task.
   - **Remediation Plan:** Slated for Milestone 1 (M1) when introducing durable task IDs and exact approval bindings.

2. **In-Memory Volatile Task State:**
   - Pending triages and message deduplication cache live purely in process memory.
   - **Remediation Plan:** Slated for Milestone 1 (M1) when introducing SQLite WAL store.
