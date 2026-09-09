"""Section 2 — Routes are registered."""

from __future__ import annotations

from backend.main import app


def test_routes_registered(check):
    # --------------------------------------------------------------------------- #
    # 2. Routes are registered
    # --------------------------------------------------------------------------- #
    # After the backend/routes/ refactor all endpoints are registered via
    # include_router(), so app.routes only contains Mount objects.  Walk the
    # OpenAPI schema instead — it flattens the full path list reliably.
    paths = set(app.openapi()["paths"].keys())
    expected = {
        "/analyze",
        "/analyze/stream",
        "/webhook/tradingview",
        "/signals",
        "/signals/{signal_id}",
        "/analysis",
        "/analysis/{entry_id}",
        "/analysis/{ticker}",
        "/market-data/{ticker}",
        "/market-data/{ticker}/history",
        "/watchlist",
        "/health",
    }
    check(
        "all expected routes present",
        expected.issubset(paths),
        f"missing={expected - paths}",
    )
