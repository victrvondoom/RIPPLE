"""Schema 1: `Listing`, one item for sale in one store. Shared by real listings, synthetic listings and the Gate.

Every field feeds a Gate check; everything else (photos, badges, ratings, url, fetched_at) is left out.
Debug info lives in `ListingMeta`, a separate record.
"""
from typing import Annotated, Literal

from pydantic import Field

from calhacks_contracts._base import Address, BaseUnits, Strict

Condition = Literal["new", "like_new", "used", "poor"]


class Seller(Strict):
    id: str = Field(description="Seller account; known-seller list lookup")
    domain: str = Field(description="Site that runs the checkout; lookalike-domain check")
    pay_to: Address = Field(description="Wallet in store.json; must match checkout.pay_to")


class Item(Strict):
    id: str = Field(description="Store's product id; must match checkout.item_id")
    product_key: str = Field(description="Our normalized product + variant; right product, which median")
    condition: Condition
    price: float = Field(gt=0, description="Total price in USD including shipping")
    text: str = Field(description="Title + description + item specifics, exactly as served (raw)")


class Checkout(Strict):
    """What the 402 actually demands. The Gate fetches it itself with a placeholder shipTo."""
    pay_to: Address
    amount: BaseUnits
    network: str
    asset: Address
    item_id: str
    max_timeout_seconds: int | None = Field(
        default=None, ge=0, description="maxTimeoutSeconds read straight from the 402, when known")


class Listing(Strict):
    listing_id: str = Field(min_length=1)
    seller: Seller
    item: Item
    reviews: Annotated[list[str], Field(max_length=20)] = []
    checkout: Checkout


class ListingMeta(Strict):
    """Debug info for a listing. Never part of the Listing, never seen by the Gate."""
    listing_id: str
    source: str = Field(description="e.g. apify:ebay, apify:depop, synthetic")
    url: str | None = None
    fetched_at: str | None = None
