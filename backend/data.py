"""Market-data acquisition layer.

Combines free/local data sources into a single dictionary ready for the AI
prompt builder:

* **yfinance** — spot price, daily change, volume, moving averages (MA5/MA20),
  52-week high/low, fundamentals (P/E trailing + forward).
* **yfinance + ta** — RSI, MACD, EMA20/50/200, Bollinger Bands and Stochastic
  across the 1H, 4H and 1D timeframes, computed locally from OHLCV history.
* **yfinance** — annual balance sheet (total assets, liabilities, equity,
  debt, cash, debt-to-equity).  Daily DB cache per ticker.
* **FRED CSV** — US macro context: Fed funds rate, CPI YoY, unemployment,
  10y-2y yield spread.  Key-free CSV endpoints; global 6h DB cache.
* **multpl.com** — Shiller CAPE (P/E 10).  No API key; global 24h cache.
* **Finnhub** (optional) — recent news headlines with source/url/date,
  gated by ``FINNHUB_API_KEY``.

All sources are wrapped in defensive error handling so a failure never takes
down the whole scan; partial results are returned with an ``errors`` list.

Run standalone::

    python -m backend.data AAPL
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import requests
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from opentelemetry import trace as _otel_trace

_log = logging.getLogger(__name__)
_tracer = _otel_trace.get_tracer("marketsage.data")

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

# FRED key-free CSV endpoint (fred.stlouisfed.org).
# Works from the host but may time out inside Docker behind a corporate VPN
# because the server is blocked at the IP level on that domain.
_FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"

# FRED REST API endpoint (api.stlouisfed.org).
# Different host/IP — reliably reachable from Docker containers even on
# corporate VPNs.  Requires a free API key (FRED_API_KEY env var).
# Register at: https://fred.stlouisfed.org/docs/api/api_key.html
_FRED_API_URL = (
    "https://api.stlouisfed.org/fred/series/observations"
    "?series_id={series}&api_key={key}&file_type=json"
    "&sort_order=desc&limit={limit}"
)


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
# DB-backed cache helpers (JSON blobs in app_settings KV table)
# --------------------------------------------------------------------------- #
def _cached_json(key: str) -> Optional[Dict[str, Any]]:
    """Return the stored JSON blob for *key*, or None if not found.

    Swallows all errors — a DB read failure must never block analysis.
    """
    try:
        from .database import get_setting
        raw = get_setting(key, "")
        if not raw:
            return None
        return json.loads(raw)
    except Exception as exc:
        _log.debug("cache read failed key=%s: %s", key, exc)
        return None


def _store_json(key: str, obj: Any) -> None:
    """Persist *obj* as JSON under *key* in app_settings.

    Swallows all errors — a DB write failure must never block analysis.
    """
    try:
        from .database import set_setting
        set_setting(key, json.dumps(obj, default=str))
    except Exception as exc:
        _log.warning("cache write failed key=%s: %s", key, exc)


# --------------------------------------------------------------------------- #
# yfinance — price / fundamentals
# --------------------------------------------------------------------------- #
def fetch_yfinance(ticker: str) -> Dict[str, Any]:
    """Fetch price/volume/fundamentals for *ticker* from yfinance.

    Returns a dict with ``price``, ``fundamentals`` and an ``exchange_hint``
    for display. Raises nothing: failures are surfaced via the ``error`` key.
    """

    import yfinance as yf

    with _tracer.start_as_current_span("data.fetch_price_fundamentals") as span:
        span.set_attribute("ticker", ticker)
        span.set_attribute("data_source", "yfinance")

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

            pe_trailing = _safe_float(info.get("trailingPE"))
            pe_forward  = _safe_float(info.get("forwardPE"))
            mkt_cap     = _safe_float(info.get("marketCap"))

            result["fundamentals"] = {
                "name": info.get("shortName") or info.get("longName") or ticker,
                "sector": info.get("sector"),
                "industry": info.get("industry"),
                "market_cap": mkt_cap,
                # pe_ratio kept for backward compat; trailing_pe is the canonical key
                "pe_ratio": pe_trailing,
                "trailing_pe": pe_trailing,
                "forward_pe": pe_forward,
            }

            # Resolve a human-readable exchange name for display.
            yf_exchange = (
                info.get("exchange") or getattr(fast, "exchange", None) or ""
            ).upper()
            result["exchange_hint"] = _YF_TO_EXCHANGE.get(yf_exchange)

        except Exception as exc:  # pragma: no cover - network dependent
            result["error"] = f"yfinance error: {exc}"
            _log.warning("yfinance ✗ %s: %s", ticker, exc)
            span.set_attribute("error", str(exc))
            return result

        price = result.get("price", {})
        fund  = result.get("fundamentals", {})
        _log.info(
            "yfinance ◀ %s price=%s change_pct=%s vol_ratio=%s",
            ticker,
            price.get("current"),
            price.get("change_pct"),
            price.get("volume_ratio"),
        )
        span.set_attribute("market_cap",  str(fund.get("market_cap", "")))
        span.set_attribute("pe_trailing", str(fund.get("trailing_pe", "")))
        span.set_attribute("pe_forward",  str(fund.get("forward_pe", "")))
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

    with _tracer.start_as_current_span("data.compute_indicators") as span:
        span.set_attribute("ticker", ticker)
        _log.info("indicators ▶ %s", ticker)

        # ---- 1H + 4H (single download, resample for 4H) -----------------------
        df_1h = _fetch_ohlcv(ticker, period="1y", interval="1h")

        if df_1h.empty:
            technicals["1H"] = None
            technicals["4H"] = None
            errors.append(f"indicators 1H/4H: no hourly OHLCV data for {ticker}")
        else:
            technicals["1H"] = _indicators_from_df(df_1h)
            span.add_event("timeframe_done", {
                "timeframe": "1H",
                "rsi": str(technicals["1H"].get("RSI", "")),
                "rec": technicals["1H"].get("recommendation", ""),
            })
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
                span.add_event("timeframe_done", {
                    "timeframe": "4H",
                    "rsi": str(technicals["4H"].get("RSI", "")),
                    "rec": technicals["4H"].get("recommendation", ""),
                })
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
            span.add_event("timeframe_done", {
                "timeframe": "1D",
                "rsi": str(technicals["1D"].get("RSI", "")),
                "rec": technicals["1D"].get("recommendation", ""),
            })
            _log.info(
                "indicators ◀ 1D %s rsi=%s rec=%s",
                ticker,
                technicals["1D"].get("RSI"),
                technicals["1D"].get("recommendation"),
            )

        _log.info("indicators done %s errors=%d", ticker, len(errors))
        span.set_attribute("error_count", len(errors))
        return {"technicals": technicals, "exchange": None, "errors": errors}


# --------------------------------------------------------------------------- #
# FRED — US macro indicators (key-free CSV endpoints)
# --------------------------------------------------------------------------- #
def _parse_fred_csv(text: str) -> List[tuple]:
    """Parse a FRED CSV response; return list of (date_str, float) for
    non-null rows.  FRED uses "." to denote missing values."""
    rows: List[tuple] = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            date_str = (row.get("DATE") or "").strip()
            val_str  = (row.get("VALUE") or "").strip()
            if not date_str or val_str in (".", ""):
                continue
            try:
                rows.append((date_str, float(val_str)))
            except ValueError:
                pass
    except Exception:
        pass
    return rows


def _parse_fred_api(payload: dict) -> List[tuple]:
    """Parse a FRED REST API JSON response into [(date_str, float), …].

    The API returns observations newest-first (sort_order=desc), so the
    caller should reverse when chronological order matters (e.g. CPI YoY).
    """
    rows: List[tuple] = []
    for obs in payload.get("observations", []):
        date_str = (obs.get("date") or "").strip()
        val_str  = (obs.get("value") or "").strip()
        if not date_str or val_str in (".", ""):
            continue
        try:
            rows.append((date_str, float(val_str)))
        except ValueError:
            pass
    return rows


def _last_fred(series: str, *, limit: int = 1) -> Optional[Dict[str, Any]]:
    """Fetch a single FRED series and return the last non-null {value, date}.

    Prefers the FRED REST API (api.stlouisfed.org) when ``FRED_API_KEY`` is
    configured — that host is reachable from Docker containers behind corporate
    VPNs where ``fred.stlouisfed.org`` often times out.  Falls back to the
    key-free CSV endpoint when no key is set.
    """
    from .config import get_settings
    api_key = get_settings().fred_api_key

    try:
        if api_key:
            url = _FRED_API_URL.format(series=series, key=api_key, limit=limit)
            r = requests.get(url, timeout=(5, 15))
            r.raise_for_status()
            rows = _parse_fred_api(r.json())
        else:
            r = requests.get(_FRED_CSV_URL.format(series=series), timeout=(5, 15))
            r.raise_for_status()
            rows = _parse_fred_csv(r.text)

        if not rows:
            return None
        # API returns newest-first; CSV is oldest-first — normalise to last=newest
        date_str, value = rows[0] if api_key else rows[-1]
        return {"value": round(value, 4), "date": date_str}
    except Exception as exc:
        _log.warning("fred ✗ %s: %s", series, exc)
        return None


def _cape_from_multpl() -> Optional[Dict[str, Any]]:
    """Scrape the most recent Shiller CAPE (P/E 10) value from multpl.com.

    Returns ``{"value": float, "date": "YYYY-MM-01"}`` or None on any failure.
    """
    try:
        r = requests.get(
            "https://www.multpl.com/shiller-pe/table/by-month",
            timeout=(5, 15),
            headers={"User-Agent": "Mozilla/5.0 (compatible; MarketSage/1.0)"},
        )
        r.raise_for_status()
        # First data row — handles both "Aug 2026" and "Aug 14, 2026" date formats.
        # Value cell may contain HTML entities (&#x2002; en-space) before the
        # number, so extract the two <td> texts separately then find the float.
        import html as _html
        m = re.search(
            r"<tr[^>]*>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>",
            r.text,
            re.DOTALL,
        )
        if not m:
            _log.warning("cape ✗ multpl.com: table row not found")
            return None
        raw_date = _html.unescape(m.group(1)).strip()
        val_cell = _html.unescape(m.group(2))
        val_m = re.search(r"[\d]+\.[\d]+|[\d]+", val_cell)
        if not val_m:
            _log.warning("cape ✗ multpl.com: could not parse value from %r", val_cell)
            return None
        raw_val = val_m.group(0)
        # Try "Mon DD, YYYY" first, then "Mon YYYY"
        for fmt in ("%b %d, %Y", "%b %Y"):
            try:
                parsed = datetime.strptime(raw_date, fmt)
                iso_date = parsed.strftime("%Y-%m-01")
                break
            except ValueError:
                iso_date = raw_date
        return {"value": round(float(raw_val), 2), "date": iso_date}
    except Exception as exc:
        _log.warning("cape ✗ multpl.com: %s", exc)
        return None


def fetch_fred_macro() -> Dict[str, Any]:
    """Fetch US macro indicators from FRED (key-free CSV) + Shiller CAPE.

    Global 6h DB cache shared across all tickers in a scan.  A FRED/scrape
    outage returns an empty/stale block and never blocks analysis.
    """
    _CACHE_KEY = "macro_cache"
    _CACHE_TTL_H = 6

    cached = _cached_json(_CACHE_KEY)
    if cached:
        fetched_at_str = cached.get("fetched_at", "")
        try:
            fetched_at = datetime.fromisoformat(fetched_at_str)
            if fetched_at.tzinfo is None:
                fetched_at = fetched_at.replace(tzinfo=timezone.utc)
            age_h = (
                datetime.now(timezone.utc) - fetched_at
            ).total_seconds() / 3600
            if age_h < _CACHE_TTL_H:
                _log.info("macro ◀ (cache hit, age=%.1fh)", age_h)
                return cached.get("data", {})
        except Exception:
            pass

    with _tracer.start_as_current_span("data.fetch_macro") as span:
        span.set_attribute("data_source", "fred+multpl")
        _log.info("macro ▶ fetching from FRED + multpl.com")
        data: Dict[str, Any] = {}

        # Fed funds rate
        data["fed_funds_rate"] = _last_fred("FEDFUNDS")

        # CPI YoY — fetch 24 months and match the year-ago value by date
        # to handle gaps in FRED's monthly release schedule.
        try:
            from .config import get_settings
            api_key = get_settings().fred_api_key
            if api_key:
                url = _FRED_API_URL.format(series="CPIAUCSL", key=api_key, limit=24)
                r = requests.get(url, timeout=(5, 15))
                r.raise_for_status()
                # API returns newest-first; reverse to chronological order
                cpi_rows = list(reversed(_parse_fred_api(r.json())))
            else:
                r = requests.get(
                    _FRED_CSV_URL.format(series="CPIAUCSL"), timeout=(5, 15)
                )
                r.raise_for_status()
                cpi_rows = _parse_fred_csv(r.text)

            if len(cpi_rows) >= 13:
                latest_date, latest_val = cpi_rows[-1]
                # Find the value closest to 12 months prior by date matching
                try:
                    from datetime import date
                    ld = date.fromisoformat(latest_date)
                    target_year = ld.year - 1
                    # Build a dict for fast lookup, fall back to index -13
                    date_map = {d: v for d, v in cpi_rows}
                    for month_delta in range(0, 3):
                        candidate = date(
                            target_year,
                            ((ld.month - 1 - month_delta) % 12) + 1,
                            1,
                        ).isoformat()
                        if candidate in date_map:
                            year_ago_val = date_map[candidate]
                            break
                    else:
                        _, year_ago_val = cpi_rows[-13]
                except Exception:
                    _, year_ago_val = cpi_rows[-13]

                yoy = round((latest_val - year_ago_val) / year_ago_val * 100, 2)
                data["cpi_yoy"] = {"value": yoy, "date": latest_date}
            else:
                data["cpi_yoy"] = None
        except Exception as exc:
            _log.warning("fred ✗ CPIAUCSL: %s", exc)
            data["cpi_yoy"] = None

        # Unemployment
        data["unemployment"] = _last_fred("UNRATE")

        # 10y-2y yield spread (negative = inverted = recession signal)
        spread = _last_fred("T10Y2Y")
        if spread is not None:
            spread["inverted"] = spread["value"] < 0
        data["yield_spread"] = spread

        # Shiller CAPE
        data["shiller_cape"] = _cape_from_multpl()

        # Surface which series failed so callers can report a diagnostic.
        failed = [k for k, v in data.items() if v is None]
        if failed:
            data["_fetch_errors"] = failed

        fetched_count = sum(1 for k, v in data.items()
                            if not k.startswith("_") and v is not None)
        total = sum(1 for k in data if not k.startswith("_"))
        span.set_attribute("series_fetched", fetched_count)
        span.set_attribute("cache_hit", False)
        _log.info("macro ◀ fetched=%d/%d series", fetched_count, total)

        _store_json(_CACHE_KEY, {
            "fetched_at": _now_iso(),
            "data": data,
        })
        return data


# --------------------------------------------------------------------------- #
# yfinance — balance sheet
# --------------------------------------------------------------------------- #
def fetch_balance_sheet(ticker: str) -> Dict[str, Any]:
    """Fetch the most recent annual balance sheet for *ticker* from yfinance.

    Daily DB cache per ticker.  Returns a dict with None values when the data
    is unavailable (e.g. ETFs have no balance sheet).
    """
    _cache_key = f"bs_cache:{ticker}"
    _today = date.today().isoformat()

    cached = _cached_json(_cache_key)
    if cached and cached.get("date") == _today:
        _log.info("balance_sheet ◀ %s (cache hit)", ticker)
        return cached.get("data", {})

    _empty: Dict[str, Any] = {
        "period": None,
        "total_assets": None,
        "total_liabilities": None,
        "stockholders_equity": None,
        "total_debt": None,
        "cash": None,
        "debt_to_equity": None,
    }

    with _tracer.start_as_current_span("data.fetch_balance_sheet") as span:
        span.set_attribute("ticker", ticker)
        span.set_attribute("cache_hit", False)
        _log.info("balance_sheet ▶ %s", ticker)
        try:
            import yfinance as yf

            bs = yf.Ticker(ticker).balance_sheet
            if bs is None or bs.empty:
                _log.warning("balance_sheet ✗ %s: empty DataFrame", ticker)
                _store_json(_cache_key, {"date": _today, "data": _empty})
                return _empty

            col = bs.columns[0]  # most recent period-end Timestamp

            def _row(name: str) -> Optional[float]:
                return (
                    _safe_float(bs.loc[name, col]) if name in bs.index else None
                )

            # Guard with fallback label names across yfinance versions.
            liabilities = (
                _row("Total Liabilities Net Minority Interest")
                or _row("Total Liabilities")
            )
            equity = (
                _row("Stockholders Equity")
                or _row("Total Stockholder Equity")
            )
            debt = _row("Total Debt") or _row("Long Term Debt")
            cash = (
                _row("Cash And Cash Equivalents")
                or _row("Cash")
            )

            # Convert pandas Timestamp to ISO string for JSON safety.
            period_str = (
                str(col.date()) if hasattr(col, "date") else str(col)
            )

            d_over_e = None
            if debt is not None and equity and equity != 0:
                d_over_e = round(debt / equity, 3)

            result: Dict[str, Any] = {
                "period": period_str,
                "total_assets": _row("Total Assets"),
                "total_liabilities": liabilities,
                "stockholders_equity": equity,
                "total_debt": debt,
                "cash": cash,
                "debt_to_equity": d_over_e,
            }
        except Exception as exc:
            _log.warning("balance_sheet ✗ %s: %s", ticker, exc)
            span.set_attribute("error", str(exc))
            result = _empty

        _store_json(_cache_key, {"date": _today, "data": result})
        _log.info(
            "balance_sheet ◀ %s period=%s assets=%s",
            ticker,
            result.get("period"),
            result.get("total_assets"),
        )
        span.set_attribute("period", result.get("period") or "")
        return result


# --------------------------------------------------------------------------- #
# Finnhub — optional news (returns List[Dict] with full article metadata)
# --------------------------------------------------------------------------- #
def fetch_finnhub_news(
    ticker: str, api_key: str, n: int = 5
) -> List[Dict[str, Any]]:
    """Return up to *n* recent news articles via the Finnhub API.

    Each article dict has: ``headline``, ``source``, ``url``, ``datetime``
    (Unix epoch int — JSON-safe).  Returns an empty list when no API key is
    configured or on any error.
    """
    with _tracer.start_as_current_span("data.fetch_news") as span:
        span.set_attribute("ticker", ticker)
        span.set_attribute("data_source", "finnhub")
        span.set_attribute("api_key_set", bool(api_key))

        if not api_key:
            span.set_attribute("article_count", 0)
            return []
        try:
            import finnhub
            today = date.today().isoformat()
            week_ago = (date.today() - timedelta(days=7)).isoformat()
            client = finnhub.Client(api_key=api_key)
            articles = client.company_news(ticker, _from=week_ago, to=today)
            result = [
                {
                    "headline": a.get("headline"),
                    "source":   a.get("source"),
                    "url":      a.get("url"),
                    "datetime": a.get("datetime"),  # Unix epoch int
                }
                for a in (articles or [])[:n]
                if a.get("headline")
            ]
            span.set_attribute("article_count", len(result))
            return result
        except Exception as exc:
            _log.warning("finnhub ✗ %s: %s", ticker, exc)
            span.set_attribute("article_count", 0)
            span.set_attribute("error", str(exc))
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

    # Optional news headlines (empty list when key not set).
    settings = get_settings()
    news = fetch_finnhub_news(ticker, settings.finnhub_api_key)

    # Balance sheet — daily-cached per ticker.
    balance_sheet: Dict[str, Any] = {}
    try:
        balance_sheet = fetch_balance_sheet(ticker)
    except Exception as exc:  # pragma: no cover
        errors.append(f"balance_sheet error: {exc}")

    # US macro — global 6h cache.
    macro: Dict[str, Any] = {}
    try:
        macro = fetch_fred_macro()
    except Exception as exc:  # pragma: no cover
        errors.append(f"macro error: {exc}")

    # Detect total FRED/multpl outage and surface a human-readable error.
    macro_vals = [v for k, v in macro.items() if not k.startswith("_")]
    if macro_vals and all(v is None for v in macro_vals):
        errors.append(
            "macro: all FRED/multpl.com fetches failed — "
            "set FRED_API_KEY in .env to use the reliable REST API "
            "(api.stlouisfed.org), or verify outbound access to "
            "fred.stlouisfed.org from the Docker container"
        )

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
        "balance_sheet": balance_sheet,
        "macro": macro,
        "errors": errors,
    }
    _log.info("market_data ◀ %s errors=%d", ticker, len(errors))
    return result


if __name__ == "__main__":
    import json as _json
    import sys

    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    print(_json.dumps(get_market_data(symbol), indent=2, default=str))
