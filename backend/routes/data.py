"""Data management routes: /data/*."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from backend.database import clear_all_data as _clear_all_data

router = APIRouter()


@router.post("/data/reset")
def reset_data() -> dict[str, Any]:
    """Clear all signals and analysis history.

    app_settings (watchlist, model, etc.) is preserved.
    """
    counts = _clear_all_data()
    return {"cleared": ["signals", "analysis_log"], **counts}


@router.get("/data/cache/stats")
def cache_stats() -> dict[str, Any]:
    """Return current data-cache statistics (entry count, size, age range)."""
    from backend.database import get_cache_stats

    stats = get_cache_stats()
    stats["total_kb"] = round((stats.get("total_bytes") or 0) / 1024, 1)
    return stats


@router.delete("/data/cache")
def evict_cache(older_than_hours: int = Query(168, ge=1, le=8760)) -> dict[str, Any]:
    """Evict data-cache entries older than *older_than_hours* hours (default 7 days).

    Pass ``older_than_hours=0`` to clear everything (minimum enforced at 1).
    """
    from backend.database import evict_cache_entries

    deleted = evict_cache_entries(older_than_hours=older_than_hours)
    return {"deleted": deleted, "older_than_hours": older_than_hours}
