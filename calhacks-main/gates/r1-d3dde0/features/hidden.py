import unicodedata

from calhacks_contracts import GateInput

from features._text import WORD, ZERO_WIDTH, all_text, scripts
from gatepy.registry import feature


@feature("hidden_chars", monotone=1)
def hidden_chars(x: GateInput) -> float:
    """Zero-width and other invisible format characters in the raw text (hidden text is evidence)."""
    return float(sum(ch in ZERO_WIDTH or unicodedata.category(ch) == "Cf" for ch in all_text(x)))


@feature("mixed_script_words", monotone=1)
def mixed_script_words(x: GateInput) -> float:
    """Words that mix alphabets, e.g. a Cyrillic 'а' inside a Latin word (homoglyph tricks)."""
    return float(sum(len(scripts(w)) > 1 for w in WORD.findall(all_text(x))))


# Invisible characters outside the zero-width/format set: fillers, bidi controls, tag characters, soft hyphens.
STEALTH_RANGES = (
    (0x00AD, 0x00AD), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180E, 0x180E),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x2064), (0x2066, 0x2069),
    (0x2800, 0x2800), (0x3164, 0x3164), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0),
    (0xE0000, 0xE007F), (0xE0100, 0xE01EF),
)


def _invisible(ch: str) -> bool:
    if ch in ZERO_WIDTH or unicodedata.category(ch) == "Cf":
        return True
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in STEALTH_RANGES)


@feature("stealth_chars", monotone=1)
def stealth_chars(x: GateInput) -> float:
    """Invisible characters the zero-width list misses (tag characters, fillers, bidi controls, soft hyphens)."""
    return float(sum(_invisible(ch) for ch in all_text(x)))


@feature("invisible_run_max", monotone=1)
def invisible_run_max(x: GateInput) -> float:
    """Longest run of consecutive invisible characters: a payload hides inside a long run."""
    best = run = 0
    for ch in all_text(x):
        run = run + 1 if _invisible(ch) else 0
        best = max(best, run)
    return float(best)
