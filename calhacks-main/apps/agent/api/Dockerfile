# Built from the repo root, since the API depends on contracts/ (see railway.json).
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /repo
COPY contracts contracts
COPY apps/agent/api/pyproject.toml apps/agent/api/uv.lock apps/agent/api/.python-version apps/agent/api/
WORKDIR /repo/apps/agent/api
RUN uv sync --frozen --no-dev

COPY apps/agent/api/app app

CMD ["sh", "-c", "uv run --no-sync fastapi run app/main.py --port ${PORT:-8000}"]
