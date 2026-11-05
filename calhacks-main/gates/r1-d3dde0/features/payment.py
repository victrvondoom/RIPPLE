from calhacks_contracts import GateInput

from gatepy.registry import feature


def _affix_match(a: str, b: str) -> int:
    """Matching hex characters among the first 4 and last 4 (the ones people actually check)."""
    a, b = a.lower()[2:], b.lower()[2:]
    return sum(p == q for p, q in zip(a[:4] + a[-4:], b[:4] + b[-4:]))


def _others(x: GateInput) -> list[str]:
    pay_to = x.listing.checkout.pay_to.lower()
    return [k.pay_to.lower() for k in x.references.known_sellers if k.pay_to.lower() != pay_to]


@feature("payto_lookalike", monotone=1)
def payto_lookalike(x: GateInput) -> float:
    """1 if the wallet keeps a known wallet's first and last 4 hex but is a different address."""
    return 1.0 if any(_affix_match(x.listing.checkout.pay_to, w) == 8 for w in _others(x)) else 0.0


@feature("payto_affix_match", monotone=1)
def payto_affix_match(x: GateInput) -> float:
    """Best affix match (0-8) against a known wallet that is not this one."""
    return float(max((_affix_match(x.listing.checkout.pay_to, w) for w in _others(x)), default=0))
