"""Async, market-hours-aware scanning loop.

Every ``scan_interval_minutes`` (while the US market is open) it walks the
watchlist and, per ticker, runs the full pipeline through the agentic stack::

    TickerAgent → FetchDataSkill → AIAnalysisSkill → OpportunityDetectSkill
               → PersistSkill → AlertSkill

The :class:`Orchestrator` sorts tickers by staleness and caps concurrency
so Ollama is never overloaded.  The scheduler is designed to be
started/stopped from the FastAPI lifespan handler but can also be run
directly::

    python -m backend.scheduler
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from .config import MarketHours, get_settings
from .database import get_effective_watchlist, get_setting, init_db
from .memory import MemoryLayer
from .orchestrator import Orchestrator

_log = logging.getLogger(__name__)

# Module-level singletons shared across the whole process.
_memory: MemoryLayer = MemoryLayer()
_orchestrator: Orchestrator = Orchestrator(memory=_memory, max_concurrent=3)


# --------------------------------------------------------------------------- #
# Market-hours helpers
# --------------------------------------------------------------------------- #
def is_market_open(
    now: datetime | None = None,
    hours: MarketHours | None = None,
) -> bool:
    """Return True if *now* falls within the regular US trading session."""

    hours = hours or get_settings().market_hours
    now = now or datetime.now(hours.tzinfo)
    if now.tzinfo is None:
        now = now.replace(tzinfo=hours.tzinfo)
    else:
        now = now.astimezone(hours.tzinfo)

    if now.weekday() not in hours.trading_days:
        return False

    open_minutes = hours.open_hour * 60 + hours.open_minute
    close_minutes = hours.close_hour * 60 + hours.close_minute
    current_minutes = now.hour * 60 + now.minute
    return open_minutes <= current_minutes < close_minutes


# --------------------------------------------------------------------------- #
# Pipeline helpers (used by FastAPI endpoints and the loop)
# --------------------------------------------------------------------------- #
async def scan_ticker_async(
    ticker: str,
    *,
    send_alerts: bool = True,
) -> dict[str, Any]:
    """Run the full agent pipeline for one ticker and return a result dict.

    Delegates to :meth:`Orchestrator.run_ticker` which uses the module-level
    :class:`MemoryLayer` singleton.  Does not acquire the concurrency semaphore
    (on-demand single-ticker scans always go through immediately).
    """
    return await _orchestrator.run_ticker(ticker, send_alerts=send_alerts)


async def scan_watchlist(*, send_alerts: bool = True) -> list[dict[str, Any]]:
    """Scan every ticker in the effective watchlist via the Orchestrator.

    Tickers are sorted by scan staleness and run concurrently up to the
    orchestrator's ``max_concurrent`` cap.
    """
    tickers = get_effective_watchlist()
    return await _orchestrator.scan_watchlist(tickers, send_alerts=send_alerts)


# --------------------------------------------------------------------------- #
# Backward-compatible sync wrapper (kept for tests / __main__ use)
# --------------------------------------------------------------------------- #
def scan_ticker(ticker: str, *, send_alerts: bool = True) -> dict[str, Any]:
    """Synchronous wrapper around :func:`scan_ticker_async`.

    Preserved for backward compatibility with any callers that cannot easily
    be made async.  Not used by the main FastAPI app or scheduler loop.
    """
    return asyncio.get_event_loop().run_until_complete(
        scan_ticker_async(ticker, send_alerts=send_alerts)
    )


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #
class MonitorScheduler:
    """Owns the background scan loop lifecycle."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.last_run: str | None = None
        self.running = False

    async def _loop(self) -> None:
        init_db()
        self.running = True
        settings = get_settings()
        _log.info("started; interval=%sm", settings.scan_interval_minutes)
        try:
            while not self._stop.is_set():
                if is_market_open():
                    tickers = get_effective_watchlist()
                    _log.info("market open — scanning %d tickers", len(tickers))
                    try:
                        results = await scan_watchlist(send_alerts=True)
                        self.last_run = datetime.now(settings.market_hours.tzinfo).isoformat()
                        total = sum(len(r.get("actionable", [])) for r in results)
                        _log.info("scan complete — %d actionable signal(s)", total)
                    except Exception as exc:  # pragma: no cover - defensive
                        _log.error("scan error: %s", exc)
                else:
                    _log.info("market closed — sleeping")

                # Re-read interval each cycle so UI changes take effect immediately.
                db_interval = get_setting("scan_interval_minutes", "")
                interval_seconds = max(
                    60,
                    (
                        int(db_interval)
                        if db_interval and db_interval.isdigit()
                        else settings.scan_interval_minutes
                    )
                    * 60,
                )
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=interval_seconds)
                except asyncio.TimeoutError:
                    pass
        finally:
            self.running = False
            _log.info("stopped")

    def start(self) -> None:
        """Start the loop if it is not already running."""
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        """Signal the loop to stop and wait for it to finish."""
        self._stop.set()
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:  # pragma: no cover
                pass

    def status(self) -> dict[str, Any]:
        settings = get_settings()
        db_interval = get_setting("scan_interval_minutes", "")
        effective_interval = (
            int(db_interval)
            if db_interval and db_interval.isdigit()
            else settings.scan_interval_minutes
        )
        return {
            "running": self.running,
            "market_open": is_market_open(),
            "last_run": self.last_run,
            "scan_interval_minutes": effective_interval,
            "watchlist": get_effective_watchlist(),
        }


# Shared instance used by the FastAPI app.
scheduler = MonitorScheduler()


if __name__ == "__main__":
    import json

    async def _main() -> None:
        print(f"market_open={is_market_open()}")
        results = await scan_watchlist(send_alerts=False)
        summary = [
            {
                "ticker": r["ticker"],
                "actionable": len(r.get("actionable", [])),
                "errors": r.get("errors", []),
            }
            for r in results
        ]
        print(json.dumps(summary, indent=2, default=str))

    asyncio.run(_main())
