import pytest

from features import _text
from gatepy.registry import REGISTRY


def f(name, x):
    return REGISTRY[name].fn(x)


def test_price_features(inputs):
    x = inputs["S-0004"]
    assert f("price_ratio", x) == pytest.approx(49 / 180)
    assert f("price_too_low", x) == 1.0
    assert f("price_too_low", inputs["R-0001"]) == 0.0


def test_unpriced_product_is_neutral(inputs):
    x = inputs["R-0001"].model_copy(deep=True)
    x.references.market_median = None
    assert f("price_ratio", x) == 1.0 and f("price_too_low", x) == 0.0 and f("has_median", x) == 0.0


def test_trust_features(inputs):
    assert f("known_wallet", inputs["R-0001"]) == 1.0
    assert f("known_wallet", inputs["S-0004"]) == 0.0
    assert f("known_wallet", inputs["R-0001"]) == 1.0
    assert f("known_wallet", inputs["S-0004"]) == 0.0
    x = inputs["S-0004"].model_copy(deep=True)
    x.references.pay_to_first_seen = "2000-01-01"
    assert f("payto_age_days", x) > 3000
    assert f("payto_age_days", inputs["S-0004"]) == 0.0


def test_lookalike_wallet_and_exact_match_excluded(inputs):
    assert f("payto_lookalike", inputs["S-0002"]) == 1.0
    assert f("payto_affix_match", inputs["S-0002"]) == 8.0
    assert f("payto_lookalike", inputs["R-0001"]) == 0.0
    assert f("payto_affix_match", inputs["R-0001"]) < 8.0


def test_domain_closeness(inputs):
    assert f("domain_known", inputs["R-0001"]) == 1.0
    assert f("domain_similarity_to_known", inputs["R-0001"]) < 0.6
    x = inputs["R-0001"].model_copy(deep=True)
    x.listing.seller.domain = "orbit-goods.example"
    assert f("domain_known", x) == 0.0 and f("domain_similarity_to_known", x) > 0.9


def test_injection_and_hidden_text(inputs):
    assert f("injection_hits_text", inputs["S-0005"]) >= 1
    assert f("imperative_to_agent", inputs["S-0005"]) >= 1
    assert f("injection_hits_text", inputs["R-0001"]) == 0
    hidden = inputs["S-0006"]
    assert f("hidden_chars", hidden) >= 3
    assert f("injection_hits_text", hidden) >= 1, "normalization must expose text hidden by zero-width characters"
    assert f("hidden_chars", inputs["R-0001"]) == 0


def test_mixed_script_words(inputs):
    x = inputs["R-0001"].model_copy(deep=True)
    x.listing.item.text = "Sоny headphones"  # Cyrillic o
    assert f("mixed_script_words", x) == 1.0
    assert f("mixed_script_words", inputs["R-0001"]) == 0.0


def test_review_similarity_and_embedding_hook(inputs):
    assert f("review_similarity_max", inputs["S-0007"]) > 0.7
    assert f("review_similarity_max", inputs["R-0001"]) < 0.3
    a, b = inputs["R-0001"].listing.reviews
    _text.EMBEDDINGS.update({_text.text_key(a): [1.0, 0.0], _text.text_key(b): [1.0, 0.0]})
    try:
        assert f("review_similarity_max", inputs["R-0001"]) == pytest.approx(1.0)
    finally:
        _text.EMBEDDINGS.clear()


def test_features_never_see_answer_info(inputs):
    x = inputs["S-0005"]
    assert not hasattr(x, "answer_key") and set(type(x).model_fields) == {"mandate", "listing", "references"}
