from itertools import combinations

from calhacks_contracts import GateInput

from features._text import similarity
from gatepy.registry import feature


@feature("review_count")
def review_count(x: GateInput) -> float:
    return float(len(x.listing.reviews))


@feature("review_similarity_max", monotone=1)
def review_similarity_max(x: GateInput) -> float:
    """Highest similarity between any two reviews (cached embeddings when present, else word overlap)."""
    return max((similarity(a, b) for a, b in combinations(x.listing.reviews, 2)), default=0.0)


@feature("review_len_mean")
def review_len_mean(x: GateInput) -> float:
    rs = x.listing.reviews
    return sum(len(r.split()) for r in rs) / len(rs) if rs else 0.0
