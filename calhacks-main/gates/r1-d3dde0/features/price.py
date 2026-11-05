from calhacks_contracts import GateInput

from gatepy.registry import feature

TOO_LOW = 0.5
TOO_LOW_SOFT = 0.8


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


@feature("price_too_low_soft", monotone=1)
def price_too_low_soft(x: GateInput) -> float:
    """A discount deep enough to bait but not deep enough to trip the hard flag (0.5 <= ratio < 0.8)."""
    r = _ratio(x)
    return 1.0 if r is not None and r < TOO_LOW_SOFT else 0.0


@feature("price_median_absent_low")
def price_median_absent_low(x: GateInput) -> float:
    """No market median to compare against and a low price: the discount is invisible to every ratio feature."""
    return 1.0 if not x.references.market_median and x.listing.item.price < 50 else 0.0


@feature("has_median")
def has_median(x: GateInput) -> float:
    return 1.0 if x.references.market_median else 0.0
