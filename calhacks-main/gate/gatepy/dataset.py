"""Load labeled examples from MongoDB and turn them into GateInputs and feature matrices.

The Gate itself only ever sees GateInputs (listing + mandate + references). Answer keys are carried alongside for
labels and scoring and never reach a feature.
"""
import hashlib
from dataclasses import dataclass

import numpy as np
from calhacks_contracts import AnswerKey, Case, GateInput, Listing, Mandate
from calhacks_contracts.db import ReferenceSet, Repo
from calhacks_contracts.families import holdout_families

from gatepy.registry import Feature, compute
from gatepy.splits import split_of

DEFAULT_MAX_PRICE_FACTOR = 1.25
DEFAULT_SPEND = 1000.0


class GateInputError(ValueError):
    """Bad input: the CLIs exit 2 with {"error": ...}."""


@dataclass(frozen=True)
class Example:
    listing: Listing
    case: Case
    key: AnswerKey

    @property
    def id(self) -> str:
        return self.listing.listing_id

    @property
    def split(self) -> str:
        """train / calibrate / val, by group: every copy of one base listing lands on the same side."""
        return split_of(self.id, self.key.base_listing_id)


def default_case(listing: Listing) -> Case:
    """Mandate for a listing that has no stored case: its own product, 25% headroom, a large budget."""
    return Case(listing_id=listing.listing_id, mandate=Mandate(
        product_key=listing.item.product_key, max_price=round(listing.item.price * DEFAULT_MAX_PRICE_FACTOR, 2),
        spend_remaining=DEFAULT_SPEND))


def from_items(items) -> list[Example]:
    """(Listing, Case | None, AnswerKey) tuples, e.g. decrypted holdout rows, to Examples."""
    return [Example(l, c or default_case(l), k) for l, c, k in items]


def load_examples(repo: Repo, query: dict | None = None, include_holdout: bool = False) -> list[Example]:
    """Labeled examples from MongoDB, sorted by listing id. `query` filters the answer_keys collection."""
    keys = list(repo.answer_keys(query or {}))
    leaked = sorted({k.family for k in keys} & holdout_families())
    if leaked and not include_holdout:
        raise GateInputError(f"database rows contain holdout families {leaked}; holdout must not live in MongoDB")
    ids = [k.listing_id for k in keys]
    listings = {l.listing_id: l for l in repo.listings(ids)}
    cases = repo.cases(ids)
    out = [Example(listings[k.listing_id], cases.get(k.listing_id) or default_case(listings[k.listing_id]), k)
           for k in keys if k.listing_id in listings]
    return sorted(out, key=lambda e: e.id)


def to_inputs(examples: list[Example], refs: ReferenceSet) -> list[GateInput]:
    return [GateInput(mandate=e.case.mandate, listing=e.listing, references=refs.for_listing(e.listing))
            for e in examples]


def data_hash(examples: list[Example]) -> str:
    h = hashlib.sha256()
    for e in sorted(examples, key=lambda e: e.id):
        h.update(e.listing.model_dump_json().encode("utf-8"))
        h.update(e.case.model_dump_json().encode("utf-8"))
        h.update(e.key.label.encode())
    return h.hexdigest()


def featurize(inputs: list[GateInput], feats: list[Feature]) -> np.ndarray:
    if not inputs:
        return np.zeros((0, len(feats)))
    return np.array([compute(x, feats) for x in inputs], dtype=np.float64)
