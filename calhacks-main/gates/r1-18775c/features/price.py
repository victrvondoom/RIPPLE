from calhacks_contracts import GateInput

from gatepy.registry import feature

TOO_LOW = 0.5


def _ratio(x: GateInput) -> float | None:
    m = x.references.market_median
    return x.listing.item.price / m if m else None


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
