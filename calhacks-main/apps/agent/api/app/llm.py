"""Bitdeer chat client (OpenAI-compatible): streams the model's reasoning, then returns its JSON answer.

The raw reasoning is long working notes ("Max price: null", "Query should be lowercase"), so only short plain
sentences of it reach the user, one at a time: say() keeps a sentence when it is short and reads like plain English,
and speaks to the user ("The user wants" -> "You want").

JSON-object mode plus our own validation, not strict json_schema: strict schemas on Bitdeer produced runs of
whitespace instead of an answer (same choice as redteam/src/redteam/bitdeer.py).
"""

import json
import os
import re
import time
from collections.abc import AsyncIterator

import httpx

BASE = "https://api-inference.bitdeer.ai/v1"
DEFAULT_MODEL = "zai-org/GLM-5.3-Flash"
# GLM-5.3-Flash reasons before it answers, and the reasoning counts against max_tokens: at 600 it used them all
# and the answer came back empty.
MAX_TOKENS = 6000
# The model now and then returns an empty or broken answer. It is asked once more before the step gives up.
ATTEMPTS = 2


# A sentence that names fields, quotes values, or talks about the task itself (its questions, labels or format) is
# working notes, not something to show.
NOTES = re.compile(
    r"[\"{}\[\]_=`|:;\u201c\u201d]"
    r"|\b(null|json|title case|lowercase|query|item|max.?price|options?|thoughts?|fields?|ids?|candidates?|prompt|"
    r"instructions?|rules?|system|schema|output|format|reply|actually|wait|hmm|okay|ok|so|picks?|title|page|data|"
    r"provided|caveat|keep it|questions?|ask(ed|ing)?|answered|labels?|split|justified|directions?|notes?|dash(es)?|"
    r"english|sentences?|final|agents?|assistants?|ai|llms?|chatbots?|bots?)\b"
    # A sentence that stops on a joining word was cut off ("Tactical style vs.").
    r"|\b(vs|and|or|but|with|of|to|for|than)\.$",
    re.IGNORECASE)
# A sentence that continues an argument ("But 4 is allowed."), talks to itself ("I could add it.") or points at
# something unnamed ("They could be men's.") means nothing on its own.
FRAGMENT = re.compile(r"^(but|and|or|also|then|now|first|second|next|maybe|perhaps|either|alternatively|let me|let's|"
                      r"if|since|because|although|though|however|otherwise|still|yes|not|could|would|should|might|"
                      r"what|i|each|leaving|they|their|them|it|its|this one|that one|that|those|these|"
                      r"a user)\b", re.IGNORECASE)
# A thought shorter than this is a verdict on one listing ("Wrong size.") rather than something worth reading.
SAY_MIN_WORDS = 4
PRICE = re.compile(r"\$[\d.,]+")
SAY_MAX = 90
SENTENCE = re.compile(r"(.+?[.!?])(?:\s+|$)|(.+?)\n+", re.DOTALL)
# The writing rule every prompt ends with, for all text the user reads. plain() enforces it in code as well.
WRITING = ("Write everything the user reads in simple English: short, full sentences that end with a period, or a "
           "question mark for a question. Never use em dashes or en dashes.")
DASH = re.compile(r"\s*[–—]\s*|\s+-\s+")
VERBS = {"wants": "want", "needs": "need", "is": "are", "has": "have", "hasn't": "haven't", "doesn't": "don't",
         "didn't": "didn't", "said": "said", "gave": "gave", "asked": "asked", "likes": "like", "prefers": "prefer"}


class LLMError(RuntimeError):
    pass


class OverBudget(LLMError):
    """The model was still going at the caller's deadline. It is never retried, since that would take longer."""


def say(sentence: str) -> str | None:
    """The sentence as the user should see it, or None when it is working notes or too long to read at a glance."""
    text = " ".join(sentence.split())
    if not 12 <= len(text) <= SAY_MAX or NOTES.search(text) or FRAGMENT.search(text) or not text[0].isupper():
        return None
    if len(text.split()) < SAY_MIN_WORDS:
        return None
    # Questions are the model asking itself, numbers other than prices are positions in its list ("17 is a
    # pullover"), and an unclosed bracket means the sentence was cut.
    if text.endswith("?") or re.search(r"\d", PRICE.sub("", text)) or text.count("(") != text.count(")"):
        return None
    if m := re.match(r"The user('s| [\w']+)", text):
        verb = m.group(1).strip()
        text = ("Your" if verb == "'s" else "You " + VERBS.get(verb, verb)) + text[m.end():]
    if re.search(r"\b(the user|they|them|their)\b", text, re.IGNORECASE):
        return None  # Not worth rewriting in the middle of a sentence.
    return plain(text)


def plain(text: str) -> str:
    """`text` as full sentences: each dash becomes the end of a sentence, and the last one ends with a period."""
    out = ""
    for part in DASH.split(" ".join(str(text).split())):
        if part := part.strip():
            out += (" " if not out or out[-1] in ".!?" else ". ") + part[0].upper() + part[1:]
    out = out.strip()
    return out if not out or out[-1] in ".!?" else out + "."


class Narrator:
    """Turns streamed reasoning into the sentences say() keeps, as each one completes."""

    def __init__(self):
        self.buffer = ""

    def feed(self, delta: str) -> list[str]:
        self.buffer += delta
        out, end = [], 0
        for m in SENTENCE.finditer(self.buffer):
            if m.end() == len(self.buffer) and m.group(1) and not self.buffer[-1].isspace():
                break  # The last sentence may still be growing ("e.g." or "$4.99").
            end = m.end()
            if line := say(m.group(1) or m.group(2) or ""):
                out.append(line)
        self.buffer = self.buffer[end:]
        return out

    def flush(self) -> list[str]:
        line, self.buffer = say(self.buffer), ""
        return [line] if line else []


