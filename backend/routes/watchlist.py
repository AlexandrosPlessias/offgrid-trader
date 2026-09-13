"""Watchlist routes: /watchlist*, /watchlist/groups*."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import (
    delete_watchlist_group,
    get_effective_watchlist,
    get_setting,
    get_watchlist_groups,
    save_watchlist_group,
    set_setting,
)
from backend.scheduler import scheduler
from backend.routes._models import _alerts_enabled, _clean_ticker

router = APIRouter()


class AddTickerRequest(BaseModel):
    ticker: str = Field(..., description="Ticker to add to the watchlist")


class BulkAddTickersRequest(BaseModel):
    tickers: list[str] = Field(..., min_length=1, description="Ticker symbols to add")


class WatchlistGroupRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80, description="Group name")
    tickers: list[str] = Field(default_factory=list, description="Tickers in this group")


@router.get("/watchlist")
def watchlist() -> dict[str, Any]:
    settings = get_settings()
    return {
        "watchlist": get_effective_watchlist(),
        "scan_interval_minutes": settings.scan_interval_minutes,
        "scheduler": scheduler.status(),
        "alerts_enabled": _alerts_enabled(),
    }


@router.post("/watchlist")
def add_ticker(request: AddTickerRequest) -> dict[str, Any]:
    ticker = request.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker required")

    added: list = json.loads(get_setting("watchlist_added", "[]"))
    removed: list = json.loads(get_setting("watchlist_removed", "[]"))

    if ticker in removed:
        removed.remove(ticker)
        set_setting("watchlist_removed", json.dumps(removed))

    base = get_settings().watchlist
    if ticker not in base and ticker not in added:
        added.append(ticker)
        set_setting("watchlist_added", json.dumps(added))

    return {"watchlist": get_effective_watchlist()}


@router.delete("/watchlist/{ticker}")
def remove_ticker(ticker: str) -> dict[str, Any]:
    ticker = ticker.strip().upper()

    added: list = json.loads(get_setting("watchlist_added", "[]"))
    removed: list = json.loads(get_setting("watchlist_removed", "[]"))

    if ticker in added:
        added.remove(ticker)
        set_setting("watchlist_added", json.dumps(added))

    if ticker not in removed:
        removed.append(ticker)
        set_setting("watchlist_removed", json.dumps(removed))

    return {"watchlist": get_effective_watchlist()}


@router.post("/watchlist/bulk")
def bulk_add_tickers(request: BulkAddTickersRequest) -> dict[str, Any]:
    """Add multiple tickers to the watchlist in a single request.

    Deduplicates against the current watchlist.  Invalid symbols are skipped.
    """
    added_list: list = json.loads(get_setting("watchlist_added", "[]"))
    removed_list: list = json.loads(get_setting("watchlist_removed", "[]"))
    base = get_settings().watchlist

    added_now: list[str] = []
    for raw in request.tickers:
        try:
            ticker = _clean_ticker(raw)
        except HTTPException:
            continue  # skip invalid symbols silently
        # Un-remove if it was previously removed
        if ticker in removed_list:
            removed_list.remove(ticker)
        # Add if not already in base or added list
        if ticker not in base and ticker not in added_list:
            added_list.append(ticker)
            added_now.append(ticker)

    set_setting("watchlist_added", json.dumps(added_list))
    set_setting("watchlist_removed", json.dumps(removed_list))
    return {"watchlist": get_effective_watchlist(), "added": added_now}


@router.get("/watchlist/groups")
def get_groups() -> dict[str, Any]:
    """Return all watchlist groups."""
    return {"groups": get_watchlist_groups()}


@router.post("/watchlist/groups")
def create_or_update_group(request: WatchlistGroupRequest) -> dict[str, Any]:
    """Create or update a watchlist group by name."""
    group_id = save_watchlist_group(request.name, request.tickers)
    return {"id": group_id, "name": request.name, "tickers": request.tickers}


@router.delete("/watchlist/groups/{group_id}")
def remove_group(group_id: int) -> dict[str, Any]:
    """Delete a watchlist group by id."""
    deleted = delete_watchlist_group(group_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Group not found")
    return {"deleted": True, "group_id": group_id}
