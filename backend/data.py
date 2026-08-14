"""Market-data acquisition layer.

Combines free/local data sources into a single dictionary ready for the AI
prompt builder:

* **yfinance** — spot price, daily change, volume, moving averages (MA5/MA20),
  52-week high/low and a few fundamentals.
* **yfinance + ta** — RSI, MACD, EMA20/50/200, Bollinger Bands and Stochastic
  across the 1H, 4H and 1D timeframes, computed locally from OHLCV history.
* **Finnhub** (optional) — recent news headlines, gated by ``FINNHUB_API_KEY``.

Everything is wrapped in defensive error handling so a failure in one source
(or one timeframe) never takes down the whole scan; partial results are
returned with an ``errors`` list describing what went wrong.

Run standalone::

    python -m backend.data AAPL
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

# Exchange display mapping: yfinance exchange code → readable name.
_YF_TO_EXCHANGE: Dict[str, str] = {
    "NMS": "NASDAQ",
    "NGM": "NASDAQ",
    "NCM": "NASDAQ",
    "NAS": "NASDAQ",
    "NYQ": "NYSE",
    "NYE": "NYSE",
    "PCX": "AMEX",
    "ASE": "AMEX",
    "BATS": "AMEX",
}

_TIMEFRAMES = ("1H", "4H", "1D")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        result = float(value)
        if result != result:  # noqa: PLR0124 - NaN check
            return None
        return result
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# yfinance — price / fundamentals
# --------------------------------------------------------------------------- #
def fetch_yfinance(ticker: str) -> Dict[str, Any]:
    """Fetch price/volume/fundamentals for *ticker* from yfinance.

    Returns a dict with ``price``, ``fundamentals`` and an ``exchange_hint``
    for display. Raises nothing: failures are surfaced via the ``error`` key.
    """

    import yfinance as yf

    result: Dict[str, Any] = {
        "price": {}, "fundamentals": {}, "exchange_hint": None,
    }
    _log.info("yfinance ▶ %s", ticker)
    try:
        yf_ticker = yf.Ticker(ticker)

        # Historical window for moving averages and average volume.
        history = yf_ticker.history(period="3mo", interval="1d")
        closes = (
            [c for c in history["Close"].tolist() if c == c]
            if not history.empty else []
        )
        volumes = (
            [v for v in history["Volume"].tolist() if v == v]
            if not history.empty else []
        )

        ma5 = (
            round(sum(closes[-5:]) / len(closes[-5:]), 4)
            if len(closes) >= 5 else None
        )
        ma20 = (
            round(sum(closes[-20:]) / len(closes[-20:]), 4)
            if len(closes) >= 20 else None
        )
        avg_volume = (
            round(sum(volumes[-20:]) / len(volumes[-20:]), 2)
            if len(volumes) >= 1 else None
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
        previous_close = (
            _fi("previous_close") or (closes[-2] if len(closes) >= 2 else None)
        )
        volume = _fi("last_volume") or (volumes[-1] if volumes else None)

        change = None
        change_pct = None
        if current is not None and previous_close:
            change = round(current - previous_close, 4)
            change_pct = round(
                (current - previous_close) / previous_close * 100, 4
            )

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

        # Resolve a human-readable exchange name for display.
        yf_exchange = (
            info.get("exchange") or getattr(fast, "exchange", None) or ""
        ).upper()
        result["exchange_hint"] = _YF_TO_EXCHANGE.get(yf_exchange)

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
# yfinance + ta — technical indicators
# --------------------------------------------------------------------------- #
def _fetch_ohlcv(ticker: str, period: str, interval: str):
    """Download OHLCV via yfinance; returns empty DataFrame on any failure."""
    import pandas as pd
    import yfinance as yf

    try:
        df = yf.download(ticker, period=period, interval=interval,
                         auto_adjust=True, progress=False)
        if df.empty:
            return pd.DataFrame()
        # yfinance may return MultiIndex columns — flatten to simple names.
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)
        return df
    except Exception as exc:
        _log.warning("ohlcv ✗ %s %s/%s: %s", ticker, period, interval, exc)
        return pd.DataFrame()


def _safe_last(series) -> Optional[float]:
    """Return the last finite float from a pandas Series, or None."""
    try:
        val = series.dropna().iloc[-1]
        return float(val)
    except (IndexError, TypeError, ValueError):
        return None


def _recommendation(rsi, macd_hist, ema20, ema50, close) -> str:
    """BUY / SELL / NEUTRAL from a symmetric 4-signal vote.

    Each signal contributes +1 (bullish), -1 (bearish) or 0 (unavailable).
    Score ≥ 2 → BUY, ≤ -2 → SELL, else NEUTRAL.
    """
    score = 0
    if rsi is not None:
        if rsi > 60:
            score += 1
        elif rsi < 40:
            score -= 1
    if macd_hist is not None:
        score += 1 if macd_hist > 0 else -1
    if close is not None and ema20 is not None:
        score += 1 if close > ema20 else -1
    if close is not None and ema50 is not None:
        score += 1 if close > ema50 else -1
    if score >= 2:
        return "BUY"
    if score <= -2:
        return "SELL"
    return "NEUTRAL"


def _indicators_from_df(df) -> Dict[str, Any]:
    """Compute RSI, MACD, EMA, Bollinger Bands and Stochastic from OHLCV.

    Returns a per-timeframe dict. All values are None when df is too short.
    """
    _empty: Dict[str, Any] = {
        "close": None,
        "RSI": None,
        "MACD": {"macd": None, "signal": None, "histogram": None},
        "EMA20": None, "EMA50": None, "EMA200": None,
        "BollingerBands": {"upper": None, "middle": None, "lower": None},
        "Stochastic": {"k": None, "d": None},
        "recommendation": None,
    }

    if df is None or df.empty or len(df) < 14:
        return _empty

    import ta as ta_lib

    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    n = len(df)

    rsi = _safe_last(ta_lib.momentum.RSIIndicator(close, window=14).rsi())

    macd_ind = ta_lib.trend.MACD(
        close, window_slow=26, window_fast=12, window_sign=9
    )
    macd_val = _safe_last(macd_ind.macd())
    macd_sig = _safe_last(macd_ind.macd_signal())
    macd_hist = _safe_last(macd_ind.macd_diff())

    def _ema(w: int):
        if n < w:
            return None
        return _safe_last(
            ta_lib.trend.EMAIndicator(close, window=w).ema_indicator()
        )

    ema20 = _ema(20)
    ema50 = _ema(50)
    ema200 = _ema(200)

    if n >= 20:
        bb = ta_lib.volatility.BollingerBands(close, window=20)
        bb_upper = _safe_last(bb.bollinger_hband())
        bb_mid = _safe_last(bb.bollinger_mavg())
        bb_lower = _safe_last(bb.bollinger_lband())
    else:
        bb_upper = bb_mid = bb_lower = None

    stoch = ta_lib.momentum.StochasticOscillator(high, low, close, window=14)
    stoch_k = _safe_last(stoch.stoch())
    stoch_d = _safe_last(stoch.stoch_signal())

    close_last = _safe_last(close)
    rec = _recommendation(rsi, macd_hist, ema20, ema50, close_last)

    return {
        "close": close_last,
        "RSI": rsi,
        "MACD": {"macd": macd_val, "signal": macd_sig, "histogram": macd_hist},
        "EMA20": ema20,
        "EMA50": ema50,
        "EMA200": ema200,
        "BollingerBands": {
            "upper": bb_upper, "middle": bb_mid, "lower": bb_lower,
        },
        "Stochastic": {"k": stoch_k, "d": stoch_d},
        "recommendation": rec,
    }


def compute_indicators(ticker: str) -> Dict[str, Any]:
    """Compute multi-timeframe technicals using yfinance OHLCV + ta library.

    Drop-in replacement for the removed fetch_tradingview(). Returns the same
    shape: ``{"technicals": {"1H": {...}, "4H": {...}, "1D": {...}},
    "exchange": None, "errors": [...]}``.

    Download strategy
    -----------------
    * 1H and 4H share one yfinance call — ``period="1y", interval="1h"``:
      ~1 638 1H bars → ~410 4H bars after resampling. Both fully cover EMA200.
    * 1D — ``period="2y", interval="1d"`` → ~504 bars (covers EMA200 on 1D).
    """
    errors: List[str] = []
    technicals: Dict[str, Any] = {}

    _log.info("indicators ▶ %s", ticker)

    # ---- 1H + 4H (single download, resample for 4H) ------------------------
    df_1h = _fetch_ohlcv(ticker, period="1y", interval="1h")

    if df_1h.empty:
        technicals["1H"] = None
        technicals["4H"] = None
        errors.append(f"indicators 1H/4H: no hourly OHLCV data for {ticker}")
    else:
        technicals["1H"] = _indicators_from_df(df_1h)
        _log.info(
            "indicators ◀ 1H %s rsi=%s rec=%s",
            ticker,
            technicals["1H"].get("RSI"),
            technicals["1H"].get("recommendation"),
        )

        try:
            df_4h = df_1h.resample("4h").agg(
                Open=("Open", "first"),
                High=("High", "max"),
                Low=("Low", "min"),
                Close=("Close", "last"),
                Volume=("Volume", "sum"),
            ).dropna(subset=["Close"])
            technicals["4H"] = _indicators_from_df(df_4h)
            _log.info(
                "indicators ◀ 4H %s bars=%d rsi=%s rec=%s",
                ticker, len(df_4h),
                technicals["4H"].get("RSI"),
                technicals["4H"].get("recommendation"),
            )
        except Exception as exc:
            technicals["4H"] = None
            errors.append(f"indicators 4H resample failed: {exc}")

    # ---- 1D ----------------------------------------------------------------
    df_1d = _fetch_ohlcv(ticker, period="2y", interval="1d")

    if df_1d.empty:
        technicals["1D"] = None
        errors.append(f"indicators 1D: no daily OHLCV data for {ticker}")
    else:
        technicals["1D"] = _indicators_from_df(df_1d)
        _log.info(
            "indicators ◀ 1D %s rsi=%s rec=%s",
            ticker,
            technicals["1D"].get("RSI"),
            technicals["1D"].get("recommendation"),
        )

    _log.info("indicators done %s errors=%d", ticker, len(errors))
    return {"technicals": technicals, "exchange": None, "errors": errors}


# --------------------------------------------------------------------------- #
# Finnhub — optional news headlines
# --------------------------------------------------------------------------- #
def fetch_finnhub_news(ticker: str, api_key: str, n: int = 5) -> List[str]:
    """Return up to *n* recent headline strings via the Finnhub API.

    Returns an empty list when no API key is configured or on any error.
    """
    if not api_key:
        return []
    try:
        import finnhub
        today = date.today().isoformat()
        week_ago = (date.today() - timedelta(days=7)).isoformat()
        client = finnhub.Client(api_key=api_key)
        articles = client.company_news(ticker, _from=week_ago, to=today)
        return [a["headline"] for a in (articles or [])[:n] if "headline" in a]
    except Exception as exc:
        _log.warning("finnhub ✗ %s: %s", ticker, exc)
        return []


# --------------------------------------------------------------------------- #
# Unified market-data assembler
# --------------------------------------------------------------------------- #
def get_market_data(ticker: str) -> Dict[str, Any]:
    """Return the unified market-data dict for *ticker*.

    The shape is stable even when data sources fail; missing values are
    ``None`` and problems are collected in ``errors``.
    """
    from .config import get_settings

    ticker = ticker.strip().upper()
    _log.info("market_data ▶ %s", ticker)
    errors: List[str] = []

    yf_data = fetch_yfinance(ticker)
    if "error" in yf_data:
        errors.append(yf_data["error"])

    ind_data = compute_indicators(ticker)
    errors.extend(ind_data.get("errors", []))

    # Optional news headlines for the AI prompt (empty when key not set).
    settings = get_settings()
    news = fetch_finnhub_news(ticker, settings.finnhub_api_key)

    result = {
        "ticker": ticker,
        "timestamp": _now_iso(),
        "price": yf_data.get("price", {}),
        "fundamentals": yf_data.get("fundamentals", {}),
        "exchange": yf_data.get("exchange_hint"),
        "technicals": ind_data.get(
            "technicals", {tf: None for tf in _TIMEFRAMES}
        ),
        "news": news,
        "errors": errors,
    }
    _log.info("market_data ◀ %s errors=%d", ticker, len(errors))
    return result


if __name__ == "__main__":
    import json
    import sys

    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    print(json.dumps(get_market_data(symbol), indent=2, default=str))
