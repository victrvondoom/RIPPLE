import shutil

from calhacks_contracts import GateDecision
from fastapi import FastAPI
from fastapi.testclient import TestClient

from gatepy import GATE_DIR
from gatepy.model_io import read_promoted, restore_features, set_promoted
from gatepy.serve import Gate, make_router

KNOWN = "0x1111aAaA2222bBbB3333cCcC4444dDdD5555eEe1"


def request(repo, listing_id, **mandate):
    case = repo.case(listing_id)
    return {"mandate": {**case.mandate.model_dump(), **mandate}, "proposal": {"listing_id": listing_id},
            "references": {"known_sellers": []}}


def honest_known_listing(repo):
    known = {k.pay_to.lower() for k in repo.known_sellers()}
    return next(k.listing_id for k in repo.answer_keys({"family": "real"})
                if repo.get_listing(k.listing_id).checkout.pay_to.lower() in known)


def test_score_fetches_listing_and_references_itself(trained, models_dir, repo):
    gate = Gate(trained["model_id"], models_dir, repo=repo)
    lid = honest_known_listing(repo)
    d = gate.score(request(repo, lid))
    assert isinstance(d, GateDecision)
    # The request's (empty) known_sellers are ignored: the Gate's own lookup finds the known wallet.
    cap = next(c for c in d.checks if c.rule == "L1_UNKNOWN_SELLER_CAP")
    assert cap.passed and cap.detail == "known wallet"
    assert d.model_version == trained["model_id"]


def test_score_applies_mandate(trained, models_dir, repo):
    gate = Gate(trained["model_id"], models_dir, repo=repo)
    lid = honest_known_listing(repo)
    d = gate.score(request(repo, lid, max_price=0.01))
    assert d.decision == "skip" and d.decided_by == "layer1" and d.failed_rule == "L1_OVER_MAX"


def test_custom_fetch_without_db_refs_uses_request_references(trained, models_dir, repo):
    lid = honest_known_listing(repo)
    listing = repo.get_listing(lid)
    gate = Gate(trained["model_id"], models_dir, fetch=lambda _id: listing, use_db_refs=False)
    req = request(repo, lid)
    d = gate.score(req)
    cap = next(c for c in d.checks if c.rule == "L1_UNKNOWN_SELLER_CAP")
    assert cap.detail.startswith("unknown wallet")  # the request supplied no known sellers


def test_router_fails_closed(trained, models_dir, repo):
    app = FastAPI()
    app.include_router(make_router(Gate(trained["model_id"], models_dir, repo=repo)))
    client = TestClient(app)
    ok = client.post("/gate/risk", json=request(repo, honest_known_listing(repo)))
    assert ok.status_code == 200 and ok.json()["model_version"] == trained["model_id"]
    missing = client.post("/gate/risk", json=request(repo, honest_known_listing(repo)) | {"proposal": {"listing_id": "nope"}})
    assert missing.status_code == 503 and missing.json()["decision"] == "skip"
    bad = client.post("/gate/risk", json={"proposal": {"listing_id": "x"}})
    assert bad.status_code == 503 and bad.json()["decision"] == "skip"


def test_promote_and_restore_features(trained, baseline, models_dir, tmp_path):
    set_promoted(baseline["model_id"], models_dir=models_dir)
    pointer = set_promoted(trained["model_id"], holdout={"recall": 0.9}, models_dir=models_dir)
    assert read_promoted(models_dir)["model_id"] == trained["model_id"]
    assert [h["model_id"] for h in pointer["history"]][-2:] == [baseline["model_id"], trained["model_id"]]

    gate_copy = tmp_path / "gate"
    shutil.copytree(GATE_DIR / "features", gate_copy / "features", ignore=shutil.ignore_patterns("__pycache__"))
    (gate_copy / "train_config.yaml").write_text("kind: logreg\n", encoding="utf-8")
    (gate_copy / "features" / "price.py").write_text("# edited by a rejected candidate\n", encoding="utf-8")
    (gate_copy / "features" / "new_feature.py").write_text("# added by a rejected candidate\n", encoding="utf-8")
    written = restore_features(trained["model_id"], models_dir, gate_copy)
    assert "features/new_feature.py (removed)" in written
    assert not (gate_copy / "features" / "new_feature.py").exists()
    assert (gate_copy / "features" / "price.py").read_text(encoding="utf-8") == \
        (GATE_DIR / "features" / "price.py").read_text(encoding="utf-8")
    assert (gate_copy / "train_config.yaml").read_text(encoding="utf-8").startswith("# Layer 2 training config")
