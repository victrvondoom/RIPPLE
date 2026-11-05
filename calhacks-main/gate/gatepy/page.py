"""Item page extraction, copied from the store crawler (apps/agent/api/actor/src/extract.py) so the Gate reads pages
itself. Keep the two in step."""

import json
import re

import lxml.html
from lxml import etree
from lxml.cssselect import CSSSelector

# Hidden from sighted humans. aria-hidden is left out: it hides icons and avatars from screen readers, not eyes.
HIDDEN = CSSSelector(", ".join([
    "[hidden]", ".sr-only", ".visually-hidden",
    '[style*="display:none"]', '[style*="display: none"]',
    '[style*="visibility:hidden"]', '[style*="visibility: hidden"]',
    '[style*="font-size:0"]', '[style*="font-size: 0"]', '[style*="opacity:0"]', '[style*="opacity: 0"]',
]))
MAIN, IMAGES, H1 = CSSSelector("main"), CSSSelector("img[src]"), CSSSelector("h1")


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def text_of(el) -> str:
    """All text in document order, joined with spaces so "<b>$45</b><sup>50</sup>" stays "$45 50"."""
    return clean(" ".join(el.itertext()))


def resolve_streaming(doc) -> None:
    """React streaming SSR sends each Suspense boundary's content as <div hidden id="S:n">, and a script
    ($RC) swaps it over the fallback between <template id="B:n"> and <!--/$-->. Do that swap here."""
    for segment in doc.xpath('//div[@hidden][starts-with(@id, "S:")]'):
        slot = next(iter(doc.xpath("//template[@id=$id]", id="B:" + segment.get("id")[2:])), None)
        if slot is None:
            continue
        parent = slot.getparent()
        slot.tail = None  # fallback text right after the template
        for sibling in list(slot.itersiblings()):
            if isinstance(sibling, etree._Comment) and sibling.text == "/$":
                break
            parent.remove(sibling)  # takes the sibling's tail text with it
        # ponytail: the segment's own tail (text after the hidden div, always empty in React output) is dropped
        segment.tail = None
        for attr in ("hidden", "id"):
            segment.attrib.pop(attr)
        slot.addprevious(segment)
        parent.remove(slot)


def extract_page(html: str) -> dict:
    doc = lxml.html.fromstring(html)
    resolve_streaming(doc)

    json_ld = []
    for el in doc.xpath('//script[@type="application/ld+json"]'):
        try:
            json_ld.append(json.loads(el.text or ""))
        except ValueError:
            pass
    for el in doc.xpath("//script | //style | //noscript | //svg | //template"):
        el.drop_tree()  # keeps the tail text, which is page content

    # ponytail: inline-style and class-name checks only, text hidden by stylesheet rules
    # (e.g. .x { color: transparent }) slips through. Render with a browser if scam pages start doing that.
    hidden_text = list(dict.fromkeys(t for el in HIDDEN(doc) if (t := text_of(el))))

    root = next(iter(MAIN(doc)), None)
    if root is None:
        root = doc.find("body") if doc.find("body") is not None else doc
    images = list(dict.fromkeys(el.get("src") for el in IMAGES(root)))
    for el in HIDDEN(root):
        el.drop_tree()

    h1 = next(iter(H1(root)), None)
    title = doc.find(".//title")
    return {
        "title": text_of(title) if title is not None else None,
        "h1": text_of(h1) if h1 is not None else None,
        "text": text_of(root),
        "images": images,
        "hiddenText": hidden_text,
        "jsonLd": json_ld,
    }
