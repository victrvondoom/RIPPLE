"""Standby web server: GET /search streams search events as NDJSON, one JSON object per line.

Apify keeps the container warm and routes https://<user>--store-crawler.apify.actor here, so a
search pays no run startup, and the HTTP client keeps connections to the stores open between searches.
"""

import json
import os
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse

from src.search import origin, search


@asynccontextmanager
async def lifespan(app: FastAPI):
    limits = httpx.Limits(max_connections=100, max_keepalive_connections=100)
    async with httpx.AsyncClient(timeout=30, limits=limits, follow_redirects=True) as client:
        app.state.client = client
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
def ready() -> dict[str, str]:
    """Apify's readiness probe hits / before routing traffic to this container."""
    return {"status": "ok"}


@app.get("/search")
async def search_route(
    stores: str = Query(description="Comma-separated store origins, each serving /.well-known/store.json"),
    q: str = "",
    max: int = Query(0, ge=0, description="Max listings per store, 0 for all"),
    details: bool = True,
    concurrency: int = Query(50, ge=1, le=100),
) -> StreamingResponse:
    origins = [origin(s) for s in stores.split(",") if s.strip()]

    async def lines():
        async for event in search(app.state.client, origins, q, max, details, concurrency):
            yield json.dumps(event) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ACTOR_WEB_SERVER_PORT", 4321)))
