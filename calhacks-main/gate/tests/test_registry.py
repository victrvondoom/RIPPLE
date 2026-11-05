import math
import socket

import pytest

from gatepy.registry import REGISTRY, discover, feature, feature_code_hash, select, self_test
from gatepy.selftest import fixture_inputs

EXPECTED = {
    "price_ratio": -1, "price_too_low": 1, "has_median": 0,
    "known_wallet": -1, "payto_age_days": -1,
    "domain_known": -1, "domain_similarity_to_known": 1,
    "payto_lookalike": 1, "payto_affix_match": 1,
    "injection_hits_text": 1, "injection_hits_reviews": 1, "imperative_to_agent": 1,
    "hidden_chars": 1, "mixed_script_words": 1,
    "review_count": 0, "review_similarity_max": 1, "review_len_mean": 0,
}


def test_discover_finds_issue1_features_with_monotone_directions():
    reg = discover()
    assert {n: f.monotone for n, f in reg.items()} == EXPECTED


def test_no_feature_targets_removed_fields_or_holdout_tricks():
    reg = discover()
    assert not {"urgency_hits", "store_name_similarity_to_known", "seller_age_years"} & set(reg)


def test_builtin_features_pass_self_test():
    assert self_test(select("all"), fixture_inputs()) == []


def test_self_test_rejects_bad_features():
    calls = {"n": 0}

    @feature("t_nan")
    def t_nan(x):
        return math.nan

    @feature("t_flaky")
    def t_flaky(x):
        calls["n"] += 1
        return float(calls["n"])

    @feature("t_network")
    def t_network(x):
        socket.create_connection(("example.com", 80))
        return 0.0

    @feature("t_file")
    def t_file(x):
        with open(__file__) as f:
            return float(len(f.read()))

    @feature("t_type")
    def t_type(x):
        return "high"

    names = ("t_nan", "t_flaky", "t_network", "t_file", "t_type")
    errors = self_test([REGISTRY[n] for n in names], fixture_inputs())
    for name in names:
        assert any(e.startswith(name + ":") for e in errors), name


def test_feature_decorator_validates_monotone():
    with pytest.raises(ValueError):
        feature("bad", monotone=2)


def test_select_and_hash():
    assert [f.name for f in select(["price_ratio", "hidden_chars"])] == ["price_ratio", "hidden_chars"]
    assert "hidden_chars" not in [f.name for f in select("all", exclude=["hidden_chars"])]
    with pytest.raises(KeyError):
        select(["no_such_feature"])
    assert feature_code_hash() == feature_code_hash()