def parse_json(text: str) -> dict:
    """The answer as a JSON object, tolerating a ```json fence or text around it."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise LLMError(f"no JSON object in the answer: {text[:200]!r}")
    try:
        return json.loads(text[start:end + 1])
    except ValueError as e:
        raise LLMError(f"answer is not valid JSON: {e}") from e


async def complete_json(client: httpx.AsyncClient, messages: list[dict],
                        deadline: float | None = None) -> AsyncIterator[tuple[str, object]]:
    """Yields ("reasoning", sentence) for each short plain sentence of reasoning as it completes (see say()),
    then ("answer", dict) once. A bad or empty answer is asked for again, up to ATTEMPTS in all. With `deadline`
    (a time.monotonic() value), raises OverBudget as soon as the model is still going past it."""
    key = os.environ.get("BITDEER_API_KEY")
    if not key:
        raise LLMError("BITDEER_API_KEY missing (apps/agent/api/.env locally, a service variable on Railway)")
    for attempt in range(1, ATTEMPTS + 1):
        try:
            async for event in attempt_json(client, messages, key, deadline):
                yield event
            return
        except OverBudget:
            raise
        except LLMError:
            if attempt == ATTEMPTS:
                raise


async def attempt_json(client: httpx.AsyncClient, messages: list[dict], key: str,
                       deadline: float | None) -> AsyncIterator[tuple[str, object]]:
    """One try at complete_json(). The deadline is checked on every streamed piece, thinking or answer."""
    body = {"model": os.environ.get("BITDEER_MODEL", DEFAULT_MODEL), "messages": messages, "stream": True,
            "temperature": 0.2, "max_tokens": MAX_TOKENS, "response_format": {"type": "json_object"}}
    answer, narrator = [], Narrator()
    async with client.stream("POST", f"{BASE}/chat/completions", json=body,
                             headers={"Authorization": f"Bearer {key}"}) as res:
        if res.status_code != 200:
            raise LLMError(f"Bitdeer {res.status_code}: {(await res.aread())[:300]!r}")
        async for line in res.aiter_lines():
            if deadline is not None and time.monotonic() > deadline:
                raise OverBudget("the model was still going at the deadline")
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            choices = json.loads(line[6:]).get("choices") or []  # The last chunk carries only usage.
            delta = (choices[0].get("delta") or {}) if choices else {}
            if text := delta.get("reasoning_content"):
                for line in narrator.feed(text):
                    yield "reasoning", line
            if text := delta.get("content"):
                answer.append(text)
    for line in narrator.flush():
        yield "reasoning", line
    yield "answer", parse_json("".join(answer))


if __name__ == "__main__":
    notes = ('The user wants "a warm fleece for winter". This is clothing. I need to ask gender first (men\'s or '
             "women's), then size. The user hasn't specified gender or size.\n\n"
             'So my first question should be about gender: "Is this for men or women?" with options like "Men\'s".\n\n'
             "Max price: null.\n\n"
             "Thoughts: 2-4 short sentences restating what they want. The user's budget is $49.99 at most. "
             "Listing 3 is a Columbia fleece in size M for $10, the cheapest good fit.")
    assert plain("Like-new condition—warmest option and still under budget") == \
        "Like-new condition. Warmest option and still under budget."
    assert plain("Cheapest one – but used.") == "Cheapest one. But used."
    assert plain("What size do you wear?") == "What size do you wear?" and plain("") == ""
    n = Narrator()
    said = [line for i in range(0, len(notes), 7) for line in n.feed(notes[i:i + 7])] + n.flush()
    assert said == ["You haven't specified gender or size.",
                    "Your budget is $49.99 at most."], said

    # Sentences from real runs.
    shown = ["A heated vest is quite different from a puffer.", "You need size M.",
             "You want a hoodie under $45.", "The majority of listings are sherpa-lined.",
             "Lightweight vs heavyweight sherpa-lined is clearly different."]
    hidden = ["These are genuinely different directions.", "But 4 is allowed.", "They haven't given a size.",
              "If they want a hoodie vs a jacket, that's also different.", "Their size is M.",
              "Size medium was answered; kids items excluded automatically.", "Keep it short.", "Max 3 picks.",
              "The rules say ask one thing at a time, gender first.", "I'll pick 9, 2, 7.",
              "They could be men's or unisex.", "Could be men's.", "One question at a time.",
              "Amazon listings (7-17) don't state size in the page text.", "The gender has been answered.",
              "Do the remaining listings split into clearly different directions?",
              "Zip-up vs pullover (17 is pullover).",
              "Is there a real choice that matters?", "No, 20 is thermal-lined).", "Only 17 is a pullover.",
              "Not a real split.", "What about 15 (heated) and 16 (tactical)?", "I think asking is justified.",
              "Labels 1-4 words.", "I could add it.", "Leaving 15 out entirely is fine.", "Each leaves out listings.",
              "Leaving it out is fine.", "Each excludes listings.", "No price given.",
              "These are quite different products.", "Tactical style vs.", "Final answer.", "That covers most.",
              "Notes should be short, simple English.", "A user might care.",
              "Many shopping agents would include it.", "An AI would usually ask about color."]
    assert [say(s) for s in shown] == shown, [say(s) for s in shown]
    assert [s for s in hidden if say(s)] == [], [s for s in hidden if say(s)]
    print("ok")
