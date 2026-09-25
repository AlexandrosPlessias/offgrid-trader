"""Data management routes: /data/*."""

from __future__ import annotations

import io
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from backend.database import clear_all_data as _clear_all_data
from backend.routes._models import _safe_error_text

_log = logging.getLogger(__name__)

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


@router.get("/data/export")
def export_data() -> dict[str, Any]:
    """Download a portable JSON snapshot of the user's trading DATA.

    Includes signals, analysis log, paper orders, fractional positions, discovery
    runs (with candidates), the watchlist, and ticker memory. Config and secrets are
    NOT here — export those separately via ``GET /settings/export``. Manual only.
    """
    from datetime import datetime, timezone

    from backend.database import (
        get_all_ticker_memory,
        get_discovery_history,
        get_discovery_run_candidates,
        get_effective_watchlist,
        get_frac_positions,
        get_paper_orders,
        get_recent_analyses,
        get_recent_signals,
        get_setting,
    )

    signals, _ = get_recent_signals(limit=100_000)
    runs = get_discovery_history(limit=1_000)
    discovery = [{"run": r, "candidates": get_discovery_run_candidates(r["id"])} for r in runs]
    return {
        "format": "marketsage-data",
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "signals": signals,
        "analysis_log": get_recent_analyses(limit=100_000),
        "paper_orders": get_paper_orders(limit=100_000),
        "frac_positions": get_frac_positions(limit=100_000),
        "discovery_runs": discovery,
        "watchlist": {
            "effective": get_effective_watchlist(),
            "added": json.loads(get_setting("watchlist_added", "[]")),
            "removed": json.loads(get_setting("watchlist_removed", "[]")),
        },
        "ticker_memory": get_all_ticker_memory(),
    }


@router.get("/data/export/xlsx")
def export_data_xlsx() -> StreamingResponse:
    """Download a multi-sheet Excel workbook of the user's trading data.

    Sheets: Signals, Paper Orders, Frac Positions, Discovery Runs,
    Discovery Candidates, Ticker Memory, Watchlist.
    """
    import openpyxl
    from openpyxl.styles import Font

    from backend.database import (
        get_all_ticker_memory,
        get_discovery_history,
        get_discovery_run_candidates,
        get_effective_watchlist,
        get_frac_positions,
        get_paper_orders,
        get_recent_analyses,
        get_recent_signals,
        get_setting,
    )

    signals, _ = get_recent_signals(limit=100_000)
    runs = get_discovery_history(limit=1_000)

    wb = openpyxl.Workbook()
    bold = Font(bold=True)

    def _sheet(name: str, rows: list[dict]) -> None:
        ws = wb.create_sheet(name)
        if not rows:
            return
        headers = list(rows[0].keys())
        ws.append(headers)
        for cell in ws[1]:
            cell.font = bold
        for row in rows:
            ws.append(
                [
                    json.dumps(v) if isinstance(v, (list, dict)) else v
                    for v in (row.get(h) for h in headers)
                ]
            )

    # Remove the default empty sheet openpyxl creates.
    wb.remove(wb.active)

    _sheet("Signals", signals)
    _sheet("Analysis Log", get_recent_analyses(limit=100_000))
    _sheet("Paper Orders", get_paper_orders(limit=100_000))
    _sheet("Frac Positions", get_frac_positions(limit=100_000))
    _sheet("Discovery Runs", runs)
    cands = []
    for r in runs:
        for c in get_discovery_run_candidates(r["id"]):
            cands.append(c)
    _sheet("Discovery Candidates", cands)
    _sheet("Ticker Memory", get_all_ticker_memory())

    # Watchlist sheet
    ws_wl = wb.create_sheet("Watchlist")
    ws_wl.append(["type", "ticker"])
    ws_wl[1][0].font = bold
    ws_wl[1][1].font = bold
    for t in get_effective_watchlist():
        ws_wl.append(["effective", t])
    for t in json.loads(get_setting("watchlist_added", "[]")):
        ws_wl.append(["added_override", t])
    for t in json.loads(get_setting("watchlist_removed", "[]")):
        ws_wl.append(["removed_override", t])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"marketsage-data-{date_str}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/data/import")
async def import_data(request: Request) -> dict[str, Any]:
    """Restore a data snapshot produced by GET /data/export.

    Accepts the JSON export body. Uses INSERT OR IGNORE so existing rows
    are never overwritten — safe to call on a live instance. For a clean
    restore, clear the relevant tables first (Settings → Data) then import.
    """
    from backend.database import import_data_snapshot

    try:
        payload = await request.json()
    except ValueError as exc:
        # A decode error describes the caller's own payload ("Expecting value:
        # line 1 column 1"), so echoing it is helpful rather than leaky.
        raise HTTPException(
            status_code=400, detail=f"Invalid JSON: {_safe_error_text(str(exc))}"
        ) from exc
    except Exception as exc:
        _log.exception("import_data: could not read request body")
        raise HTTPException(status_code=400, detail="Could not read request body.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object.")
    if payload.get("format") != "marketsage-data":
        raise HTTPException(
            status_code=422,
            detail='Expected {"format": "marketsage-data", ...} — is this a MarketSage export?',
        )

    counts = import_data_snapshot(payload)
    total = sum(counts.values())
    return {"imported": True, "total_rows": total, "counts": counts}
