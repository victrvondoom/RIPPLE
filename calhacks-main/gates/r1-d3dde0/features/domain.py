import re
from difflib import SequenceMatcher

from calhacks_contracts import GateInput

from features._text import normalize
from gatepy.registry import feature


def _norm_domain(d: str) -> str:
    d = normalize(d)
    d = re.sub(r"^(https?://)?(www\.)?", "", d).split("/")[0]
    return re.sub(r"[^0-9a-zÀ-￿]", "", d)


@feature("domain_known", monotone=-1)
def domain_known(x: GateInput) -> float:
    d = x.listing.seller.domain.lower()
    return 1.0 if any(k.domain.lower() == d for k in x.references.known_sellers) else 0.0


@feature("domain_similarity_to_known", monotone=1)
def domain_similarity_to_known(x: GateInput) -> float:
    """How close the domain is to a known store's domain when it is NOT that domain (0 for an exact match)."""
    d = x.listing.seller.domain.lower()
    nd = _norm_domain(d)
    return max((SequenceMatcher(None, nd, _norm_domain(k.domain)).ratio()
                for k in x.references.known_sellers if k.domain.lower() != d), default=0.0)


def _host(domain: str) -> str:
    d = normalize(domain)
    d = re.sub(r"^(https?://)?(www\.)?", "", d).split("/")[0]
    return d.split(":")[0].strip(".")


@feature("domain_brand_in_host", monotone=1)
def domain_brand_in_host(x: GateInput) -> float:
    """A known store's name sits inside this host, but this is not that store (brand squatting)."""
    host = _host(x.listing.seller.domain)
    if not host:
        return 0.0
    for k in x.references.known_sellers:
        other = _host(k.domain)
        brand = other.split(".")[0]
        if other and other != host and len(brand) >= 5 and brand in host:
            return 1.0
    return 0.0
