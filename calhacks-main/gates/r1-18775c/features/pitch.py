"""The seller's own pitch: condition and quality promises, urgency, and whether they fit the price and condition."""
import re

from calhacks_contracts import GateInput

from features._text import all_text, item_text, normalize
from gatepy.registry import feature

# A promise the item is new: strong enough that a "used" condition contradicts it (mint/pristine do not, they are
# normal used-item talk).
NEW_CLAIM = re.compile(r"\b(brand[- ]new|sealed|unopened|unused|never used|nib|bnib|new in box)\b")
USED_CLAIM = re.compile(r"\b(used|refurb(?:ished)?|pre[- ]?owned|second[- ]?hand|open[ -]?box|opened|scratched|"
                        r"scratches|dented|worn|as[- ]is|for parts|cracked)\b")
NEW_COND = re.compile(r"\bnew\b|sealed|mint")
USED_COND = re.compile(r"used|refurb|pre[- ]?owned|second|open")
# Premium buzzwords a buyer reads as "this is the real, complete, warrantied thing".
PREMIUM = re.compile(r"\b(sealed|brand[- ]new|unopened|never used|unused|nib|bnib|authentic|genuine|original|oem|"
                     r"factory|in warranty|warranty included|receipt included|complete in box|mint|pristine)\b")
URGENCY = re.compile(r"\b(flash sale|limited[- ]time|act now|hurry|today only|ends (?:soon|tonight|today)|"
                     r"last chance|final price|must (?:go|sell)|going fast|only \d+ left|\d+ left)\b")


def _ratio(x: GateInput) -> float | None:
    m = x.references.market_median
    return x.listing.item.price / m if m else None


@feature("claim_condition_mismatch", monotone=1)
def claim_condition_mismatch(x: GateInput) -> float:
    """The text sells the item as new while the listing's condition is not (or the other way round)."""
    text = normalize(item_text(x))
    cond = normalize(x.listing.item.condition)
    sells_new = bool(NEW_CLAIM.search(text)) and bool(USED_COND.search(cond))
    sells_used = bool(USED_CLAIM.search(text)) and bool(NEW_COND.search(cond))
    return 1.0 if sells_new or sells_used else 0.0


@feature("premium_claim_steep_discount", monotone=1)
def premium_claim_steep_discount(x: GateInput) -> float:
    """Premium promises (sealed, authentic, warranty, complete) while asking half the market median."""
    r = _ratio(x)
    if r is None or r > 0.6:
        return 0.0
    return float(min(len(PREMIUM.findall(normalize(all_text(x)))), 3))


@feature("urgency_words", monotone=1)
def urgency_words(x: GateInput) -> float:
    """Scarcity and pressure phrasing, the pitch cheap listings use instead of a real store."""
    return float(len(URGENCY.findall(normalize(all_text(x)))))
