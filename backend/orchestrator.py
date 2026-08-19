"""Orchestrator — prioritised multi-ticker dispatch with concurrency control.

The orchestrator sorts the watchlist by how long ago each ticker was last
scanned (stalest first) and runs them concurrently, capped at
``max_concurrent`` simultaneous agents via an ``asyncio.Semaphore``.

This ensures:

* Tickers that haven't been scanned yet always go first (priority = ∞).
* When all tickers have recent scans, the one scanned longest ago is next.
* At most ``max_concurrent`` Ollama calls are in-flight simultaneously,
  preventing overload on machines with limited VRAM.

Usage::

    from backend.orchestrator import Orchestrator
    from backend.memory import MemoryLayer

    _memory = MemoryLayer()
    _orch   = Orchestrator(memory=_memory, max_concurrent=3)

    results = await _orch.scan_watchlist(["AAPL", "MSFT", "NVDA"])
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.memory import MemoryLayer

_log = logging.getLogger(__name__)


def _age_hours(last_scan_iso: str | None) -> float:
    """Return hours since *last_scan_iso*, or ∞ if absent/unparseable."""
    if not last_scan_iso:
        return float("inf")
    try:
        ts = datetime.fromisoformat(last_scan_iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ts).total_seconds() / 3600
    except ValueError:
        return float("inf")


class Orchestrator:
    """Coordinate a multi-ticker scan with priority ordering and concurrency cap.

    Args:
        memory:         :class:`~backend.memory.MemoryLayer` instance used to
                        read per-ticker scan timestamps for priority sorting.
        max_concurrent: Maximum number of :class:`~backend.agent.TickerAgent`
                        instances that may run simultaneously.  Default ``3``
                        balances throughput with Ollama VRAM pressure.
    """

    def __init__(self, *, memory: "MemoryLayer", max_concurrent: int = 3) -> None:
        self._memory = memory
        self._sem = asyncio.Semaphore(max_concurrent)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def priority(self, ticker: str) -> float:
        """Higher score = scan sooner.  Currently: hours since last scan."""
        mem = self._memory.load(ticker)
        return _age_hours(mem.get("last_scan"))

    async def scan_watchlist(
        self,
        tickers: list[str],
        *,
        send_alerts: bool = True,
    ) -> list[dict[str, Any]]:
        """Scan all *tickers*, stalest first, with concurrency limited by semaphore.

        Returns a list of result dicts in the order tickers completed
        (not necessarily input order).
        """
        ordered = sorted(tickers, key=self.priority, reverse=True)
        _log.info(
            "orchestrator: scanning %d ticker(s) — order: %s",
            len(ordered),
            ", ".join(ordered),
        )
        tasks = [self._run_bounded(t, send_alerts=send_alerts) for t in ordered]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        out: list[dict[str, Any]] = []
        for ticker, res in zip(ordered, results, strict=True):
            if isinstance(res, Exception):
                _log.error("orchestrator: unhandled error for %s: %s", ticker, res)
                out.append({"ticker": ticker, "errors": [str(res)]})
            else:
                out.append(res)  # type: ignore[arg-type]
        return out

    async def run_ticker(
        self,
        ticker: str,
        *,
        send_alerts: bool = True,
    ) -> dict[str, Any]:
        """Run a single ticker through the agent pipeline.

        Convenience wrapper used by the SSE endpoint and ``POST /analyze``.
        Does NOT acquire the concurrency semaphore — single-ticker runs are
        always allowed through immediately.
        """
        from backend.agent import TickerAgent

        result = await TickerAgent(ticker, memory=self._memory, send_alerts=send_alerts).run()
        return result.to_dict()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _run_bounded(self, ticker: str, *, send_alerts: bool) -> dict[str, Any]:
        """Acquire the semaphore then run the agent."""
        from backend.agent import TickerAgent

        async with self._sem:
            _log.debug("orchestrator: slot acquired for %s", ticker)
            result = await TickerAgent(ticker, memory=self._memory, send_alerts=send_alerts).run()
            return result.to_dict()
