"""MemoryLayer — per-ticker persistent context for the TickerAgent.

Each ticker gets one row in the ``ticker_memory`` table (see database.py).
After every agent run the layer updates the row with key facts from the
completed scan; on the next run those facts are loaded into ``AgentContext``
and injected into the AI prompt as a ``PRIOR CONTEXT`` section.

Memories older than ``MEMORY_TTL_HOURS`` are treated as expired and ignored
so stale context never misleads the model after a long gap between scans.

Usage::

    from backend.memory import MemoryLayer

    _memory = MemoryLayer()

    # Load before run
    mem = _memory.load("AAPL")          # -> dict | {}

    # Update after run
    _memory.update("AAPL", ctx)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from backend.skills import AgentContext

_log = logging.getLogger(__name__)

MEMORY_TTL_HOURS: float = 48.0


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _age_hours(last_scan_iso: Optional[str]) -> float:
    """Return hours since *last_scan_iso* (UTC ISO-8601), or ∞ if absent."""
    if not last_scan_iso:
        return float("inf")
    try:
        ts = datetime.fromisoformat(last_scan_iso.replace("Z", "+00:00"))
        return (_now_utc() - ts).total_seconds() / 3600
    except ValueError:
        return float("inf")


class MemoryLayer:
    """Load and persist per-ticker agent memory via the ``ticker_memory`` table."""

    def load(self, ticker: str) -> dict:
        """Return the stored memory dict for *ticker*, or ``{}`` if absent/expired."""
        from backend.database import get_ticker_memory

        try:
            row = get_ticker_memory(ticker)
        except Exception:  # noqa: BLE001
            _log.debug("memory.load: DB error for %s", ticker, exc_info=True)
            return {}

        if not row:
            return {}

        age = _age_hours(row.get("last_scan"))
        if age > MEMORY_TTL_HOURS:
            _log.debug("memory.load: expired (%.1fh > %.0fh) for %s", age, MEMORY_TTL_HOURS, ticker)
            return {}

        return dict(row)

    def update(self, ticker: str, ctx: "AgentContext") -> None:
        """Persist updated memory after a completed agent run.

        Derives values from the finished ``AgentContext``:

        - ``last_signal`` / ``last_confidence`` from the first actionable opp
        - ``consecutive_oversold`` / ``consecutive_overbought`` from RSI across
          timeframes in market_data
        - ``last_price`` and ``price_trend_pct`` from price data
        """
        from backend.database import upsert_ticker_memory

        try:
            prev = self.load(ticker)

            # Signal from the highest-confidence actionable opportunity.
            last_signal: Optional[str] = None
            last_confidence: Optional[float] = None
            if ctx.actionable:
                top = max(ctx.actionable, key=lambda o: o.get("confidence", 0))
                last_signal = top.get("type")
                last_confidence = top.get("confidence")

            # Price.
            last_price: Optional[float] = None
            price_trend_pct: Optional[float] = None
            if ctx.market_data:
                last_price = (ctx.market_data.get("price") or {}).get("current")
                prev_price = prev.get("last_price")
                if last_price and prev_price:
                    price_trend_pct = round(
                        (last_price - prev_price) / prev_price * 100, 2
                    )

            # RSI streak — count timeframes currently at extremes.
            oversold = 0
            overbought = 0
            if ctx.market_data:
                from backend.config import get_settings
                th = get_settings().thresholds
                for tf_data in (ctx.market_data.get("technicals") or {}).values():
                    rsi = tf_data.get("RSI")
                    if rsi is None:
                        continue
                    if rsi <= th.rsi_oversold:
                        oversold += 1
                    elif rsi >= th.rsi_overbought:
                        overbought += 1

            # Accumulate consecutive streaks (reset when no longer at extreme).
            prev_oversold = int(prev.get("consecutive_oversold") or 0)
            prev_overbought = int(prev.get("consecutive_overbought") or 0)
            consecutive_oversold = (prev_oversold + oversold) if oversold else 0
            consecutive_overbought = (prev_overbought + overbought) if overbought else 0

            upsert_ticker_memory(
                ticker,
                last_scan=_now_utc().isoformat(),
                last_signal=last_signal,
                last_confidence=last_confidence,
                consecutive_oversold=consecutive_oversold,
                consecutive_overbought=consecutive_overbought,
                last_price=last_price,
                price_trend_pct=price_trend_pct,
            )
            _log.debug("memory.update: saved for %s", ticker)

        except Exception:  # noqa: BLE001
            _log.exception("memory.update: failed for %s — continuing", ticker)

    def clear(self, ticker: str) -> bool:
        """Delete the memory row for *ticker*. Returns True if a row was removed."""
        from backend.database import delete_ticker_memory

        try:
            return delete_ticker_memory(ticker)
        except Exception:  # noqa: BLE001
            _log.exception("memory.clear: failed for %s", ticker)
            return False

    def format_prompt_section(self, memory: dict) -> str:
        """Render memory as a ``PRIOR CONTEXT`` block for the AI prompt.

        Returns an empty string when memory is empty or the last scan is
        older than ``MEMORY_TTL_HOURS``.
        """
        if not memory:
            return ""

        age = _age_hours(memory.get("last_scan"))
        if age > MEMORY_TTL_HOURS:
            return ""

        age_str = (
            f"{int(age * 60)}m ago" if age < 1 else f"{age:.1f}h ago"
        )

        lines = [f"PRIOR CONTEXT (from last scan {age_str}):"]

        sig = memory.get("last_signal")
        conf = memory.get("last_confidence")
        if sig and conf is not None:
            lines.append(f"  Last signal: {sig.upper()}, confidence {conf:.0f}")

        oversold = int(memory.get("consecutive_oversold") or 0)
        overbought = int(memory.get("consecutive_overbought") or 0)
        if oversold:
            lines.append(f"  RSI oversold: {oversold} consecutive reading(s)")
        if overbought:
            lines.append(f"  RSI overbought: {overbought} consecutive reading(s)")

        trend = memory.get("price_trend_pct")
        if trend is not None:
            direction = "↑" if trend >= 0 else "↓"
            lines.append(f"  Price since last scan: {direction}{abs(trend):.2f}%")

        return "\n".join(lines)
