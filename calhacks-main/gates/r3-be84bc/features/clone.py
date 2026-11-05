"""Tells of a storefront that imitates a known store: a domain we never listed that reads like one we did, and a
wallet we know collecting for a domain we do not know it for. Both are references the seller cannot edit."""
import re
from difflib import SequenceMatcher

from calhacks_contracts import GateInput

from features._text import normalize
from gatepy.registry import feature

TOO_LOW = 0.5
IMITATION = 0.5


def _norm_domain(d: str) -> str:
    d = normalize(d)
    d = re.sub(r"^(https?://)?(www\.)?", "", d).split("/")[0]
    return re.sub(r"[^0-9a-zÀ-￿]", "", d)


def _ratio(x: GateInput) -> float | None:
    m = x.references.market_median
    return x.listing.item.price / m if m else None


@feature("bargain_on_imitation_domain", monotone=0)
def bargain_on_imitation_domain(x: GateInput) -> float:
    """A price far below the market on a domain that writes itself like a known store instead of being one. Zero
    on a known domain, so a real bargain on the store we already trust is left alone; the depth below the price cut
    is weighted by how close the imitating name is."""
    r = _ratio(x)
    if r is None or r >= TOO_LOW:
        return 0.0
    d = x.listing.seller.domain.lower()
    known = [k.domain.lower() for k in x.references.known_sellers]
    if d in known:
        return 0.0
    nd = _norm_domain(d)
    sim = max((SequenceMatcher(None, nd, _norm_domain(k)).ratio() for k in known if k != d), default=0.0)
    if sim < IMITATION:
        return 0.0
    return min(1.0, (TOO_LOW - r) / TOO_LOW) * sim


@feature("known_wallet_wrong_domain", monotone=1)
def known_wallet_wrong_domain(x: GateInput) -> float:
    """The wallet we are asked to pay is on our known-seller list, but never for this domain: the address is one we
    trust and the storefront in front of it is not the store we know it for. An unknown wallet scores zero here (the
    policies on unknown wallets cover it), and so does a known wallet on the domain it is known for."""
    pay_to = x.listing.checkout.pay_to.lower()
    mine = [k.domain.lower() for k in x.references.known_sellers if k.pay_to.lower() == pay_to]
    if not mine:
        return 0.0
    return 0.0 if x.listing.seller.domain.lower() in mine else 1.0
