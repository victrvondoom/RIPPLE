"""What the item text promises vs. what the mandate actually buys (bait and switch).

Layer 1 checks that the listing's product key matches the mandate, so an attacker keeps the key and moves the
overpromise into the text: a headline selling a device while a buried clause quietly ships a part.
"""
import re

from calhacks_contracts import GateInput

from features._text import item_text, normalize, tokens
from gatepy.registry import feature

# Nouns that name a part rather than the whole thing: a key built from these is an accessory listing.
ACCESSORY = re.compile(
    r"\b(case|cover|skin|sleeve|pouch|bag|holster|protector|glass|film|guard|cable|cord|adapter|dongle|"
    r"charger|dock|mount|holder|stand|strap|band|clip|bracket|knob|wheel|wheels|tire|tires|pedal|handlebar|"
    r"saddle|chain|brake|pads|motherboard|digitizer|lcd|panel|replacement|spare|part|shell|frame|battery|"
    r"cartridge|toner|ink|filter|nozzle|tip|tips|stylus|cap|lid|tray|insert|shim|screw|screws|bumper|"
    r"grip|mat|pad|rack|sticker|decal|manual|key)\b")

# Nouns that name the whole, expensive thing.
DEVICE = re.compile(
    r"\b(iphone|ipad|ipod|macbook|imac|laptop|notebook|ultrabook|chromebook|tablet|phone|smartphone|android|"
    r"galaxy|pixel|console|playstation|ps[45]|xbox|nintendo|switch|handheld|camera|dslr|mirrorless|camcorder|"
    r"gopro|drone|tv|television|monitor|projector|headphones|headset|earbuds|airpods|speaker|soundbar|"
    r"turntable|watch|smartwatch|printer|scanner|router|modem|gpu|graphics\s+card|cpu|processor|ssd|drive|"
    r"hard\s+disk|desktop|refrigerator|fridge|washer|dryer|dishwasher|microwave|oven|stove|vacuum|scooter|"
    r"bicycle|bike|motorcycle|guitar|piano|violin|telescope|microscope|generator|compressor|treadmill|"
    r"kettlebell|barbell|dumbbell)\b")

# A buried clause that takes the headline back.
DISCLAIMER = re.compile(
    r"\b(not\s+included|not\s+the\s+actual|not\s+the\s+item|does\s+not\s+include|do\s+not\s+include|excluding|"
    r"excludes|without\s+the\s+(device|phone|console|item|product)|"
    r"only\s+the\s+(case|cover|part|accessor[a-z]*|stand|adapter|cable|holder|mount|skin|shell)|"
    r"(case|cover|part|accessor[a-z]*|shell)\s+only|for\s+parts\s+only|"
    r"(photo|picture|image)\s+(is\s+)?(for\s+reference|not\s+the)|stock\s+photo|not\s+as\s+pictured|"
    r"this\s+is\s+not\s+the)\b")


def _headline(text: str, words: int) -> str:
    """The first few words of the normalized text: what the title promises before any small print."""
    return " ".join(normalize(text).split()[:words])


@feature("key_accessory_text_device", monotone=1)
def key_accessory_text_device(x: GateInput) -> float:
    """The key is a part (case, cable, ...) but the headline sells a device and names no part at all."""
    if not ACCESSORY.search(normalize(x.listing.item.product_key)):
        return 0.0
    head = _headline(item_text(x), 12)
    return 1.0 if DEVICE.search(head) and not ACCESSORY.search(head) else 0.0


@feature("claim_disclaimer", monotone=1)
def claim_disclaimer(x: GateInput) -> float:
    """Buried take-backs in the item text ("case only", "phone not included"): the bait-and-switch tell."""
    return float(len(DISCLAIMER.findall(normalize(item_text(x)))))


@feature("product_key_text_overlap")
def product_key_text_overlap(x: GateInput) -> float:
    """Share of the product key's words that appear in the item text (0 when the key has no words)."""
    key = tokens(x.listing.item.product_key)
    if not key:
        return 0.0
    return len(key & tokens(item_text(x))) / len(key)
