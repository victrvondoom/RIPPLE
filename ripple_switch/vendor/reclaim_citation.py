# VENDORED VERBATIM from RECLAIM backend/app/services/citation_verification.py (MIT License, (c) 2026 vsrupeshkumar).
"""Deterministic verification that a regulation/rule/clause an agent cites
actually appears in the source text it was given.

Without this, citation correctness is 100% dependent on the primary LLM not
hallucinating a plausible-sounding regulation name, softly re-checked only
by a second LLM call (the Review Agent) reading the same fallible context --
a fabricated citation can sail straight through with no ground-truth check.
This is cheap, has zero extra LLM calls, and closes that gap: every cited
rule is checked against the actual retrieved text before being presented as
grounded.
"""

from __future__ import annotations

import re

_STOPWORDS = {
    "the", "and", "for", "with", "from", "under", "act", "rule", "rules", "of",
    "in", "on", "to", "a", "an", "or", "by", "is", "are", "as", "at", "this",
}


def _significant_words(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return [w for w in words if len(w) > 3 and w not in _STOPWORDS]


def verify_claim(claim: str, source_text: str) -> bool:
    """A claim is verified if it appears near-verbatim in the source text, or
    if enough of its distinctive words (excluding generic terms like "act"/
    "rule") appear in the source that coincidence is unlikely."""
    if not claim or not source_text:
        return False
    source_lower = source_text.lower()
    if claim.lower().strip() in source_lower:
        return True
    words = _significant_words(claim)
    if len(words) < 2:
        # Too short/generic a claim ("RTI", "GST") to meaningfully verify
        # either way -- don't flag it as unverified just for being brief.
        return True
    hits = sum(1 for word in words if word in source_lower)
    return (hits / len(words)) >= 0.7


def verify_claims(claims: list[str], source_text: str) -> tuple[list[str], list[str]]:
    """Split claims into (verified, unverified), preserving order."""
    verified: list[str] = []
    unverified: list[str] = []
    for claim in claims:
        (verified if verify_claim(claim, source_text) else unverified).append(claim)
    return verified, unverified
