"""Purchase-time scoring: score(GateRequest) -> GateDecision, and a FastAPI router (POST /gate/risk).

The Gate never trusts the Scout's copy of a listing. It fetches the listing by `proposal.listing_id` itself
(`fetch`), and looks up references itself (`refs`) when it has a reference source; only without one does it fall
back to the request's `references`. The wallet must treat any error or non-200 response as "skip" (fail closed).
"""
import sys
from collections.abc import Callable
from pathlib import Path

from calhacks_contracts import GateDecision, GateInput, GateRequest, Listing
from calhacks_contracts.db import ReferenceSet, Repo, get_db

from gatepy import MODELS
from gatepy.evaluate import decide
from gatepy.model_io import Model, load
from gatepy.registry import discover, feature_code_hash

Fetch = Callable[[str], Listing | None]


class ListingNotFound(LookupError):
    pass


class Gate:
    def __init__(self, model_id: str = "promoted", models_dir: Path = MODELS, repo: Repo | None = None,
                 fetch: Fetch | None = None, refs: ReferenceSet | None = None, use_db_refs: bool = True):
        discover()
        self.model: Model = load(model_id, models_dir)
        if self.model.meta.get("feature_code_hash") != feature_code_hash():
            print(f"warning: gate/features changed since {self.model.model_id} was trained; "
                  f"run model_io.restore_features() to match", file=sys.stderr)
        if fetch is None or (refs is None and use_db_refs):
            repo = repo or Repo(get_db())
        self.repo = repo
        self.fetch: Fetch = fetch or repo.get_listing
        self.refs = refs if refs is not None else (repo.reference_snapshot() if use_db_refs else None)

    def refresh(self) -> None:
        """Reload the reference snapshot (known sellers, medians, wallets) from MongoDB."""
        if self.repo is not None:
            self.refs = self.repo.reference_snapshot()

    def resolve(self, request: GateRequest) -> GateInput:
        listing = self.fetch(request.proposal.listing_id)
        if listing is None:
            raise ListingNotFound(f"listing {request.proposal.listing_id!r} not found")
        refs = self.refs.for_listing(listing) if self.refs is not None else request.references
        return GateInput(mandate=request.mandate, listing=listing, references=refs)

    def score(self, request: GateRequest | dict) -> GateDecision:
        req = request if isinstance(request, GateRequest) else GateRequest.model_validate(request)
        return decide(self.model, [self.resolve(req)])[0]


_GATES: dict[str, Gate] = {}


def score(request: GateRequest | dict, model_id: str = "promoted") -> GateDecision:
    if model_id not in _GATES:
        _GATES[model_id] = Gate(model_id)
    return _GATES[model_id].score(request)


def make_router(gate: Gate | None = None):
    """FastAPI router for the wallet. Needs the `serve` extra (fastapi)."""
    from fastapi import APIRouter
    from fastapi.responses import JSONResponse

    router = APIRouter()

    @router.post("/gate/risk")
    def risk(request: dict):
        try:
            g = gate
            if g is None:
                g = _GATES.setdefault("promoted", Gate("promoted"))
            return g.score(request).model_dump(mode="json")
        except Exception as e:  # noqa: BLE001 - fail closed on anything
            return JSONResponse(status_code=503, content={
                "decision": "skip", "decided_by": None, "error": f"{type(e).__name__}: {e}"})

    return router
