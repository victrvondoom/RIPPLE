"""Schema 3 output: `SyntheticListing` = listing + answer key + generator info.

Only `listing` ever reaches the Gate. `answer_key` and `gen` are stored in separate collections/files.
"""
from pydantic import Field

from calhacks_contracts._base import AttackerKnowledge, Label, Strict
from calhacks_contracts.listing import Listing


class AnswerKey(Strict):
    listing_id: str
    label: Label = Field(description="Set by code, never by the LLM")
    family: str = Field(description="Scam type or legit subtype from families.json; 'real' for real listings")
    base_listing_id: str | None = Field(default=None, description="The real listing it came from")
    attack_diff: dict[str, str] = Field(
        default_factory=dict, description='Exactly what changed, e.g. {"checkout.pay_to": "0x45fE…c862 → 0x45fE…c8a2"}')
    attacker_knowledge: AttackerKnowledge | None = None


class GenInfo(Strict):
    listing_id: str
    model: str | None = Field(description="Bitdeer model, or null when only code changed the listing")
    temperature: float | None = None
    prompt_version: str | None = None
    spec_id: str


class SyntheticListing(Strict):
    listing: Listing
    answer_key: AnswerKey
    gen: GenInfo
