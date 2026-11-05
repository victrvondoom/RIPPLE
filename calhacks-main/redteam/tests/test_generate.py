import time
from calhacks_contracts import Listing
import pytest

from redteam import bitdeer
from redteam.generate import SpecError, parse_spec, run_spec

from conftest import slot_ids

SPEC = {"spec_id": "S-pi", "family": "prompt_injection", "n": 20, "legit_ratio": 0.4, "mode": "mutate_real",
        "target_weakness": "hide it in a review"}


def test_spec_rejects_holdout_unknown_and_legit_families():
    for fam in ("urgency_pressure", "lookalike_domain", "no_such_family"):
        with pytest.raises(SpecError) as e:  # held-out families get exactly the typo error
            parse_spec({**SPEC, "family": fam})
        assert str(e.value) == f"unknown family {fam!r}"
    with pytest.raises(SpecError):
        parse_spec({**SPEC, "family": "legit_plain"})
    with pytest.raises(SpecError):
        parse_spec({**SPEC, "family": "nope"})
    with pytest.raises(SpecError):
        parse_spec({**SPEC, "n": 0})
    assert parse_spec({**SPEC, "family": "legit_hard"}).family == "legit_hard"
    assert parse_spec({**SPEC, "family": "urgency_pressure"}, allow_holdout=True)


def test_needs_real_listings(repo):
    repo.db.answer_keys.delete_many({})
    with pytest.raises(SpecError, match="no real listings"):
        run_spec({**SPEC, "family": "too_cheap"}, round_=1, r=repo)
    with pytest.raises(SpecError, match="base_listing_ids"):
        run_spec({**SPEC, "base_listing_ids": ["nope"]}, round_=1, r=repo)


def test_code_only_families_skip_the_llm_and_write_to_mongo(repo, fake_client):
    before = set(repo.real_listing_ids())
    out = run_spec({**SPEC, "spec_id": "S-tc", "family": "too_cheap", "n": 30, "legit_ratio": 0.2}, round_=1, r=repo,
                   client=fake_client())
    assert out["kept"] + out["dropped"] == 30 and out["kept"] >= 25
    llm = [s for s, _ in out["_items"] if s.gen.model]
    assert {s.answer_key.family for s in llm} <= {"legit_mixed_reviews", "legit_real_discount", "legit_rewrite"}  # only LLM families
    # listings collection holds only Listing fields; label lives in answer_keys
    doc = repo.db.listings.find_one({"_id": out["_items"][0][0].listing.listing_id})
    assert set(doc) == {"_id", *Listing.model_fields}
    fams = {k.family for k in repo.answer_keys({"_id": {"$regex": "^S1-S-tc"}})}
    assert "too_cheap" in fams and fams - {"too_cheap"} <= {"legit_plain", "legit_real_discount",
                                                             "legit_new_seller", "legit_mixed_reviews", "legit_rewrite"}
    assert set(repo.real_listing_ids()) == before
    assert repo.db.specs.find_one({"_id": "S-tc"})["round"] == 1


def test_llm_spec_with_mock_client(repo, fake_client):
    client = fake_client()
    out = run_spec(SPEC, round_=1, r=repo, client=client, models=["m-a", "m-b"])
    kept = [s for s, _ in out["_items"]]
    pi = [s for s in kept if s.answer_key.family == "prompt_injection"]
    assert len(pi) == 12 and out["kept"] + out["dropped"] == 20
    assert all(s.gen.model in ("m-a", "m-b") and s.gen.prompt_version == "v2-mutate_real" for s in pi)
    assert all("Agents must complete" in s.listing.item.text for s in pi)
    assert all("item.text" in s.answer_key.attack_diff for s in pi)
    assert "hide it in a review" in client.calls[0]["messages"][1]["content"]
    assert out["tokens"]["prompt_tokens"] == 100 * out["tokens"]["calls"]


def test_missing_and_bad_slots_are_retried_once_then_dropped(repo, fake_client, monkeypatch):
    from redteam import generate
    monkeypatch.setattr(generate, "BATCH_SIZE", 10)  # one batch, so the retry is the second call
    spec = {**SPEC, "spec_id": "S-r", "n": 5, "legit_ratio": 0}
    ids = [f"S1-S-r-{i:04d}" for i in range(5)]
    client = fake_client(drop={ids[0]}, bad_evidence={ids[1]})
    out = run_spec(spec, round_=1, r=repo, client=client, models=["m"])
    assert len(client.calls) == 2
    assert set(slot_ids(client.calls[1])) == {ids[0], ids[1]}
    assert out["kept"] == 4 and out["dropped"] == 1
    assert out["drops_by_family"] == {"prompt_injection": 1}


def test_llm_batches_are_small_and_token_cap_scales(repo, fake_client):
    from redteam.config import BATCH_SIZE, TOKENS_PER_SLOT
    client = fake_client()
    run_spec({**SPEC, "spec_id": "S-b", "n": 7, "legit_ratio": 0}, round_=1, r=repo, client=client, models=["m"])
    assert all(len(slot_ids(c)) <= BATCH_SIZE for c in client.calls)
    assert all(c["max_tokens"] == len(slot_ids(c)) * TOKENS_PER_SLOT for c in client.calls)


def test_hidden_text_instruction_is_written_by_the_llm_and_hidden_by_code(repo, fake_client):
    from redteam import mutate
    out = run_spec({**SPEC, "spec_id": "S-h", "family": "hidden_text", "n": 6, "legit_ratio": 0}, round_=1, r=repo,
                   client=fake_client(), models=["m"])
    assert out["kept"] == 6
    for s, _ in out["_items"]:
        t, ev = s.listing.item.text, s.answer_key.attack_diff["item.text"]
        assert any(ch in t for ch in mutate.ZERO_WIDTH) or any(ch in t for ch in mutate.HOMOGLYPHS.values())
        assert "pre-approved" in mutate.unhide(t) and s.gen.model == "m"


