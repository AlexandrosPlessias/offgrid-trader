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
import math
from datetime import datetime
from typing import Any

from .config import MarketHours, get_settings
from .database import (
    get_effective_watchlist,
    get_setting,
    init_db,
    save_discovery_candidates,
    save_discovery_run,
    update_discovery_run,
    update_paper_order_status,
)
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


def _next_grid_time(ref: datetime, interval_seconds: int) -> datetime:
    """Return the next grid-aligned datetime strictly after *ref*.

    Anchored to the UTC epoch so sub-day intervals snap to consistent
    wall-clock marks (e.g. :00/:15/:30/:45 for 15-minute intervals).
    """
    epoch = ref.timestamp()
    next_epoch = (math.floor(epoch / interval_seconds) + 1) * interval_seconds
    return datetime.fromtimestamp(next_epoch, tz=ref.tzinfo)


def _near_market_close(minutes: int = 10) -> bool:
    """Return True within *minutes* of the regular-session close."""
    hours = get_settings().market_hours
    now = datetime.now(hours.tzinfo)
    close_minutes = hours.close_hour * 60 + hours.close_minute
    current_minutes = now.hour * 60 + now.minute
    return 0 <= (close_minutes - current_minutes) <= minutes


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
    orchestrator's ``max_concurrent`` cap, which is read from the DB setting
    ``concurrent_tickers`` (Settings → Performance) before each scan so that
    changes take effect without a container restart.
    """
    from .config import get_settings as _cfg

    _max = int(get_setting("concurrent_tickers") or 0) or _cfg().concurrent_tickers
    _orchestrator.set_max_concurrent(_max)

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
# Paper-order status sync
# --------------------------------------------------------------------------- #
async def sync_paper_orders() -> None:
    """Fetch live order status from Alpaca and update the paper_orders table.

    Runs in the background every scan cycle.  Skipped when paper trading
    is disabled or no Alpaca credentials are configured.
    """
    if get_setting("paper_trading_enabled", "true") != "true":
        return

    from .alpaca import AlpacaError, get_client  # local import — avoids startup cost

    try:
        client = get_client()
        alpaca_orders = client.get_orders(status="all", limit=200)
    except AlpacaError as exc:
        _log.warning("paper sync: Alpaca fetch failed: %s", exc)
        return

    from .database import get_paper_order_by_alpaca_id  # local import

    updated = 0
    for ao in alpaca_orders:
        order_id = ao.get("id")
        if not order_id:
            continue
        updates: dict = {"status": ao.get("status")}
        filled_qty = ao.get("filled_qty")
        if filled_qty is not None:
            updates["qty"] = float(filled_qty)
        filled_avg = ao.get("filled_avg_price")
        if filled_avg is not None:
            updates["filled_avg_price"] = float(filled_avg)
        filled_at = ao.get("filled_at")
        if filled_at:
            updates["filled_at"] = filled_at

        # Compute realized P&L when a close order fills.
        # Close orders (placed by Instant Cashout) have entry_price stored at
        # placement time and no ``notional`` — opening bracket orders store
        # both, so the ``notional is None`` check keeps entry fills out of the
        # closed-trade totals.  Once Alpaca fills the order we know the actual
        # exit price and can calculate the true P&L.
        if ao.get("status") == "filled" and filled_avg:
            db_order = get_paper_order_by_alpaca_id(order_id)
            if (
                db_order
                and db_order.get("entry_price")
                and db_order.get("notional") is None
                and db_order.get("realized_pnl") is None
            ):
                entry = float(db_order["entry_price"])
                fill = float(filled_avg)
                qty = float(filled_qty or db_order.get("qty") or 0)
                side = db_order.get("side", "sell")
                # sell-to-close: profit when price rose; buy-to-cover: profit when price fell
                direction = 1 if side == "sell" else -1
                updates["realized_pnl"] = round((fill - entry) * qty * direction, 4)

        update_paper_order_status(order_id, updates)
        updated += 1

    _log.info("paper sync: updated %d order(s)", updated)


# --------------------------------------------------------------------------- #
# Fractional position exit poller
# --------------------------------------------------------------------------- #
async def monitor_frac_positions() -> None:
    """Close fractional positions whose price has crossed their stop/target.

    Fractional orders carry no broker-side bracket, so this poller is the only
    exit path.  For each open ``frac_positions`` row it reads the live price
    from the frac Alpaca profile and market-sells the held fraction when price
    ``>= take_profit_price`` (target) or ``<= stop_price`` (stop).  It also
    backfills fill qty/entry and reconciles positions closed externally.

    Runs on its own fast timer (``MonitorScheduler._exit_loop``), independent
    of the scan interval, so stop-losses are honoured within ~60s.
    """
    if get_setting("frac_trading_enabled", "false") != "true":
        return

    from .alpaca import AlpacaError, get_frac_client  # local import — avoids startup cost
    from .database import get_frac_positions, update_frac_position

    open_rows = get_frac_positions(status="open")
    if not open_rows:
        return

    try:
        client = get_frac_client()
        positions = client.get_positions()
    except AlpacaError as exc:
        _log.warning("frac monitor: Alpaca fetch failed: %s", exc)
        return

    by_symbol = {p.get("symbol"): p for p in positions}
    now_iso = datetime.now(get_settings().market_hours.tzinfo).isoformat()
    eod = get_setting("frac_eod_close", "false") == "true" and _near_market_close()
    closed = 0

    for row in open_rows:
        ticker = row["ticker"]
        pos = by_symbol.get(ticker)
        if pos is None:
            # No live position for this row. If we had already seen a fill
            # (qty set) it means the position was closed externally — reconcile.
            # If qty is still null the buy order is merely pending its fill, so
            # leave the row open and try again next cycle.
            if row.get("qty"):
                update_frac_position(
                    row["id"],
                    {"status": "closed", "exit_reason": "reconciled", "closed_at": now_iso},
                )
                closed += 1
            continue

        try:
            current = float(pos.get("current_price") or 0)
            held_qty = float(pos.get("qty") or 0)
            avg_entry = float(pos.get("avg_entry_price") or 0)
        except (TypeError, ValueError):
            continue
        if current <= 0 or held_qty <= 0:
            continue

        # Sync qty / entry from the (merged) Alpaca position every cycle so the
        # row stays accurate as repeat buys accumulate into the same symbol.
        sync: dict[str, Any] = {"qty": held_qty}
        if avg_entry > 0:
            sync["entry_price"] = avg_entry
        update_frac_position(row["id"], sync)
        row["qty"] = held_qty
        if avg_entry > 0:
            row["entry_price"] = avg_entry

        stop = row.get("stop_price")
        target = row.get("take_profit_price")
        exit_reason: str | None = None
        if target is not None and current >= float(target):
            exit_reason = "target"
        elif stop is not None and current <= float(stop):
            exit_reason = "stop"
        elif eod:
            exit_reason = "eod"
        if not exit_reason:
            continue

        try:
            sell = client.place_notional_order(ticker=ticker, side="sell", qty=held_qty)
        except AlpacaError as exc:
            _log.warning("frac monitor: sell failed for %s: %s", ticker, exc)
            continue

        entry = float(row.get("entry_price") or avg_entry or current)
        realized = round((current - entry) * held_qty, 4)
        update_frac_position(
            row["id"],
            {
                "status": "closed",
                "exit_price": current,
                "exit_reason": exit_reason,
                "realized_pnl": realized,
                "alpaca_sell_order_id": sell.get("id"),
                "closed_at": now_iso,
            },
        )
        closed += 1
        _log.info(
            "frac monitor: closed %s @ %.2f (%s) pnl=%.2f", ticker, current, exit_reason, realized
        )

    if closed:
        _log.info("frac monitor: closed %d position(s)", closed)


# --------------------------------------------------------------------------- #
# Discovery cycle helper
# --------------------------------------------------------------------------- #
async def _maybe_run_discovery(sched: MonitorScheduler) -> None:
    """Run a discovery cycle if enabled and the interval has elapsed.

    Called from _loop() after each watchlist scan.  Never raises — errors are
    caught and logged by the caller.
    """
    discovery_enabled = get_setting("discovery_enabled", "false") == "true"
    if not discovery_enabled:
        return

    interval_str = get_setting("discovery_interval_minutes", "")
    from .config import get_settings as _cfg

    interval_min = (
        int(interval_str)
        if interval_str and interval_str.isdigit()
        else _cfg().discovery.interval_minutes
    )
    now = datetime.now(_cfg().market_hours.tzinfo)

    # Check if the next grid-aligned discovery slot has been reached.
    if sched.last_discovery:
        try:
            last_dt = datetime.fromisoformat(sched.last_discovery)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=_cfg().market_hours.tzinfo)
            next_fire = _next_grid_time(last_dt, interval_min * 60)
            if now < next_fire:
                sched.next_discovery = next_fire.isoformat()
                return
        except Exception as _ts_exc:
            _log.debug("discovery: bad last_discovery timestamp, resetting: %s", _ts_exc)

    _log.info("discovery: starting scheduled run (interval=%dm)", interval_min)

    sources = get_setting("discovery_sources", "") or _cfg().discovery.sources
    max_cands = int(get_setting("discovery_max_candidates", "") or _cfg().discovery.max_candidates)
    min_score = int(get_setting("discovery_min_score", "") or _cfg().discovery.min_score)

    run_id = await asyncio.to_thread(save_discovery_run, sources)
    try:
        from .discovery import run_discovery

        candidates = await asyncio.to_thread(run_discovery, sources, max_cands, min_score, None)
        await asyncio.to_thread(save_discovery_candidates, run_id, candidates)
        await asyncio.to_thread(update_discovery_run, run_id, "done", len(candidates))
        sched.last_discovery = now.isoformat()
        sched.next_discovery = _next_grid_time(now, interval_min * 60).isoformat()
        _log.info("discovery: run %d complete — %d candidate(s)", run_id, len(candidates))

        # Auto-scan top-N through the full agent pipeline (no watchlist mutation).
        autoscan = get_setting("discovery_autoscan_enabled", "false") == "true"
        if autoscan and candidates:
            top_n = int(
                get_setting("discovery_autoscan_top_n", "") or _cfg().discovery.autoscan_top_n
            )
            top_tickers = [c.get("ticker", "") for c in candidates[:top_n] if c.get("ticker")]
            _log.info(
                "discovery: auto-scanning %d ticker(s): %s",
                len(top_tickers),
                top_tickers,
            )
            for ticker in top_tickers:
                try:
                    await scan_ticker_async(ticker, send_alerts=True)
                    _log.info("discovery: auto-scan %s done", ticker)
                except Exception as exc:
                    _log.warning("discovery: auto-scan %s failed: %s", ticker, exc)

    except Exception as exc:
        await asyncio.to_thread(update_discovery_run, run_id, "error", 0, str(exc))
        _log.error("discovery: run %d error: %s", run_id, exc)
        raise


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #
class MonitorScheduler:
    """Owns the background scan loop lifecycle."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._exit_task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.last_run: str | None = None
        self.next_run: str | None = None
        self.last_discovery: str | None = None
        self.next_discovery: str | None = None
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
                        now = datetime.now(settings.market_hours.tzinfo)
                        self.last_run = now.isoformat()
                        total = sum(len(r.get("actionable", [])) for r in results)
                        _log.info("scan complete — %d actionable signal(s)", total)
                    except Exception as exc:  # pragma: no cover - defensive
                        _log.error("scan error: %s", exc)
                    # Sync paper order statuses after each watchlist scan.
                    try:
                        await sync_paper_orders()
                    except Exception as exc:  # pragma: no cover - defensive
                        _log.warning("paper sync error: %s", exc)
                    # Discovery cycle — runs after watchlist scan when market is open.
                    try:
                        await _maybe_run_discovery(self)
                    except Exception as exc:  # pragma: no cover - defensive
                        _log.warning("discovery cycle error: %s", exc)
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
                now = datetime.now(settings.market_hours.tzinfo)
                next_fire = _next_grid_time(now, interval_seconds)
                self.next_run = next_fire.isoformat()
                sleep_for = max(1.0, (next_fire - now).total_seconds())
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=sleep_for)
                except asyncio.TimeoutError:
                    pass
        finally:
            self.running = False
            _log.info("stopped")

    async def _exit_loop(self) -> None:
        """Fast poller dedicated to fractional stop/target exits.

        Independent of the (slow) scan interval so stop-losses are honoured
        within ~60s.  ``monitor_frac_positions`` gates itself on market hours
        (via the caller) and the ``frac_trading_enabled`` setting.
        """
        while not self._stop.is_set():
            if is_market_open():
                try:
                    await monitor_frac_positions()
                except Exception as exc:  # pragma: no cover - defensive
                    _log.warning("frac monitor error: %s", exc)
            db_poll = get_setting("frac_poll_seconds", "")
            poll_seconds = max(
                30,
                int(db_poll) if db_poll and db_poll.isdigit() else get_settings().frac.poll_seconds,
            )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=poll_seconds)
            except asyncio.TimeoutError:
                pass

    def start(self) -> None:
        """Start the loop if it is not already running."""
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop())
        self._exit_task = asyncio.create_task(self._exit_loop())

    async def stop(self) -> None:
        """Signal the loop to stop and wait for it to finish."""
        self._stop.set()
        for task in (self._task, self._exit_task):
            if task:
                try:
                    await task
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
            "next_run": self.next_run,
            "scan_interval_minutes": effective_interval,
            "watchlist": get_effective_watchlist(),
            "last_discovery": self.last_discovery,
            "next_discovery": self.next_discovery,
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
