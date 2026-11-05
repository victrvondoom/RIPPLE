from calhacks_contracts import GateInput

from gatepy.clock import days_since
from gatepy.registry import feature

TOO_LOW = 0.5
TRUST_DAYS = 90.0


def _ratio(x: GateInput) -> float | None:
    m = x.references.market_median
    return x.listing.item.price / m if m else None


def _wallet_track_record(x: GateInput) -> float:
    """1 when the wallet is known to us or old enough to have a history (0 when it is brand new or unseen)."""
    pay_to = x.listing.checkout.pay_to.lower()
    if any(k.pay_to.lower() == pay_to for k in x.references.known_sellers):
        return 1.0
    return 1.0 if days_since(x.references.pay_to_first_seen) >= TRUST_DAYS else 0.0


@feature("price_ratio", monotone=-1)
def price_ratio(x: GateInput) -> float:
    """Price / market median. Neutral 1.0 when there is no median for this product."""
    r = _ratio(x)
    return r if r is not None else 1.0


@feature("price_too_low", monotone=1)
def price_too_low(x: GateInput) -> float:
    r = _ratio(x)
    return 1.0 if r is not None and r < TOO_LOW else 0.0


@feature("has_median")
def has_median(x: GateInput) -> float:
    return 1.0 if x.references.market_median else 0.0


@feature("untrusted_deep_discount", monotone=0)
def untrusted_deep_discount(x: GateInput) -> float:
    """A deep discount is normal when the wallet behind it has a track record and suspect when it does not.
    Zero at or above the TOO_LOW cut, then linear in how far below the cut the price sits."""
    r = _ratio(x)
    if r is None or r >= TOO_LOW:
        return 0.0
    depth = min(1.0, (TOO_LOW - r) / TOO_LOW)
    return depth * (1.0 - _wallet_track_record(x))
