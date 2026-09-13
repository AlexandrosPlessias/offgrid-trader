"""Section 10 — TestClient hits /health without touching the network."""

from __future__ import annotations

from unittest import mock

from fastapi.testclient import TestClient

from backend import scheduler
from backend.main import app


def test_health_endpoint(check):
    # --------------------------------------------------------------------------- #
    # 10. TestClient hits /health without touching the network
    # --------------------------------------------------------------------------- #
    try:
        # Prevent the lifespan scheduler loop from doing real scans during the test.
        with mock.patch.object(scheduler.scheduler, "start", lambda: None), mock.patch.object(
            scheduler.scheduler, "stop", mock.AsyncMock()
        ):
            with TestClient(app) as client:
                resp = client.get("/health")
                check("/health returns 200", resp.status_code == 200)
                check("/health payload ok", resp.json().get("status") == "ok")
                wl = client.get("/watchlist")
                check("/watchlist returns 200", wl.status_code == 200)
    except Exception as exc:  # pragma: no cover
        check("TestClient /health", False, repr(exc))
