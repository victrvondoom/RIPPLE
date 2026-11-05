"""GateInputs built from contracts/tests/fixtures (fictional, test-only) for the feature self-test.

These never enter MongoDB; they only exercise every feature before training.
"""
import json
from functools import cache

from calhacks_contracts import Case, GateInput, KnownSeller, Listing, SyntheticListing
from calhacks_contracts.db import ReferenceSet

from gatepy import CONTRACTS

FIXTURES = CONTRACTS / "tests" / "fixtures"


def _read(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@cache
def fixture_refs() -> ReferenceSet:
    r = _read("references.json")
    return ReferenceSet(
        known_sellers=[KnownSeller.model_validate(k) for k in r["known_sellers"]],
        medians={(m["product_key"], m["condition"]): m["median"] for m in r["market_medians"]},
        wallets={},
    )


def fixture_inputs() -> list[GateInput]:
    refs = fixture_refs()
    out = []
    for row in _read("real_listings.json"):
        l = Listing.model_validate(row["listing"])
        out.append(GateInput(mandate=row["mandate"], listing=l, references=refs.for_listing(l)))
    for row in _read("synthetic.json"):
        s = SyntheticListing.model_validate(row["synthetic"])
        c = Case.model_validate(row["case"])
        out.append(GateInput(mandate=c.mandate, listing=s.listing, references=refs.for_listing(s.listing)))
    return out
