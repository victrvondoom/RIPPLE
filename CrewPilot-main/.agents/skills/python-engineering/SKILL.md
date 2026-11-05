---
name: python-engineering
description: Designs and changes maintainable Python services using typing, async I/O, dependency injection, safe configuration, logging and focused modules. Use for all CrewPilot Python implementation and refactoring.
---
# Python Engineering

## Workflow
1. Inspect neighboring modules, public interfaces, dependencies and supported Python version before editing.
2. Preserve the current architecture unless a measured defect requires change. Prefer small, typed modules and explicit dependency injection at external boundaries.
3. Keep network and file I/O asynchronous where the surrounding code is async. Move blocking SDK calls off the event loop deliberately and test cancellation/timeouts.
4. Validate configuration once at startup. Keep secrets out of dataclass reprs, exceptions, logs and serialized task records.
5. Use structured exceptions and actionable error messages; do not swallow cancellation or authentication failures.
6. Add docstrings for public interfaces and type hints for function inputs/outputs. Avoid `Any` except at untrusted JSON/API boundaries, then validate immediately.
7. Close HTTP clients, subprocesses and temporary workspaces deterministically.

## CrewPilot conventions
- Use Python 3.12.x unless the repository audit or dependency compatibility proves otherwise.
- Match existing naming, import, formatting and logging conventions.
- Keep Switch transport, workflow logic, persistence, agent roles and GitHub operations separated.
- Use injected clients in tests; do not require real credentials for unit tests.
- Never refactor unrelated modules as part of a narrow feature.

## Avoid
- Blocking network calls in async handlers.
- Global mutable task state.
- `shell=True` or interpolating model output into shell commands.
- Catch-all exception handlers that hide cancellation or auth errors.
- Printing secrets or full sensitive payloads.

## Verification
Run focused tests, full `python -m pytest -q`, `python -m ruff check .`, `python -m ruff format --check .`, `python -m compileall -q .` and `git diff --check` as applicable. Report exact commands and outcomes.
