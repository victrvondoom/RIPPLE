"""
Incident-Sentinel: Mock Infrastructure & Telemetry Simulator.
Provides live interactive endpoints for reproducing enterprise outages,
inspecting telemetry, and executing rollbacks.
"""

from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="Sentinel Enterprise Infrastructure Simulator", version="1.0.0")

# Simulated state
SYSTEM_STATE = {
    "service": "cart-service",
    "version": "v2.14.0",
    "status": "DEGRADED",
    "error_rate": 48.7,
    "p99_latency_ms": 3840.5,
    "http_500_count": 1420,
    "http_200_count": 1495,
    "incident_active": True,
}


class RollbackRequest(BaseModel):
    service: str
    target_version: str
    approved_by: str


@app.get("/")
def index():
    return {
        "service": "Sentinel Infrastructure Simulator",
        "system_status": SYSTEM_STATE["status"],
        "active_version": SYSTEM_STATE["version"],
        "incident_active": SYSTEM_STATE["incident_active"],
    }


@app.get("/telemetry/{service}")
def get_telemetry(service: str):
    if service != SYSTEM_STATE["service"]:
        raise HTTPException(status_code=404, detail="Service not found")
    return {
        "service": service,
        "current_status": SYSTEM_STATE["status"],
        "version": SYSTEM_STATE["version"],
        "error_rate_percent": SYSTEM_STATE["error_rate"],
        "http_500_count": SYSTEM_STATE["http_500_count"],
        "http_200_count": SYSTEM_STATE["http_200_count"],
        "p99_latency_ms": SYSTEM_STATE["p99_latency_ms"],
        "active_alert": "HIGH_ERROR_RATE_TRIGGERED" if SYSTEM_STATE["incident_active"] else "NONE",
        "last_error_stack": (
            "NullPointerException: CartSession.getDiscount() in CartController.java:142"
            if SYSTEM_STATE["incident_active"]
            else None
        ),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/deployments/{service}")
def get_deployments(service: str):
    return {
        "service": service,
        "current_version": SYSTEM_STATE["version"],
        "last_stable_version": "v2.13.2",
        "history": [
            {
                "version": "v2.14.0",
                "commit": "8f3a91b",
                "deployed_at": "12 minutes ago",
                "author": "checkout-team",
                "message": "feat(cart): dynamic discount calculation pipeline",
                "status": "active (degraded)" if SYSTEM_STATE["incident_active"] else "deprecated",
            },
            {
                "version": "v2.13.2",
                "commit": "4e1c07a",
                "deployed_at": "3 days ago",
                "author": "sre-core",
                "message": "fix(db): connection pool scaling optimization",
                "status": "active (healthy)" if not SYSTEM_STATE["incident_active"] else "previous_stable",
            },
        ],
    }


@app.post("/rollback")
def execute_rollback(req: RollbackRequest):
    SYSTEM_STATE["version"] = req.target_version
    SYSTEM_STATE["status"] = "HEALTHY"
    SYSTEM_STATE["error_rate"] = 0.0
    SYSTEM_STATE["p99_latency_ms"] = 24.5
    SYSTEM_STATE["http_500_count"] = 0
    SYSTEM_STATE["incident_active"] = False

    return {
        "status": "SUCCESS",
        "action": "ROLLBACK_EXECUTED",
        "service": req.service,
        "reverted_to": req.target_version,
        "approved_by": req.approved_by,
        "traffic_shifted_percent": 100,
        "system_status": "HEALTHY",
        "message": f"Successfully rolled back {req.service} to {req.target_version}. Incident resolved.",
    }


@app.get("/health/{service}")
def get_health(service: str):
    is_healthy = not SYSTEM_STATE["incident_active"]
    return {
        "service": service,
        "status": SYSTEM_STATE["status"],
        "http_status_code": 200 if is_healthy else 500,
        "error_rate_percent": SYSTEM_STATE["error_rate"],
        "p99_latency_ms": SYSTEM_STATE["p99_latency_ms"],
        "synthetic_probes_passed": "10/10" if is_healthy else "2/10 (failing /checkout)",
        "system_recovery_confirmed": is_healthy,
    }


@app.post("/trigger-incident")
def trigger_incident():
    SYSTEM_STATE["version"] = "v2.14.0"
    SYSTEM_STATE["status"] = "DEGRADED"
    SYSTEM_STATE["error_rate"] = 48.7
    SYSTEM_STATE["p99_latency_ms"] = 3840.5
    SYSTEM_STATE["http_500_count"] = 1420
    SYSTEM_STATE["incident_active"] = True
    return {"message": "Simulated production incident triggered on cart-service", "state": SYSTEM_STATE}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8090)
