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
