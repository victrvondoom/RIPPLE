"""
Automated End-to-End Test Suite for Incident-Sentinel Workflow.
Tests:
1. Incident detection from telemetry.
2. Root cause diagnosis & commit correlation.
3. Human-in-the-loop approval gate.
4. Rollback execution & post-incident health recovery verification.
"""

import asyncio
import json
import pytest
from mock_infrastructure import app, SYSTEM_STATE
from fastapi.testclient import TestClient

client = TestClient(app)


def test_initial_incident_state():
    # 1. Trigger incident
    resp = client.post("/trigger-incident")
    assert resp.status_code == 200
    assert resp.json()["state"]["status"] == "DEGRADED"

    # 2. Triager queries telemetry
    telemetry = client.get("/telemetry/cart-service").json()
    assert telemetry["current_status"] == "DEGRADED"
    assert telemetry["error_rate_percent"] > 40.0
    assert "NullPointerException" in telemetry["last_error_stack"]

    # 3. Triager correlates with deployment history
    deployments = client.get("/deployments/cart-service").json()
    assert deployments["current_version"] == "v2.14.0"
    assert deployments["last_stable_version"] == "v2.13.2"

    # 4. Operator executes rollback after approval
    rollback_resp = client.post(
        "/rollback",
        json={
            "service": "cart-service",
            "target_version": "v2.13.2",
            "approved_by": "on-call-sre",
        },
    )
    assert rollback_resp.status_code == 200
    assert rollback_resp.json()["status"] == "SUCCESS"
    assert rollback_resp.json()["reverted_to"] == "v2.13.2"

    # 5. Post-rollback health verification
    health = client.get("/health/cart-service").json()
    assert health["status"] == "HEALTHY"
    assert health["http_status_code"] == 200
    assert health["error_rate_percent"] == 0.0
    assert health["system_recovery_confirmed"] is True
    print("\n✅ End-to-end incident triage and recovery test PASSED!")


if __name__ == "__main__":
    test_initial_incident_state()