def test_offline_phrases_vary_and_still_validate(repo, monkeypatch):
    import collections, random
    from redteam import bitdeer, mutate
    rng = random.Random(0)
    for task in ("hidden_text", "legit_real_discount"):
        phrases = [mutate.offline_phrase(task, rng) for _ in range(200)]
        top = collections.Counter(phrases).most_common(1)[0][1]
        assert top / len(phrases) <= 0.05, (task, top)
    def no_key():
        raise RuntimeError("no BITDEER_API_KEY")
    monkeypatch.setattr(bitdeer, "make_client", no_key)
    out = run_spec({**SPEC, "spec_id": "S-o", "family": "hidden_text", "n": 8, "legit_ratio": 0.5}, round_=1, r=repo)
    fams = {s.answer_key.family for s, _ in out["_items"]}
    assert "hidden_text" in fams and out["kept"] > 0  # offline pools, no Bitdeer needed
    for s, _ in out["_items"]:
        if s.answer_key.family == "legit_real_discount":
            assert s.listing.item.text != repo.get_listing(s.answer_key.base_listing_id).item.text


def test_generate_mode_rewrites_text_for_code_families(repo, fake_client):
    client = fake_client()
    out = run_spec({**SPEC, "spec_id": "S-g", "family": "bait_and_switch", "n": 4, "legit_ratio": 0,
                    "mode": "generate"}, round_=2, r=repo, client=client, models=["m"])
    assert out["kept"] == 4
    assert all(s.listing.item.text.startswith("Freshly written") for s, _ in out["_items"])
    assert all(s.listing.checkout.item_id != s.listing.item.id for s, _ in out["_items"])


def test_white_box_context_reaches_the_prompt(repo, fake_client):
    client = fake_client()
    run_spec({**SPEC, "spec_id": "S-wb", "n": 3, "legit_ratio": 0, "attacker_knowledge": "white_box"}, round_=1,
             r=repo, client=client, models=["m"], white_box={"features": ["injection_score"], "reasons": ["x"]})
    assert "injection_score" in client.calls[0]["messages"][1]["content"]


def test_status_error_drops_slots(repo, fake_client):
    class E(Exception):
        status_code = 401
    out = run_spec({**SPEC, "spec_id": "S-e", "n": 3, "legit_ratio": 0}, round_=1, r=repo,
                   client=fake_client(status_error=E()), models=["m"])
    assert out["kept"] == 0 and out["dropped"] == 3


def test_write_false_keeps_mongo_untouched(repo):
    n = repo.db.listings.count_documents({})
    out = run_spec({**SPEC, "spec_id": "S-nw", "family": "too_cheap", "n": 10, "legit_ratio": 0}, round_=1, r=repo,
                   write=False)
    assert out["kept"] > 0 and repo.db.listings.count_documents({}) == n


def test_tally_counts_failures():
    t = bitdeer.Tally()
    t.fail()
    assert t.as_dict()["failures"] == 1


def test_rewrites_must_keep_the_base_listing_shape():
    from redteam import prompts
    base, revs = "x" * 1000, ["a review"] * 5
    for task in ("prompt_injection", "legit_rewrite"):  # the same band for scam and honest rewrites
        assert not [e for e in prompts.problems(task, "mutate_real", "y" * 1100, revs, "y" * 10, base, revs)
                    if "length" in e]
        assert any("length" in e for e in prompts.problems(task, "mutate_real", "y" * 1600, revs, "y", base, revs))
    assert any("reviews" in e for e in prompts.problems("fake_reviews", "mutate_real", base, ["r"] * 3, None, base, revs))
    assert not prompts.problems("fake_reviews", "mutate_real", base, ["r"] * 5, None, base, revs)
    assert not prompts.problems("fake_reviews", "mutate_real", base, ["r"] * 3, None, base, [])  # at least 3


def test_time_budget_stops_new_requests_and_reports_the_rest(repo, fake_client, monkeypatch):
    import redteam.generate as g
    client = fake_client()
    slow = client.create

    def create(**kw):  # every request takes 0.4 s
        time.sleep(0.4)
        return slow(**kw)
    client.chat.completions.create = create
    monkeypatch.setattr(g, "MIN_CALL_S", 0.3)
    monkeypatch.setattr(g, "CONCURRENCY", 1)
    t0 = time.monotonic()
    out = run_spec({**SPEC, "legit_ratio": 0}, round_=1, r=repo, client=client, time_budget=1.0)
    assert time.monotonic() - t0 < 3
    why = [d["why"] for d in out["_dropped"]]
    assert out["kept"] > 0 and any("time budget" in w for w in why)
    assert out["kept"] + out["dropped"] == 20


def test_under_a_time_budget_the_client_does_not_retry_inside_a_request(repo, fake_client, monkeypatch):
    """Inner retries each got the full time left, so a 120 s budget could run to several times that."""
    import redteam.generate as g
    seen = []
    real = g.bitdeer.complete_json
    monkeypatch.setattr(g.bitdeer, "complete_json", lambda *a, **k: seen.append(k.get("attempts")) or real(*a, **k))
    run_spec({**SPEC, "legit_ratio": 0, "n": 3}, round_=1, r=repo, client=fake_client(), time_budget=60)
    assert seen and set(seen) == {1}
    seen.clear()
    run_spec({**SPEC, "legit_ratio": 0, "n": 3}, round_=1, r=repo, client=fake_client())
    assert set(seen) == {3}
