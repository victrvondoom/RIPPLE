from itertools import combinations

from calhacks_contracts import GateInput

from features._text import similarity
from gatepy.registry import feature

PARAPHRASE = 0.5
NEAR_COPY = 0.6
LONG_WORDS = 10
LEN_REF = 25.0
COUNT_REF = 8.0


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


@feature("review_paraphrase_mass", monotone=0)
def review_paraphrase_mass(x: GateInput) -> float:
    """A manufactured review set: many long, mutually similar reviews. Count- and length-capped so a couple of
    short repeated one-liners (which honest buyers do write) cannot reach it."""
    rs = x.listing.reviews
    if len(rs) < 3:
        return 0.0
    sim = max((similarity(a, b) for a, b in combinations(rs, 2)), default=0.0)
    if sim < PARAPHRASE:
        return 0.0
    return sim * (min(len(rs), COUNT_REF) / COUNT_REF) * min(1.0, review_len_mean(x) / LEN_REF)


@feature("review_dup_long_frac", monotone=0)
def review_dup_long_frac(x: GateInput) -> float:
    """Share of pairs of substantial reviews (LONG_WORDS+ words) that read as near-copies of each other, so
    verbatim repeats of short feedback do not count as fabrication."""
    long_reviews = [r for r in x.listing.reviews if len(r.split()) >= LONG_WORDS]
    pairs = list(combinations(long_reviews, 2))
    if not pairs:
        return 0.0
    return sum(similarity(a, b) >= NEAR_COPY for a, b in pairs) / len(pairs)
