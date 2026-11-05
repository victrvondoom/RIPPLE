"""Group C: a base dataset every round builds on, coverage-aware promotion, per-family and training caps, a round time
window, the cached round input, and reusing a sealed holdout."""
import json
import time
from collections import Counter

from redteam import dryrun, mcp_server, store
from redteam.config import FAMILY_ROUND_CAP, MAX_TRAIN_CALLS
from redteam.promotion import decide
from test_promotion import m
from test_mcp_server import round1  # noqa: F401  (fixture)


# ---------- promotion ----------
def test_with_coverage_required_a_family_missing_from_val_blocks_promotion(monkeypatch):
    full = {f: 0.9 for f in ("too_cheap", "payment_mismatch", "product_switch", "bait_and_switch", "hidden_text",
                             "prompt_injection", "fake_reviews", "lookalike_payto", "store_clone")}
    assert decide(m(0.9, 0.01, **full), None)[0]  # coverage not required: no complaint
    monkeypatch.setenv("REDTEAM_REQUIRE_COVERAGE", "1")
    assert decide(m(0.9, 0.01, **full), None)[0]
    thin = {k: v for k, v in full.items() if k != "hidden_text"}
    ok, why = decide(m(0.95, 0.01, **thin), m(0.9, 0.01, **full))
    assert not ok and any("hidden_text" in w for w in why)


def test_a_family_the_incumbent_was_checked_on_cannot_vanish_for_the_candidate():
    ok, why = decide(m(0.95, 0.01, too_cheap=0.9), m(0.90, 0.01, too_cheap=0.9, hidden_text=0.8))
    assert not ok and any("hidden_text has no val rows" in w for w in why)


# ---------- caps and time window ----------
def test_per_family_cap_per_round(round1, fake_client, monkeypatch):  # noqa: F811
    from redteam import bitdeer
    monkeypatch.setattr(bitdeer, "make_client", lambda: fake_client())
    monkeypatch.setattr(mcp_server, "FAMILY_ROUND_CAP", 10)
    assert "error" not in mcp_server.generate_attacks({"family": "too_cheap", "n": 8, "legit_ratio": 0})
    over = mcp_server.generate_attacks({"family": "too_cheap", "n": 8, "legit_ratio": 0})
    assert "per-family cap" in over["error"] and "too_cheap" in over["error"]
    assert "error" not in mcp_server.generate_attacks({"family": "payment_mismatch", "n": 8, "legit_ratio": 0})
    assert FAMILY_ROUND_CAP == 40


def test_training_is_capped_per_round(round1, monkeypatch):  # noqa: F811
    store.save_round(store.repo(), 1, candidates=[f"r1-{i}" for i in range(MAX_TRAIN_CALLS)])
    out = mcp_server.train_gate()
    assert "training limit reached" in out["error"]


def test_generation_and_training_close_at_the_deadline(round1, monkeypatch):  # noqa: F811
    monkeypatch.setenv("REDTEAM_ROUND_DEADLINE", str(time.time() + 30))
    assert "time is up" in mcp_server.generate_attacks({"family": "too_cheap", "n": 4})["error"]
    assert "time is up" in mcp_server.train_gate()["error"]
    monkeypatch.setenv("REDTEAM_ROUND_DEADLINE", str(time.time() + 3600))
    assert "error" not in mcp_server.generate_attacks({"family": "too_cheap", "n": 4})


def test_get_round_input_uses_the_coordinators_cached_build(round1, monkeypatch):  # noqa: F811
    from redteam import coordinator, roundstate
    coordinator.round_input_brief(1)
    monkeypatch.setattr(roundstate, "build_round_input", lambda *a, **k: (_ for _ in ()).throw(AssertionError("rebuilt")))
    out = mcp_server.get_round_input()
    assert out["round"] == 1 and "_help" in out


# ---------- base dataset and holdout reuse ----------
def test_base_dataset_is_added_as_round_zero(tmp_path, repo, fake_client):
    from redteam.generate import run_spec
    base = store.empty_local_repo()
    for name in ("listings", "listing_meta", "answer_keys", "cases", "known_sellers", "market_medians", "wallets"):
        docs = list(repo.db[name].find())
        if docs:
            base.db[name].insert_many(docs)
    run_spec({"spec_id": "X-too_cheap", "family": "too_cheap", "n": 6, "legit_ratio": 0, "mode": "mutate_real"},
             round_=1, r=base, client=fake_client())
    store.write_local(base, tmp_path / "base")
    target = store.empty_local_repo()
    for name in ("listings", "listing_meta", "answer_keys", "cases"):
        docs = list(repo.db[name].find())
        if docs:
            target.db[name].insert_many(docs)
    out = dryrun.add_base_dataset(target, tmp_path / "base")
    assert out["base_listings"] == 6
    assert {d["round"] for d in target.db.specs.find()} == {0}
    assert Counter(k.family for k in target.answer_keys())["too_cheap"] == 6
    assert store.listing_ids(target, rounds=[1], include_real=False) == []  # not counted as any coordinator round


def test_holdout_is_copied_into_the_run_folder_not_nested(tmp_path):
    src = tmp_path / "old" / "holdout"
    src.mkdir(parents=True)
    for name in ("holdout.v3.enc", "holdout.key", "holdout.v3.meta.json", "holdout.v3.history.jsonl"):
        (src / name).write_text("x")
    run = tmp_path / "new"
    (run / "holdout").mkdir(parents=True)  # init creates it first: the earlier copy landed in holdout/holdout
    dryrun.copy_holdout(src, run)
    assert sorted(p.name for p in (run / "holdout").iterdir()) == ["holdout.key", "holdout.v3.enc",
                                                                   "holdout.v3.meta.json"]
    assert not (run / "holdout" / "holdout").exists()
    assert json.dumps(dryrun.copy_holdout(src, run))
