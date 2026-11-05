"""Signals from references the attacker can't write: the known-seller list and when we first saw the wallet."""
from calhacks_contracts import GateInput

from gatepy.clock import days_since
from gatepy.registry import feature

MAX_DAYS = 3650.0
NOVEL_DAYS = 30.0


@feature("known_wallet", monotone=-1)
def known_wallet(x: GateInput) -> float:
    pay_to = x.listing.checkout.pay_to.lower()
    return 1.0 if any(k.pay_to.lower() == pay_to for k in x.references.known_sellers) else 0.0


@feature("payto_age_days", monotone=-1)
def payto_age_days(x: GateInput) -> float:
    """Days since this wallet first appeared to us (0 = brand new or never seen)."""
    return min(MAX_DAYS, days_since(x.references.pay_to_first_seen))


@feature("wallet_novel_on_known_domain", monotone=0)
def wallet_novel_on_known_domain(x: GateInput) -> float:
    """A brand-new, unrecognised wallet collecting for a domain we already know: the rest of the listing is as
    familiar as a genuine one, only the payout address is new."""
    if known_wallet(x):
        return 0.0
    d = x.listing.seller.domain.lower()
    if not any(k.domain.lower() == d for k in x.references.known_sellers):
        return 0.0
    return 1.0 if days_since(x.references.pay_to_first_seen) < NOVEL_DAYS else 0.0
