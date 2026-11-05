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


TOKEN = re.compile(r"[^0-9a-z]+")


def _labels(d: str) -> list[str]:
    d = re.sub(r"^(https?://)?(www\.)?", "", normalize(d)).split("/")[0].split(":")[0]
    return [t for t in TOKEN.split(d) if t]


@feature("domain_clone_of_known", monotone=1)
def domain_clone_of_known(x: GateInput) -> float:
    """1 if the domain recycles a known store's name with extra words around it ('apple-official-deals.com')."""
    d = x.listing.seller.domain.lower()
    mine = _labels(d)
    if not mine:
        return 0.0
    for k in x.references.known_sellers:
        kd = k.domain.lower()
        if kd == d:
            continue
        theirs = _labels(kd)
        if len(theirs) < 2 or len(theirs[0]) < 4:
            continue
        if theirs[0] in mine[1:] or (mine[0] == theirs[0] and len(mine) > len(theirs)):
            return 1.0
    return 0.0
