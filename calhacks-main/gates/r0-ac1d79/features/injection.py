import re

from calhacks_contracts import GateInput

from features._text import PATTERNS, item_text, normalize
from gatepy.registry import feature

AGENT_WORDS = re.compile(r"\b(ai|a\.i\.|llm|assistant|agent|bot|model|gpt|claude|shopping assistant)s?\b")
IMPERATIVE = re.compile(r"\b(must|should|do not|don't|never|always|immediately|ignore|override|proceed|skip|complete)\b")


def _hits(text: str) -> float:
    t = normalize(text)
    return float(sum(len(p.findall(t)) for p in PATTERNS))


@feature("injection_hits_text", monotone=1)
def injection_hits_text(x: GateInput) -> float:
    """Known injection patterns in the item text, after normalization (invisible characters removed)."""
    return _hits(item_text(x))


@feature("injection_hits_reviews", monotone=1)
def injection_hits_reviews(x: GateInput) -> float:
    return float(sum(_hits(r) for r in x.listing.reviews))


@feature("imperative_to_agent", monotone=1)
def imperative_to_agent(x: GateInput) -> float:
    """Sentences that both address an AI/agent and give an order."""
    n = 0
    for chunk in [item_text(x), *x.listing.reviews]:
        for s in re.split(r"(?<=[.!?])\s+|\n", normalize(chunk)):
            n += bool(AGENT_WORDS.search(s) and IMPERATIVE.search(s))
    return float(n)
