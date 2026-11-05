"""Signals from references the attacker can't write: the known-seller list and when we first saw the wallet."""
from calhacks_contracts import GateInput

from gatepy.clock import days_since
from gatepy.registry import feature

MAX_DAYS = 3650.0


@feature("known_wallet", monotone=-1)
def known_wallet(x: GateInput) -> float:
    pay_to = x.listing.checkout.pay_to.lower()
    return 1.0 if any(k.pay_to.lower() == pay_to for k in x.references.known_sellers) else 0.0


@feature("payto_age_days", monotone=-1)
def payto_age_days(x: GateInput) -> float:
    """Days since this wallet first appeared to us (0 = brand new or never seen)."""
    return min(MAX_DAYS, days_since(x.references.pay_to_first_seen))
