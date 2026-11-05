import re

from calhacks_contracts import GateInput

from features._text import PATTERNS, WORD, all_text, fold, item_text, normalize, scripts
from gatepy.registry import feature

AGENT_WORDS = re.compile(r"\b(ai|a\.i\.|llm|assistant|agent|bot|model|gpt|claude|shopping assistant)s?\b")
IMPERATIVE = re.compile(r"\b(must|should|do not|don't|never|always|immediately|ignore|override|proceed|skip|complete)\b")
# Wider than AGENT_WORDS: anything that names the machine reading the listing, including the payment and review side.
MACHINE_WORDS = re.compile(
    r"\b(ai|a\.i\.|artificial intelligence|llm|language model|assistant|agent|bot|model|gpt|claude|"
    r"automated (?:buyer|system|checkout|reviewer|agent|assistant)|shopping (?:assistant|agent|bot)|checkout (?:system|bot)|"
    r"payment (?:processor|system|gateway)|reviewer|review system|risk (?:engine|model|system))\b")
# A directive a machine is expected to obey, in a sentence that also names the machine.
DIRECTIVE = re.compile(
    r"\b(note|notice|instruction|instructions|must|should|please|proceed|skip|ignore|disregard|do not|don't|never|"
    r"always|trust|approve|authorize|confirm|verified|ensure|make sure|remember|important|warning|required)\b")
# Phrases whose only purpose is to switch the verification off. Kept narrow: these do not appear in honest offers.
BYPASS = re.compile(
    r"do not (?:re-?)?(?:check|verify)|don't (?:re-?)?(?:check|verify)|no need to (?:re-?)?(?:check|verify)|"
    r"skip (?:the )?(?:verification|check|risk check)|pre-?verified|already (?:been )?verified|auto-?approve|"
    r"automatically approv|whitelist|verified wallet|trusted wallet|ignore (?:the )?(?:risk|warning|check|flag)|"
    r"no further check(?:s)?|safe to (?:pay|buy)|without (?:any )?further (?:check|verification)")
# Instructions about the payment itself rather than the goods: "skip all comparisons and finalize payment immediately".
# Every branch needs a phrase an honest offer has no reason to write.
MANIPULATION = re.compile(
    r"(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:prior|previous|other|earlier)?\s*"
    r"(?:guidance|instructions?|rules|criteria|checks?|comparisons?|options|listings?|reviews?|warnings?)|"
    r"skip\s+(?:all\s+|the\s+|any\s+)?(?:checks?|comparisons?|reviews?|verification|steps?)|"
    r"(?:mark|treat|consider|report)\s+(?:this|the)\s+(?:order|listing|item|seller|store|wallet|payment|offer)\s+"
    r"(?:as\s+)?(?:approved|verified|safe|trusted|legitimate|valid|paid)|"
    r"(?:finalize|finalise|complete|proceed with|confirm|authorize|approve)\s+(?:the\s+|this\s+|my\s+|your\s+)?"
    r"(?:payment|purchase|order|transaction|checkout|transfer)\s+(?:immediately|now|right away|at once)")


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


@feature("machine_directed_sentence", monotone=1)
def machine_directed_sentence(x: GateInput) -> float:
    """Sentences that name the machine reading the listing and tell it what to do, however quietly."""
    n = 0
    for chunk in [item_text(x), *x.listing.reviews]:
        for s in re.split(r"(?<=[.!?])\s+|\n", fold(chunk)):
            n += bool(MACHINE_WORDS.search(s) and DIRECTIVE.search(s))
    return float(n)


@feature("injection_hits_folded", monotone=1)
def injection_hits_folded(x: GateInput) -> float:
    """Injection patterns found again after homoglyphs are folded to Latin: what the attacker hid by alphabet."""
    t = fold(all_text(x))
    return float(sum(len(p.findall(t)) for p in PATTERNS))


@feature("order_manipulation", monotone=1)
def order_manipulation(x: GateInput) -> float:
    """Text that tells the buyer how to close the payment: skip the comparisons, mark it approved, finalize it now."""
    return float(len(MANIPULATION.findall(fold(all_text(x)))))


@feature("manipulation_evidence", monotone=1)
def manipulation_evidence(x: GateInput) -> float:
    """All the ways one listing tries to steer the decision, in one number: injected patterns (also after homoglyphs),
    verification bypass, payment instructions, and words whose letters switch alphabet to slip past a pattern list."""
    raw = all_text(x)
    t = fold(raw)
    hits = len(MANIPULATION.findall(t)) + len(BYPASS.findall(t))
    hits += sum(len(p.findall(t)) for p in PATTERNS)
    hits += sum(len(scripts(w)) > 1 for w in WORD.findall(raw))
    return float(hits)


@feature("verification_bypass", monotone=1)
def verification_bypass(x: GateInput) -> float:
    """Text asking the buyer (or the agent) to skip verification: 'no need to check the wallet', 'pre-verified'."""
    return float(len(BYPASS.findall(fold(all_text(x)))))
