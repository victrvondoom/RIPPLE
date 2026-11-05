"""Shared helpers for feature modules (registers no features). Loaded once at import; features never do I/O."""
import hashlib
import math
import re
import unicodedata

from calhacks_contracts import GateInput
from calhacks_contracts.families import injection_patterns

_INJ = injection_patterns()
ZERO_WIDTH = frozenset(_INJ["zero_width_chars"])
PATTERNS = [re.compile(p, re.I) for p in _INJ["patterns"]]
WORD = re.compile(r"[^\W_]+", re.U)

# Optional cached embeddings (e.g. bge-m3), keyed by text_key(text). Filled in memory before decisions (G2);
# when a text has no vector, similarity falls back to token overlap.
EMBEDDINGS: dict[str, list[float]] = {}


def text_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def strip_hidden(text: str) -> str:
    return "".join(ch for ch in text if ch not in ZERO_WIDTH and unicodedata.category(ch) != "Cf")


def normalize(text: str) -> str:
    """What an attacker can't hide behind: no invisible characters, NFKC-folded, case-folded, single spaces."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", strip_hidden(text)).casefold()).strip()


def item_text(x: GateInput) -> str:
    return x.listing.item.text


def all_text(x: GateInput) -> str:
    """Seller-controlled text the agent reads: item text and every review."""
    return "\n".join([x.listing.item.text, *x.listing.reviews])


def tokens(text: str) -> set[str]:
    return set(WORD.findall(normalize(text)))


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def similarity(a: str, b: str) -> float:
    va, vb = EMBEDDINGS.get(text_key(a)), EMBEDDINGS.get(text_key(b))
    if va is not None and vb is not None:
        dot = sum(p * q for p, q in zip(va, vb))
        na, nb = math.sqrt(sum(p * p for p in va)), math.sqrt(sum(q * q for q in vb))
        return dot / (na * nb) if na and nb else 0.0
    return jaccard(tokens(a), tokens(b))


def scripts(word: str) -> set[str]:
    """Writing systems used by the letters of a word (LATIN, CYRILLIC, GREEK, ...)."""
    out = set()
    for ch in word:
        if ch.isalpha():
            try:
                out.add(unicodedata.name(ch).split(" ")[0])
            except ValueError:
                out.add("UNKNOWN")
    return out
