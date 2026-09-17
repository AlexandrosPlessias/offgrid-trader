"""Activity feed — GET /events.

Reads the unified ``events`` table (written coarsely from the scan / order /
discovery / notification / scheduler choke points) for the in-app Log / Activity
Feed. Read-only; the frontend polls it via ``usePolling``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from backend.database import get_events

router = APIRouter(tags=["events"])


@router.get("/events")
def list_events(
    limit: int = Query(100, ge=1, le=500),
    after_id: int | None = Query(None, ge=0),
    category: str | None = Query(None, max_length=32),
) -> dict[str, Any]:
    """Return activity events newest-first (or only those newer than ``after_id``)."""
    events = get_events(limit=limit, after_id=after_id, category=category)
    return {"events": events, "count": len(events)}
