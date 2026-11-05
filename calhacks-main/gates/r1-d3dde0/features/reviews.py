from collections import Counter
from itertools import combinations

from calhacks_contracts import GateInput

from features._text import normalize, similarity
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


def _similarities(x: GateInput) -> list[float]:
    return [similarity(a, b) for a, b in combinations(x.listing.reviews, 2)]


@feature("review_similarity_mean", monotone=1)
def review_similarity_mean(x: GateInput) -> float:
    """How alike the reviews are on average: a templated block is alike throughout, not in one pair."""
    s = _similarities(x)
    return sum(s) / len(s) if s else 0.0


@feature("review_duplicate_share", monotone=1)
def review_duplicate_share(x: GateInput) -> float:
    """Share of review pairs that are near-duplicates."""
    s = _similarities(x)
    return sum(v >= 0.6 for v in s) / len(s) if s else 0.0


@feature("review_opening_repeat", monotone=1)
def review_opening_repeat(x: GateInput) -> float:
    """Share of reviews whose first two words repeat another review's opening (copied review templates)."""
    rs = x.listing.reviews
    if len(rs) < 2:
        return 0.0
    openings = Counter(" ".join(normalize(r).split()[:2]) for r in rs)
    return float(sum(v - 1 for v in openings.values() if v > 1)) / len(rs)


@feature("review_uniform_length", monotone=1)
def review_uniform_length(x: GateInput) -> float:
    """Reviews of near-equal length: generated blocks are uniform, organic reviews are not."""
    lens = [len(r.split()) for r in x.listing.reviews]
    if len(lens) < 2:
        return 0.0
    return float(max(0.0, 1.0 - (max(lens) - min(lens)) / 20.0))
