"""Gate subprocesses run coordinator-written feature code, so they must never receive the holdout key or location."""
import subprocess

from redteam import gate_client


def test_subprocess_env_drops_holdout(monkeypatch):
    monkeypatch.setenv("HOLDOUT_KEY", "secret-key")
    monkeypatch.setenv("CALHACKS_HOLDOUT", "C:/somewhere/calhacks-holdout")
    monkeypatch.setenv("MONGODB_DB_REDTEAM", "redteam_test")
    seen = {}

    def fake_run(args, **kw):
        seen.update(kw["env"])
        return subprocess.CompletedProcess(args, 0, stdout='{"model_id": "r1-x"}', stderr="")

    monkeypatch.setattr(gate_client.subprocess, "run", fake_run)
    assert gate_client._run(["gate-train", "--round", "1"]) == {"model_id": "r1-x"}
    assert "HOLDOUT_KEY" not in seen and "CALHACKS_HOLDOUT" not in seen
    assert seen["MONGODB_DB_REDTEAM"] == "redteam_test" and seen["UV_SYSTEM_CERTS"] == "1"
    from redteam.config import MODELS_DIR
    assert seen["GATE_MODELS"] == str(MODELS_DIR)  # the Gate CLIs write where the red team reads


def test_malformed_model_and_promoted_files_come_back_as_errors(tmp_path, monkeypatch, repo):
    """A corrupt promoted.json or model file must reach the MCP tools as {"error": ...}, not as an exception."""
    from redteam import gate_client
    monkeypatch.setattr(gate_client, "GATE_BACKEND", "real")
    monkeypatch.setattr(gate_client, "MODELS_DIR", tmp_path)
    (tmp_path / "promoted.json").write_text("{not json")
    assert "error" in gate_client.train(1)
    assert "error" in gate_client.evaluate("promoted")
    (tmp_path / "promoted.json").write_text('{"model_id": "r1-bad", "history": []}')
    (tmp_path / "r1-bad.json").write_text("{not json")
    monkeypatch.setattr(gate_client, "_in_process", lambda: True)
    monkeypatch.setattr(gate_client.store, "repo", lambda: repo)
    assert "error" in gate_client.evaluate("r1-bad")
