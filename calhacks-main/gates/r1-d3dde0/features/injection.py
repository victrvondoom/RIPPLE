import re

from calhacks_contracts import GateInput

from features._text import PATTERNS, all_text, item_text, normalize
from gatepy.registry import feature

AGENT_WORDS = re.compile(r"\b(ai|a\.i\.|llm|assistant|agent|bot|model|gpt|claude|shopping assistant)s?\b")
IMPERATIVE = re.compile(r"\b(must|should|do not|don't|never|always|immediately|ignore|override|proceed|skip|complete)\b")

# Phrases an attacker uses to talk to the agent itself. Deliberately general: the fixed pattern list in the
# contracts catches the common wording, this catches the paraphrases around it.
PARAPHRASE = [re.compile(p, re.I) for p in (
    r"disregard\s+(all\s+|any\s+)?(previous|prior|earlier|above|preceding)",
    r"ignore\s+(all\s+|any\s+)?(previous|prior|earlier|above|preceding|instructions)",
    r"new\s+(instructions?|rules?|tasks?|system\s+prompt)",
    r"system\s*(prompt|message|instructions?|override)",
    r"(override|bypass)\s+(the\s+)?(gate|checks?|rules?|verification|security|mandate|limits?)",
    r"skip\s+(the\s+)?(verification|checks?|rules?|gate|review|confirmation)",
    r"without\s+(asking|confirming|checking|telling|informing|notifying)",
    r"you\s+(must|should|need\s+to|have\s+to|are\s+required\s+to)\s+"
    r"(buy|purchase|pay|approve|proceed|complete|confirm|order|send)",
    r"(do\s+not|don'?t|never)\s+(tell|inform|notify|mention|reveal|show|alert)\s+"
    r"(the\s+|this\s+)?(user|buyer|customer|human|owner|agent)",
    r"as\s+an?\s+(ai|assistant|agent|language\s+model)",
    r"(auto|pre)\s*-?\s*approv",
    r"already\s+(paid|approved|verified|purchased|settled)",
    r"no\s+need\s+to\s+(ask|confirm|check|verify)",
)]

# Markup that hides text from a human reading the page but not from the model: comment blocks and CSS hiding.
MARKUP = [re.compile(p, re.I) for p in (
    r"<!--", r"-->", r"\[//\]:", r"display\s*:\s*none", r"visibility\s*:\s*hidden",
    r"font-size\s*:\s*0", r"color\s*:\s*#(fff|ffffff|000|000000)\b", r"opacity\s*:\s*0",
)]

# Long unbroken runs of base64/hex: instructions smuggled in an encoded blob.
BLOB = re.compile(r"[A-Za-z0-9+/]{24,}={0,2}|[0-9a-fA-F]{40,}")


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


@feature("injection_paraphrase_hits", monotone=1)
def injection_paraphrase_hits(x: GateInput) -> float:
    """Injection wording the fixed contract patterns miss: paraphrases, no-ask-and-no-tell orders, fake state."""
    t = normalize(all_text(x))
    return float(sum(len(p.findall(t)) for p in PARAPHRASE))


@feature("markup_hidden_hits", monotone=1)
def markup_hidden_hits(x: GateInput) -> float:
    """HTML comments and CSS that hide text from the human reading the page but not from the agent."""
    t = normalize(all_text(x))
    return float(sum(len(p.findall(t)) for p in MARKUP))


@feature("encoded_blob_hits", monotone=1)
def encoded_blob_hits(x: GateInput) -> float:
    """Long base64/hex runs: instructions smuggled past a human in an encoded blob."""
    return float(len(BLOB.findall(normalize(all_text(x)))))
