"""Admin endpoints — reset trading state (preview + execute)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException

from backend.config import get_settings
from backend.database import clear_selected_data, get_setting

_log = logging.getLogger(__name__)

router = APIRouter(tags=["admin"])

# Tables cleared by a full trading-state reset (preserves settings/config/groups).
_RESET_CATEGORIES = [
    "signals",
    "analysis_log",
    "paper_orders",
    "frac_positions",
    "discovery_runs",       # discovery_candidates cascade
    "watchlist_overrides",  # re-adds/removes on the base watchlist
    "ticker_memory",
    "reports",
    "events",
]


def _require_admin(authorization: str = Header(default="")) -> str:  # noqa: B008
    """Explicit auth check for destructive admin endpoints (belt-and-suspenders over middleware)."""
    token = authorization.removeprefix("Bearer ").strip()
    expected = get_settings().admin_token or get_setting("admin_token", "")
    if expected and token != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return token


def _alpaca_preview(client_fn) -> dict[str, Any]:  # type: ignore[type-arg]
    """Return open order + position counts for one Alpaca account, or an error string."""
    try:
        client = client_fn()
        orders = client.get_orders(status="open") or []
        positions = client.get_positions() or []
        return {
            "open_orders": len(orders),
            "open_positions": len(positions),
            "orders": [
                {
                    "id": o.get("id"),
                    "symbol": o.get("symbol"),
                    "side": o.get("side"),
                    "qty": o.get("qty"),
                    "status": o.get("status"),
                }
                for o in orders
            ],
            "positions": [
                {
                    "symbol": p.get("symbol"),
                    "qty": p.get("qty"),
                    "market_value": p.get("market_value"),
                    "unrealized_pl": p.get("unrealized_pl"),
                }
                for p in positions
            ],
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc), "open_orders": 0, "open_positions": 0}


@router.get("/admin/reset-preview")
def reset_preview(_: str = Depends(_require_admin)) -> dict[str, Any]:  # noqa: B008
    """Return a summary of what a full reset would cancel/delete — no changes made."""
    from backend.alpaca import get_client, get_frac_client  # noqa: PLC0415
    from backend.database import _connect  # noqa: PLC0415

    paper = _alpaca_preview(get_client)
    frac = _alpaca_preview(get_frac_client)

    db_counts: dict[str, int] = {}
    with _connect() as conn:
        for table in (
            "signals", "analysis_log", "paper_orders", "frac_positions",
            "discovery_runs", "discovery_candidates", "ticker_memory", "reports", "events",
        ):
            db_counts[table] = conn.execute(
                f"SELECT COUNT(*) FROM {table}"  # noqa: S608
            ).fetchone()[0]

    return {"paper": paper, "frac": frac, "db": db_counts}


@router.post("/admin/reset")
def execute_reset(_: str = Depends(_require_admin)) -> dict[str, Any]:  # noqa: B008
    """Cancel all Alpaca orders/positions and wipe trading data from the DB."""
    from backend.alpaca import AlpacaError, get_client, get_frac_client  # noqa: PLC0415

    results: dict[str, Any] = {"paper": {}, "frac": {}, "db": {}}

    # ── Paper Alpaca ──────────────────────────────────────────────────────────
    try:
        client = get_client()
        positions = client.get_positions() or []
        if positions:
            client.close_all_positions()
        results["paper"]["positions_closed"] = len(positions)
        orders = client.get_orders(status="open") or []
        if orders:
            client.cancel_all_orders()
        results["paper"]["orders_cancelled"] = len(orders)
    except AlpacaError as exc:
        _log.warning("Paper Alpaca reset failed: %s", exc)
        results["paper"]["error"] = str(exc)

    # ── Frac Alpaca ───────────────────────────────────────────────────────────
    try:
        frac = get_frac_client()
        frac_positions = frac.get_positions() or []
        if frac_positions:
            frac.close_all_positions()
        results["frac"]["positions_closed"] = len(frac_positions)
        frac_orders = frac.get_orders(status="open") or []
        if frac_orders:
            frac.cancel_all_orders()
        results["frac"]["orders_cancelled"] = len(frac_orders)
    except AlpacaError as exc:
        _log.warning("Frac Alpaca reset failed: %s", exc)
        results["frac"]["error"] = str(exc)

    # ── Database ──────────────────────────────────────────────────────────────
    try:
        results["db"] = clear_selected_data(_RESET_CATEGORIES)
    except Exception as exc:  # noqa: BLE001
        _log.exception("DB reset failed")
        results["db"]["error"] = str(exc)

    _log.warning("Trading state reset executed: %s", results)
    return results
