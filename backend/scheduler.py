"""Async, market-hours-aware scanning loop.

Every ``scan_interval_minutes`` (while the US market is open) it walks the
watchlist and, per ticker, runs the full pipeline::

    fetch data -> AI analysis -> detect opportunities -> save -> alert

Blocking work (network I/O to yfinance / tradingview-ta / Ollama, SMTP) is
pushed to a thread pool via ``asyncio.to_thread`` so the event loop stays
responsive. The scheduler is designed to be started/stopped from the FastAPI
lifespan handler but can also be run directly::

    python -m backend.scheduler
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from .alerts import send_alert
from .analysis import analyze
from .config import MarketHours, get_settings
from .data import get_market_data
from .database import (
    get_effective_watchlist,
    init_db,
    save_analysis,
    save_signal,
)
from .opportunities import detect_opportunities, filter_by_confidence

_log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Market-hours helpers
# --------------------------------------------------------------------------- #
def is_market_open(now: Optional[datetime] = None, hours: Optional[MarketHours] = None) -> bool:
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
# Single-ticker pipeline (sync; run in a worker thread)
# --------------------------------------------------------------------------- #
def scan_ticker(ticker: str, *, send_alerts: bool = True) -> Dict[str, Any]:
    """Run the full pipeline for one ticker and persist results.

    Returns a summary dict. Never raises for expected data/Ollama failures —
    they are captured in the returned ``errors`` list.
    """

    errors: List[str] = []
    _log.info("scanning %s", ticker)

    market_data = get_market_data(ticker)
    errors.extend(market_data.get("errors", []))

    analysis = analyze(market_data)
    if analysis.get("error"):
        errors.append(analysis["error"])
        _log.warning("%s analysis error: %s", ticker, analysis["error"])

    # Always log the analysis + snapshot for later inspection.
    try:
        save_analysis(ticker, analysis, market_data)
    except Exception as exc:  # pragma: no cover - disk/db issues
        errors.append(f"save_analysis failed: {exc}")

    opportunities = detect_opportunities(market_data, analysis)
    actionable = filter_by_confidence(opportunities)

    saved_ids: List[int] = []
    alerts: List[Dict[str, Any]] = []
    for opp in actionable:
        try:
            saved_ids.append(save_signal(opp))
        except Exception as exc:  # pragma: no cover
            errors.append(f"save_signal failed: {exc}")
        if send_alerts:
            alerts.append(send_alert(opp))

    return {
        "ticker": ticker,
        "analysis": analysis,
        "opportunities": opportunities,
        "actionable": actionable,
        "saved_signal_ids": saved_ids,
        "alerts": alerts,
        "errors": errors,
    }


async def scan_ticker_async(ticker: str, *, send_alerts: bool = True) -> Dict[str, Any]:
    """Async wrapper that runs :func:`scan_ticker` in a worker thread."""

    return await asyncio.to_thread(scan_ticker, ticker, send_alerts=send_alerts)


async def scan_watchlist(*, send_alerts: bool = True) -> List[Dict[str, Any]]:
    """Scan every ticker in the effective watchlist concurrently."""

    tasks = [
        scan_ticker_async(t, send_alerts=send_alerts)
        for t in get_effective_watchlist()
    ]
    return await asyncio.gather(*tasks)


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #
class MonitorScheduler:
    """Owns the background scan loop lifecycle."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self.last_run: Optional[str] = None
        self.running = False

    async def _loop(self) -> None:
        settings = get_settings()
        interval_seconds = max(60, settings.scan_interval_minutes * 60)
        init_db()
        self.running = True
        _log.info("started; interval=%sm", settings.scan_interval_minutes)
        try:
            while not self._stop.is_set():
                if is_market_open():
                    n = len(get_effective_watchlist())
                    _log.info("market open — scanning %d tickers", n)
                    try:
                        results = await scan_watchlist(send_alerts=True)
                        self.last_run = datetime.now(
                            settings.market_hours.tzinfo
                        ).isoformat()
                        total = sum(len(r["actionable"]) for r in results)
                        _log.info("scan complete — %d actionable signal(s)", total)
                    except Exception as exc:  # pragma: no cover - defensive
                        _log.error("scan error: %s", exc)
                else:
                    _log.info("market closed — sleeping")

                try:
                    await asyncio.wait_for(
                        self._stop.wait(), timeout=interval_seconds
                    )
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

    def status(self) -> Dict[str, Any]:
        settings = get_settings()
        return {
            "running": self.running,
            "market_open": is_market_open(),
            "last_run": self.last_run,
            "scan_interval_minutes": settings.scan_interval_minutes,
            "watchlist": get_effective_watchlist(),
        }


# Shared instance used by the FastAPI app.
scheduler = MonitorScheduler()


if __name__ == "__main__":
    import json

    async def _main() -> None:
        print(f"market_open={is_market_open()}")
        # One-shot scan of the watchlist without sending alerts.
        results = await scan_watchlist(send_alerts=False)
        summary = [
            {"ticker": r["ticker"], "actionable": len(r["actionable"]), "errors": r["errors"]}
            for r in results
        ]
        print(json.dumps(summary, indent=2, default=str))

    asyncio.run(_main())
