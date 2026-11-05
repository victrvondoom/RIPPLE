"""Deployment path: gate-release (export / install / verify), the long-lived Layer 1 process, and the Gate service."""
import shutil

import pytest
from fastapi.testclient import TestClient

from gatepy import GATE_DIR, release
from gatepy.app import ServedGate, create_app
from gatepy.dataset import load_examples, to_inputs
from gatepy.layer1_bridge import Layer1Process, run_layer1
from test_serve import honest_known_listing, request


def test_export_then_install_reproduces_the_trained_feature_code(trained, models_dir, tmp_path):
    gates = tmp_path / "gates"
    out = release.export(trained["model_id"], models_dir, gates)
    assert (gates / trained["model_id"] / "model.json").exists() and "price.py" in out["features"]
    gate_copy = tmp_path / "gate"
    shutil.copytree(GATE_DIR / "features", gate_copy / "features", ignore=shutil.ignore_patterns("__pycache__"))
    (gate_copy / "features" / "price.py").write_text("# drifted\n", encoding="utf-8")
    (gate_copy / "features" / "stray.py").write_text("# not part of the release\n", encoding="utf-8")
    (gates / "CURRENT").write_text(trained["model_id"] + "\n", encoding="utf-8")
    res = release.install(gates=gates, gate_dir=gate_copy, models_dir=tmp_path / "models")
    assert res["verified"] and res["model_id"] == trained["model_id"]
    assert not (gate_copy / "features" / "stray.py").exists()
    assert (tmp_path / "models" / f"{trained['model_id']}.json").exists()


def test_verify_refuses_mismatched_feature_code(trained, models_dir, tmp_path):
    gate_copy = tmp_path / "gate"
    shutil.copytree(GATE_DIR / "features", gate_copy / "features", ignore=shutil.ignore_patterns("__pycache__"))
    assert release.verify(trained["model_id"], models_dir, gate_copy)["verified"]
    (gate_copy / "features" / "price.py").write_text("# drifted\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="does not match"):
        release.verify(trained["model_id"], models_dir, gate_copy)


def test_long_lived_layer1_matches_the_batch_runner(repo):
    inputs = to_inputs(load_examples(repo)[:12], repo.reference_snapshot())
    l1 = Layer1Process()
    try:
        assert l1.run(inputs) == run_layer1(inputs)
        assert l1.run(inputs[:1]) == run_layer1(inputs[:1])  # the same process answers again
        l1._proc.kill()
        l1._proc.wait()
        assert l1.run(inputs[:2]) == run_layer1(inputs[:2])  # and restarts if it died
    finally:
        l1.close()


def test_service_decides_reports_its_version_and_fails_closed(trained, models_dir, repo):
    client = TestClient(create_app(ServedGate(trained["model_id"], models_dir, repo=repo)))
    assert client.get("/health").json() == {"ok": True, "model_id": trained["model_id"]}
    v = client.get("/version").json()
    assert v["model_id"] == trained["model_id"] and len(v["feature_code_hash"]) == 64 and 0 < v["threshold"] < 1
    lid = honest_known_listing(repo)
    d = client.post("/decide", json=request(repo, lid))
    assert d.status_code == 200 and d.json()["model_version"] == trained["model_id"]
    assert client.post("/gate/risk", json=request(repo, lid)).json() == d.json()
    over = client.post("/decide", json=request(repo, lid, max_price=0.01)).json()
    assert over["decision"] == "skip" and over["failed_rule"] == "L1_OVER_MAX"
    gone = client.post("/decide", json=request(repo, lid) | {"proposal": {"listing_id": "nope"}})
    assert gone.status_code == 503 and gone.json()["decision"] == "skip"


def test_service_refuses_to_start_on_a_feature_code_mismatch(trained, models_dir, monkeypatch):
    monkeypatch.setenv("GATE_MODEL_ID", trained["model_id"])
    monkeypatch.setattr("gatepy.app.MODELS", models_dir)
    monkeypatch.setattr("gatepy.app.verify", lambda *a, **k: (_ for _ in ()).throw(SystemExit("does not match")))
    with pytest.raises(SystemExit, match="does not match"):
        create_app()
