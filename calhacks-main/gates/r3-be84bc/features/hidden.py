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
