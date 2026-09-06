"""Trending ticker discovery — candidate fetching and deterministic scoring.

Two entry points for external callers:

* :func:`fetch_candidates` — pull raw tickers from Alpaca screener and/or
  yfinance predefined screeners, normalise, deduplicate, and cache 60 min.
* :func:`score_candidate` — compute a deterministic 0-100 score reusing the
  existing :func:`~backend.data.compute_indicators` stack (per-day cached).
* :func:`run_discovery` — orchestrate: fetch → cull to max_candidates →
  score → filter by min_score → sort by score descending.

Alpaca screener is tried first when credentials are present; on AlpacaError
(including HTTP 403 if the endpoint is not available on the free tier) the
call falls back to yfinance predefined screeners transparently.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

_log = logging.getLogger(__name__)

# Predefined yfinance screener queries used as the fallback source.
_YFINANCE_SCREENERS = ["day_gainers", "most_actives", "day_losers", "small_cap_gainers"]


# --------------------------------------------------------------------------- #
# Rate-limiter — mirrors _RpmThrottle from backend.backtest
# --------------------------------------------------------------------------- #
class _Throttle:
    """Thread-safe fixed-interval rate limiter for indicator fetch calls."""

    def __init__(self, rpm: int | None) -> None:
        self._interval = (60.0 / rpm) if rpm else None
        self._last: float = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        if not self._interval:
            return
        with self._lock:
            now = time.monotonic()
            gap = self._interval - (now - self._last)
            if gap > 0:
                time.sleep(gap)
            self._last = time.monotonic()


# 10 indicator fetches/minute — conservative to avoid yfinance 429s.
_indicator_throttle = _Throttle(rpm=10)


# --------------------------------------------------------------------------- #
# Candidate fetching
# --------------------------------------------------------------------------- #
def _fetch_from_alpaca(top: int) -> list[dict[str, Any]]:
    """Return raw candidates from the Alpaca screener API.

    Returns an empty list (and logs a warning) on any AlpacaError so the
    caller can fall back to yfinance seamlessly.
    """
    from .alpaca import AlpacaError, get_client
    from .database import get_setting

    # Skip Alpaca entirely if no credentials are configured.
    if not (get_setting("alpaca_key_id", "") or ""):
        _log.debug("discovery: Alpaca key not configured — skipping")
        return []

    results: list[dict[str, Any]] = []
    client = get_client()

    # Most-actives by volume
    try:
        actives = client.get_most_actives(top=min(top, 50))
        for item in actives:
            sym = (item.get("symbol") or "").upper()
            if sym:
                results.append(
                    {
                        "symbol": sym,
                        "price": None,
                        "percent_change": None,
                        "volume": item.get("volume"),
                        "source": "alpaca_actives",
                    }
                )
    except AlpacaError as exc:
        _log.warning("discovery: Alpaca most-actives failed (%s) — falling back to yfinance", exc)
        return []  # early return; skip movers too so yfinance fills both

    # Top gainers/losers
    try:
        movers = client.get_movers(top=min(top, 25))
        for item in movers.get("gainers", []):
            sym = (item.get("symbol") or "").upper()
            if sym:
                results.append(
                    {
                        "symbol": sym,
                        "price": item.get("price"),
                        "percent_change": item.get("percent_change"),
                        "volume": None,
                        "source": "alpaca_gainers",
                    }
                )
        for item in movers.get("losers", []):
            sym = (item.get("symbol") or "").upper()
            if sym:
                results.append(
                    {
                        "symbol": sym,
                        "price": item.get("price"),
                        "percent_change": item.get("percent_change"),
                        "volume": None,
                        "source": "alpaca_losers",
                    }
                )
    except AlpacaError as exc:
        _log.warning("discovery: Alpaca movers failed (%s) — using actives only", exc)

    return results


def _fetch_from_yfinance(screeners: list[str] | None = None) -> list[dict[str, Any]]:
    """Return raw candidates from yfinance predefined screeners."""
    try:
        import yfinance as yf
    except ImportError:
        _log.error("discovery: yfinance not installed")
        return []

    targets = screeners if screeners is not None else _YFINANCE_SCREENERS
    results: list[dict[str, Any]] = []
    for name in targets:
        try:
            data = yf.screen(name)
            for item in data.get("quotes") or []:
                sym = (item.get("symbol") or "").upper()
                if sym:
                    results.append(
                        {
                            "symbol": sym,
                            "price": item.get("regularMarketPrice"),
                            "percent_change": item.get("regularMarketChangePercent"),
                            "volume": item.get("regularMarketVolume"),
                            "source": f"yf_{name}",
                        }
                    )
        except Exception as exc:
            _log.warning("discovery: yf.screen(%r) failed: %s", name, exc)
    return results


def _dedupe(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate by symbol, keeping the first occurrence (highest priority source)."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for c in candidates:
        sym = c.get("symbol", "")
        if sym and sym not in seen:
            seen.add(sym)
            out.append(c)
    return out


def fetch_candidates(
    sources: str = "alpaca,yfinance",
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Fetch and normalise raw candidate tickers from the configured sources.

    Results are cached ~60 min keyed by ``discovery:candidates:{YYYY-MM-DD-HH}``.
    Returns a list of ``{symbol, price, percent_change, volume, source}`` dicts.
    """
    from .data import _cache_get, _cache_set

    now = datetime.now(timezone.utc)
    cache_key = f"discovery:candidates:{now.strftime('%Y-%m-%d-%H')}"
    cached = _cache_get(cache_key, ttl_minutes=60)
    if cached is not None:
        _log.info("discovery: candidates ◀ cache hit (%d items)", len(cached))
        return cached

    source_list = [s.strip().lower() for s in sources.split(",") if s.strip()]
    raw: list[dict[str, Any]] = []

    used_yf_fallback = False
    if "alpaca" in source_list:
        alpaca_results = _fetch_from_alpaca(top=limit)
        if alpaca_results:
            raw.extend(alpaca_results)
        else:
            # Alpaca unavailable — always fall back to yfinance
            _log.info("discovery: Alpaca returned nothing — using yfinance fallback")
            raw.extend(_fetch_from_yfinance())
            used_yf_fallback = True

    if "yfinance" in source_list and not used_yf_fallback:
        raw.extend(_fetch_from_yfinance())

    candidates = _dedupe(raw)[:limit]
    _cache_set(cache_key, candidates)
    _log.info("discovery: fetched %d candidates (sources=%s)", len(candidates), sources)
    return candidates


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def score_candidate(ticker: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """Compute a deterministic 0-100 discovery score for *ticker*.

    Component breakdown
    -------------------
    momentum (0-30)  — |percent_change|, linearly mapped, capped at ±10 %
    volume   (0-25)  — snapshot volume linearly mapped up to 25 M shares
    trend    (0-25)  — price vs EMA20/EMA50 alignment on the 1D timeframe
    rsi_macd (0-20)  — RSI in constructive zone + MACD above signal across 3 TFs

    ``snapshot`` is a ``{symbol, price, percent_change, volume, source}`` dict
    from :func:`fetch_candidates`.  Missing fields default to 0 / skipped.
    """
    from .data import compute_indicators

    _indicator_throttle.wait()

    try:
        indicators = compute_indicators(ticker)
    except Exception as exc:
        _log.warning("discovery: compute_indicators(%s) failed: %s", ticker, exc)
        return {"score": 0.0, "reasons": [f"indicator error: {exc}"], "components": {}}

    technicals = indicators.get("technicals") or {}
    reasons: list[str] = []
    components: dict[str, float] = {}

    # ── 1. Momentum (0-30) ─────────────────────────────────────────────────
    pct_chg = float(snapshot.get("percent_change") or 0.0)
    mom_raw = min(abs(pct_chg), 10.0)  # cap at 10 %
    momentum_score = round(mom_raw / 10.0 * 30, 1)
    components["momentum"] = momentum_score
    if abs(pct_chg) >= 3.0:
        direction = "up" if pct_chg > 0 else "down"
        reasons.append(f"Strong move {pct_chg:+.1f}% today ({direction})")

    # ── 2. Volume (0-25) ───────────────────────────────────────────────────
    volume_score = 0.0
    vol = int(snapshot.get("volume") or 0)
    if vol > 0:
        vol_m = vol / 1_000_000  # convert to millions
        # Score linearly up to 25 M shares traded
        volume_score = round(min(vol_m / 25.0, 1.0) * 25, 1)
        if vol_m >= 5:
            reasons.append(f"High volume: {vol_m:.1f}M shares")
    components["volume"] = volume_score

    # ── 3. Trend alignment (0-25) ──────────────────────────────────────────
    trend_score = 0.0
    try:
        td_1d = technicals.get("1D") or {}
        price = float(snapshot.get("price") or 0)
        ema20 = td_1d.get("EMA20")
        ema50 = td_1d.get("EMA50")
        if price and ema20 and ema50:
            ema20_f = float(ema20)
            ema50_f = float(ema50)
            if price > ema20_f:
                trend_score += 10
                reasons.append("Price above EMA20 (uptrend)")
            if ema20_f > ema50_f:
                trend_score += 10
                reasons.append("EMA20 above EMA50 (bullish alignment)")
            rec = (td_1d.get("recommendation") or "").lower()
            if rec in ("buy", "strong_buy"):
                trend_score += 5
                reasons.append(f"1D recommendation: {rec}")
    except Exception as exc:
        _log.debug("discovery: trend score failed for %s: %s", ticker, exc)
    components["trend"] = round(trend_score, 1)

    # ── 4. RSI / MACD multi-timeframe (0-20) ───────────────────────────────
    rsi_macd_score = 0.0
    try:
        bullish_signals = 0.0
        for tf in ("1H", "4H", "1D"):
            td = technicals.get(tf) or {}
            rsi = td.get("RSI")
            macd_d = td.get("MACD") or {}
            macd_val = macd_d.get("macd")
            macd_sig = macd_d.get("signal")
            # RSI in constructive zone (not oversold / not overbought)
            if rsi is not None and 40.0 <= float(rsi) <= 70.0:
                bullish_signals += 0.5
            # MACD histogram positive (momentum building)
            if macd_val is not None and macd_sig is not None:
                if float(macd_val) > float(macd_sig):
                    bullish_signals += 0.5
        # Max possible: 3 TFs x (0.5 RSI + 0.5 MACD) = 3.0
        rsi_macd_score = round(min(bullish_signals / 3.0, 1.0) * 20, 1)
        if bullish_signals >= 2.0:
            reasons.append(f"RSI/MACD aligned bullish ({bullish_signals:.1f}/3 timeframes)")
    except Exception as exc:
        _log.debug("discovery: rsi_macd score failed for %s: %s", ticker, exc)
    components["rsi_macd"] = rsi_macd_score

    total = round(momentum_score + volume_score + trend_score + rsi_macd_score, 1)
    total = max(0.0, min(100.0, total))

    return {
        "score": total,
        "reasons": reasons,
        "components": components,
    }


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #
def run_discovery(
    sources: str = "alpaca,yfinance",
    max_candidates: int = 25,
    min_score: int = 60,
    progress_callback: Any = None,
) -> list[dict[str, Any]]:
    """Fetch → cull → score → filter → sort candidates.

    ``progress_callback``, if given, is called as ``callback(step, message)``
    for each major stage so SSE endpoints can stream progress events.

    Returns candidates sorted by score descending.  The min_score filter is
    applied; if no candidates clear the floor the full sorted list is returned
    (so the caller always gets *something* to display).
    """
    if progress_callback:
        progress_callback("fetch", f"Fetching candidates from: {sources}")

    raw = fetch_candidates(sources=sources, limit=max_candidates * 2)

    if not raw:
        _log.warning("discovery: no candidates fetched from sources=%s", sources)
        if progress_callback:
            progress_callback("done", "No candidates found")
        return []

    # Cull before scoring to bound indicator fetches
    culled = raw[:max_candidates]

    if progress_callback:
        progress_callback("score", f"Scoring {len(culled)} candidates…")

    scored: list[dict[str, Any]] = []
    for candidate in culled:
        ticker = candidate.get("symbol", "")
        if not ticker:
            continue
        try:
            scoring = score_candidate(ticker, candidate)
        except Exception as exc:
            _log.warning("discovery: score_candidate(%s) error: %s", ticker, exc)
            scoring = {"score": 0.0, "reasons": [], "components": {}}

        entry = {**candidate, "ticker": ticker, **scoring}
        scored.append(entry)
        _log.debug(
            "discovery: %s score=%.1f reasons=%s",
            ticker,
            scoring["score"],
            scoring.get("reasons", []),
        )

    # Sort by score descending
    scored.sort(key=lambda x: x.get("score", 0.0), reverse=True)

    # Apply min_score filter; fall back to all results if none qualify
    above = [c for c in scored if c.get("score", 0.0) >= min_score]
    result = above if above else scored

    if progress_callback:
        progress_callback(
            "done",
            f"Found {len(result)} candidate(s) (min_score={min_score})",
        )

    _log.info(
        "discovery: run complete — %d/%d candidates above score %d",
        len(above),
        len(scored),
        min_score,
    )
    return result
