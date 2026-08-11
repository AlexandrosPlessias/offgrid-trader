"""Market-data acquisition layer.

Combines two free/local data sources into a single dictionary that is ready
to be handed to the AI prompt builder:

* **yfinance** — spot price, daily change, volume, moving averages (MA5/MA20),
  52-week high/low and a few fundamentals.
* **tradingview-ta** — RSI, MACD, EMA20/50/200, Bollinger Bands and Stochastic
  across the 1H, 4H and 1D timeframes.

Everything is wrapped in defensive error handling so a failure in one source
(or one timeframe) never takes down the whole scan; partial results are
returned with an ``errors`` list describing what went wrong.

Run standalone::

    python -m backend.data AAPL
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# yfinance exchange code -> TradingView exchange name mapping.
# --------------------------------------------------------------------------- #
_YF_TO_TV_EXCHANGE: Dict[str, str] = {
    "NMS": "NASDAQ",
    "NGM": "NASDAQ",
    "NCM": "NASDAQ",
    "NAS": "NASDAQ",
    "NYQ": "NYSE",
    "NYE": "NYSE",
    "PCX": "AMEX",  # NYSE Arca (ETFs such as SPY resolve to AMEX on TradingView)
    "ASE": "AMEX",
    "BATS": "AMEX",
}

# Fallback order when the exchange cannot be inferred from yfinance.
_DEFAULT_TV_EXCHANGES: List[str] = ["NASDAQ", "NYSE", "AMEX"]

_TIMEFRAMES = ("1H", "4H", "1D")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        result = float(value)
        # yfinance sometimes returns NaN.
        if result != result:  # noqa: PLR0124 - NaN check
            return None
        return result
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# yfinance
# --------------------------------------------------------------------------- #
def fetch_yfinance(ticker: str) -> Dict[str, Any]:
    """Fetch price/volume/fundamentals for *ticker* from yfinance.

    Returns a dict with ``price``, ``fundamentals`` and an ``exchange_hint``
    used to help TradingView resolve the correct exchange. Raises nothing:
    failures are surfaced via the ``error`` key.
    """

    import yfinance as yf

    result: Dict[str, Any] = {"price": {}, "fundamentals": {}, "exchange_hint": None}
    _log.info("yfinance ▶ %s", ticker)
    try:
        yf_ticker = yf.Ticker(ticker)

        # Historical window for moving averages and average volume.
        history = yf_ticker.history(period="3mo", interval="1d")
        closes = [c for c in history["Close"].tolist() if c == c] if not history.empty else []
        volumes = [v for v in history["Volume"].tolist() if v == v] if not history.empty else []

        ma5 = round(sum(closes[-5:]) / len(closes[-5:]), 4) if len(closes) >= 5 else None
        ma20 = round(sum(closes[-20:]) / len(closes[-20:]), 4) if len(closes) >= 20 else None
        avg_volume = (
            round(sum(volumes[-20:]) / len(volumes[-20:]), 2) if len(volumes) >= 1 else None
        )

        # Prefer the lightweight fast_info accessor, fall back to history.
        fast = getattr(yf_ticker, "fast_info", None)

        def _fi(key: str) -> Optional[float]:
            if fast is None:
                return None
            try:
                return _safe_float(fast[key])
            except (KeyError, TypeError):
                return _safe_float(getattr(fast, key, None))

        current = _fi("last_price") or (closes[-1] if closes else None)
        previous_close = _fi("previous_close") or (closes[-2] if len(closes) >= 2 else None)
        volume = _fi("last_volume") or (volumes[-1] if volumes else None)

        change = None
        change_pct = None
        if current is not None and previous_close:
            change = round(current - previous_close, 4)
            change_pct = round((current - previous_close) / previous_close * 100, 4)

        volume_ratio = None
        if volume and avg_volume:
            volume_ratio = round(volume / avg_volume, 3)

        result["price"] = {
            "current": _safe_float(current),
            "previous_close": _safe_float(previous_close),
            "change": change,
            "change_pct": change_pct,
            "volume": _safe_float(volume),
            "avg_volume": avg_volume,
            "volume_ratio": volume_ratio,
            "ma5": ma5,
            "ma20": ma20,
            "day_high": _fi("day_high"),
            "day_low": _fi("day_low"),
            "week52_high": _fi("year_high"),
            "week52_low": _fi("year_low"),
        }

        # Fundamentals: guard the (slow, sometimes-flaky) .info call.
        info: Dict[str, Any] = {}
        try:
            info = yf_ticker.info or {}
        except Exception:  # pragma: no cover - network/parse issues
            info = {}

        result["fundamentals"] = {
            "name": info.get("shortName") or info.get("longName") or ticker,
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "market_cap": _safe_float(info.get("marketCap")),
            "pe_ratio": _safe_float(info.get("trailingPE")),
        }

        # Resolve the exchange hint for TradingView.
        yf_exchange = (info.get("exchange") or getattr(fast, "exchange", None) or "").upper()
        result["exchange_hint"] = _YF_TO_TV_EXCHANGE.get(yf_exchange)
    except Exception as exc:  # pragma: no cover - network dependent
        result["error"] = f"yfinance error: {exc}"
        _log.warning("yfinance ✗ %s: %s", ticker, exc)
        return result
    price = result.get("price", {})
    _log.info(
        "yfinance ◀ %s price=%s change_pct=%s vol_ratio=%s",
        ticker,
        price.get("current"),
        price.get("change_pct"),
        price.get("volume_ratio"),
    )
    return result


# --------------------------------------------------------------------------- #
# tradingview-ta
# --------------------------------------------------------------------------- #
def _tv_intervals() -> Dict[str, Any]:
    from tradingview_ta import Interval

    return {
        "1H": Interval.INTERVAL_1_HOUR,
        "4H": Interval.INTERVAL_4_HOURS,
        "1D": Interval.INTERVAL_1_DAY,
    }


def _parse_tv_indicators(indicators: Dict[str, Any], recommendation: Optional[str]) -> Dict[str, Any]:
    """Normalise the raw tradingview-ta indicator dict into our schema."""

    macd = _safe_float(indicators.get("MACD.macd"))
    macd_signal = _safe_float(indicators.get("MACD.signal"))
    histogram = round(macd - macd_signal, 5) if macd is not None and macd_signal is not None else None

    return {
        "close": _safe_float(indicators.get("close")),
        "RSI": _safe_float(indicators.get("RSI")),
        "MACD": {"macd": macd, "signal": macd_signal, "histogram": histogram},
        "EMA20": _safe_float(indicators.get("EMA20")),
        "EMA50": _safe_float(indicators.get("EMA50")),
        "EMA200": _safe_float(indicators.get("EMA200")),
        "BollingerBands": {
            "upper": _safe_float(indicators.get("BB.upper")),
            "middle": _safe_float(indicators.get("SMA20")),
            "lower": _safe_float(indicators.get("BB.lower")),
        },
        "Stochastic": {
            "k": _safe_float(indicators.get("Stoch.K")),
            "d": _safe_float(indicators.get("Stoch.D")),
        },
        "recommendation": recommendation,
    }


def fetch_tradingview(
    ticker: str,
    exchange_hint: Optional[str] = None,
    screener: str = "america",
) -> Dict[str, Any]:
    """Fetch multi-timeframe technicals for *ticker* from tradingview-ta.

    Returns ``{"technicals": {"1H": {...}, "4H": {...}, "1D": {...}},
    "errors": [...]}``. Each timeframe is fetched independently; the exchange
    is auto-detected by trying the hinted exchange first, then a fallback list.
    """

    from tradingview_ta import TA_Handler

    intervals = _tv_intervals()
    candidates: List[str] = []
    if exchange_hint:
        candidates.append(exchange_hint)
    candidates.extend(e for e in _DEFAULT_TV_EXCHANGES if e not in candidates)

    technicals: Dict[str, Any] = {}
    errors: List[str] = []
    resolved_exchange: Optional[str] = None

    for label, interval in intervals.items():
        analysis = None
        last_error: Optional[str] = None
        # Once an exchange resolves, reuse it for the remaining timeframes.
        try_exchanges = [resolved_exchange] if resolved_exchange else candidates
        _log.info("tradingview ▶ %s %s exchanges=%s", ticker, label, try_exchanges)
        for exchange in try_exchanges:
            try:
                handler = TA_Handler(
                    symbol=ticker,
                    screener=screener,
                    exchange=exchange,
                    interval=interval,
                )
                analysis = handler.get_analysis()
                resolved_exchange = exchange
                break
            except Exception as exc:  # try the next candidate exchange
                last_error = f"{exchange}: {exc}"
                continue

        if analysis is None:
            errors.append(f"tradingview {label} failed ({last_error})")
            _log.warning("tradingview ✗ %s %s: %s", ticker, label, last_error)
            technicals[label] = None
            continue

        recommendation = None
        try:
            recommendation = analysis.summary.get("RECOMMENDATION")
        except Exception:
            recommendation = None
        technicals[label] = _parse_tv_indicators(analysis.indicators or {}, recommendation)
        _log.info(
            "tradingview ◀ %s %s exchange=%s rec=%s",
            ticker, label, resolved_exchange, recommendation,
        )

    return {"technicals": technicals, "exchange": resolved_exchange, "errors": errors}


# --------------------------------------------------------------------------- #
# Unified market-data assembler
# --------------------------------------------------------------------------- #
def get_market_data(ticker: str) -> Dict[str, Any]:
    """Return the unified market-data dict for *ticker*.

    The shape is stable even when data sources fail; missing values are
    ``None`` and problems are collected in ``errors``.
    """

    ticker = ticker.strip().upper()
    _log.info("market_data ▶ %s", ticker)
    errors: List[str] = []

    yf_data = fetch_yfinance(ticker)
    if "error" in yf_data:
        errors.append(yf_data["error"])

    tv_data = fetch_tradingview(ticker, exchange_hint=yf_data.get("exchange_hint"))
    errors.extend(tv_data.get("errors", []))

    result = {
        "ticker": ticker,
        "timestamp": _now_iso(),
        "price": yf_data.get("price", {}),
        "fundamentals": yf_data.get("fundamentals", {}),
        "exchange": tv_data.get("exchange"),
        "technicals": tv_data.get("technicals", {tf: None for tf in _TIMEFRAMES}),
        "errors": errors,
    }
    _log.info("market_data ◀ %s errors=%d", ticker, len(errors))
    return result


if __name__ == "__main__":
    import json
    import sys

    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    print(json.dumps(get_market_data(symbol), indent=2, default=str))
