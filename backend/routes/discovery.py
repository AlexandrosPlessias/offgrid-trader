"""Discovery routes: /discovery/*, /settings/discovery*."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import (
    get_discovery_history,
    get_discovery_run_candidates,
    get_effective_watchlist,
    get_latest_discovery,
    get_setting,
    save_discovery_candidates,
    save_discovery_run,
    set_setting,
    update_discovery_run,
)
from backend.routes._models import _sse_frame

router = APIRouter()
_log = logging.getLogger(__name__)


class DiscoverySettingRequest(BaseModel):
    enabled: bool | None = Field(None, description="Enable automatic discovery")
    sources: str | None = Field(
        None,
        description="Comma-separated sources: alpaca,yfinance",
    )
    max_candidates: int | None = Field(
        None, ge=5, le=100, description="Max candidates to score per run (5-100)"
    )
    min_score: int | None = Field(
        None, ge=0, le=100, description="Minimum score to surface a candidate (0-100)"
    )
    interval_minutes: int | None = Field(
        None, ge=15, le=1440, description="Minutes between discovery runs (15-1440)"
    )
    autoscan_enabled: bool | None = Field(
        None, description="Auto-scan top-N through the full agent pipeline"
    )
    autoscan_top_n: int | None = Field(
        None, ge=1, le=20, description="Number of top candidates to auto-scan (1-20)"
    )


def _discovery_config_response() -> dict[str, Any]:
    """Return current discovery settings (DB overrides env defaults)."""
    from backend.config import get_settings as _cfg

    cfg = _cfg().discovery
    return {
        "enabled": get_setting("discovery_enabled", "false") == "true",
        "sources": get_setting("discovery_sources", "") or cfg.sources,
        "max_candidates": int(get_setting("discovery_max_candidates", "") or cfg.max_candidates),
        "min_score": int(get_setting("discovery_min_score", "") or cfg.min_score),
        "interval_minutes": int(
            get_setting("discovery_interval_minutes", "") or cfg.interval_minutes
        ),
        "autoscan_enabled": get_setting("discovery_autoscan_enabled", "false") == "true",
        "autoscan_top_n": int(get_setting("discovery_autoscan_top_n", "") or cfg.autoscan_top_n),
    }


@router.get("/settings/discovery")
def get_discovery_settings() -> dict[str, Any]:
    """Return the current discovery configuration."""
    return _discovery_config_response()


@router.post("/settings/discovery")
def save_discovery_settings(request: DiscoverySettingRequest) -> dict[str, Any]:
    """Persist discovery settings to the DB (only non-None fields are written)."""
    if request.enabled is not None:
        set_setting("discovery_enabled", "true" if request.enabled else "false")
    if request.sources is not None:
        set_setting("discovery_sources", request.sources.strip())
    if request.max_candidates is not None:
        set_setting("discovery_max_candidates", str(request.max_candidates))
    if request.min_score is not None:
        set_setting("discovery_min_score", str(request.min_score))
    if request.interval_minutes is not None:
        set_setting("discovery_interval_minutes", str(request.interval_minutes))
    if request.autoscan_enabled is not None:
        set_setting(
            "discovery_autoscan_enabled",
            "true" if request.autoscan_enabled else "false",
        )
    if request.autoscan_top_n is not None:
        set_setting("discovery_autoscan_top_n", str(request.autoscan_top_n))
    return _discovery_config_response()


@router.get("/discovery/trending")
def trending_discovery(
    limit: int = Query(25, ge=1, le=100),
) -> dict[str, Any]:
    """Return the most-recent completed discovery run with ranked candidates.

    Each candidate includes an ``already_in_watchlist`` flag so the frontend
    can show a disabled "Add" button for tickers already being tracked.
    """
    run = get_latest_discovery()
    if not run:
        return {"run": None, "candidates": [], "watchlist": get_effective_watchlist()}

    watchlist_set = set(get_effective_watchlist())
    candidates = run.get("candidates", [])[:limit]
    for c in candidates:
        c["already_in_watchlist"] = c.get("ticker", "") in watchlist_set

    return {
        "run": {
            "id": run["id"],
            "created_at": run["created_at"],
            "sources": run["sources"],
            "candidate_count": run["candidate_count"],
            "status": run["status"],
        },
        "candidates": candidates,
        "watchlist": list(watchlist_set),
    }


@router.get("/discovery/history")
def discovery_history(
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """Return the most-recent *limit* discovery run summaries (newest first).

    Does not include per-run candidates — call ``GET /discovery/trending``
    for the latest run's full candidate list.
    """
    runs = get_discovery_history(limit=limit)
    return {"runs": runs}


@router.get("/discovery/history/{run_id}/candidates")
def discovery_run_candidates(run_id: int) -> dict[str, Any]:
    """Return all scored candidates for a specific discovery run, ordered by score desc."""
    candidates = get_discovery_run_candidates(run_id)
    if not candidates:
        raise HTTPException(status_code=404, detail="Run not found or has no candidates")
    return {"run_id": run_id, "candidates": candidates}


@router.post("/discovery/refresh")
async def discovery_refresh() -> StreamingResponse:
    """Run a discovery cycle and stream progress as Server-Sent Events.

    Yields ``data: {"type": "step"|"result"|"error", ...}`` lines.
    On completion the run is persisted and a final "result" event is sent
    with the full sorted candidate list.
    """

    async def _stream() -> AsyncGenerator[str, None]:
        from backend.discovery import run_discovery

        cfg = _discovery_config_response()
        sources = cfg["sources"]
        max_cands = cfg["max_candidates"]
        min_score = cfg["min_score"]

        # Queue-based live streaming: the worker thread pushes events via
        # call_soon_threadsafe so the async generator can yield them immediately
        # rather than buffering until run_discovery returns.
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[dict | None] = asyncio.Queue()

        def _cb(step: str, message: str) -> None:
            loop.call_soon_threadsafe(
                q.put_nowait, {"type": "step", "step": step, "message": message}
            )

        async def _run() -> list[dict]:
            try:
                return await asyncio.to_thread(
                    run_discovery, sources, max_cands, min_score, _cb, True
                )
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)  # sentinel

        run_id: int | None = None
        try:
            run_id = await asyncio.to_thread(save_discovery_run, sources)
            yield _sse_frame({"type": "step", "step": "start", "message": "Discovery started"})

            run_task = asyncio.ensure_future(_run())

            # Drain the queue until the sentinel (None) arrives
            while True:
                ev = await q.get()
                if ev is None:
                    break
                yield _sse_frame(ev)

            candidates = await run_task

            # Persist results
            await asyncio.to_thread(save_discovery_candidates, run_id, candidates)
            await asyncio.to_thread(update_discovery_run, run_id, "done", len(candidates))

            # Annotate with watchlist membership
            watchlist_set = set(await asyncio.to_thread(get_effective_watchlist))
            for c in candidates:
                c["already_in_watchlist"] = c.get("ticker", "") in watchlist_set

            yield _sse_frame(
                {
                    "type": "result",
                    "run_id": run_id,
                    "candidate_count": len(candidates),
                    "candidates": candidates,
                }
            )

        except Exception as exc:
            _log.exception("discovery_refresh error")
            if run_id is not None:
                try:
                    await asyncio.to_thread(update_discovery_run, run_id, "error", 0, str(exc))
                except Exception:  # noqa: S110
                    pass
            yield _sse_frame({"type": "error", "message": str(exc)})
        finally:
            # Catch asyncio.CancelledError (client disconnect / ASGI teardown)
            # which bypasses the except block but still runs finally.  Only
            # acts when the run_id exists and the row is still 'running'.
            if run_id is not None:
                try:
                    from backend.database import _connect as _db_conn  # local import
                    with _db_conn() as _c:
                        row = _c.execute(
                            "SELECT status FROM discovery_runs WHERE id=?", (run_id,)
                        ).fetchone()
                    if row and row["status"] == "running":
                        await asyncio.to_thread(
                            update_discovery_run, run_id, "error", 0, "Cancelled"
                        )
                except Exception:  # noqa: S110
                    pass

    return StreamingResponse(_stream(), media_type="text/event-stream")
