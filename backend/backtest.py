"""Backtesting engine — day-by-day signal replay over historical OHLCV data.

Replays the live signal-detection pipeline against a historical window to
measure whether the system's signals have real edge.  All computation is
*point-in-time safe*: indicators are computed only on bars up to and
including the replay date; outcomes are evaluated on bars strictly after it.

Key design principles
---------------------
* **Pure pipeline reuse**: ``analyze()``, ``detect_opportunities()``, and
  ``filter_by_confidence()`` are called unmodified — they consume a dict, fetch
  nothing.
* **One download per ticker**: 1H and 1D frames are downloaded once over the
  full window (plus lead-in for indicator warmup); each replay day slices them.
* **Capture all signals**: ``ai_floor_override=0.0`` is passed so every AI
  signal is recorded regardless of confidence floor.  The floor becomes a
  client-side view filter, not a capture gate — this enables the floor-sweep.
* **Look-ahead safety**: fundamentals, macro, and news are passed empty during
  replay; only OHLCV-derived indicators (no information from after date D) are used.
"""

from __future__ import annotations

import concurrent.futures
import logging
import math
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

_log = logging.getLogger(__name__)

# Calendar-day lead-in before start_date when fetching historical 1H/1D data.
# 1D: ~300 days to seed EMA200; 1H: ~40 days sufficient.
_1D_LEADIN_DAYS = 310
_1H_LEADIN_DAYS = 45
# yfinance 1H data covers only ~730 calendar days from today.
_1H_MAX_AGE_DAYS = 730


class _RpmThrottle:
    """Thread-safe fixed-interval rate limiter shared across all ticker threads.

    Enforces at most ``rpm`` LLM calls per minute globally by sleeping the
    calling thread until the minimum inter-call interval has elapsed.
    """

    def __init__(self, rpm: int | None) -> None:
        self._interval = (60.0 / rpm) if rpm else None
        self._last: float = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        """Block until it is safe to make the next LLM call."""
        if not self._interval:
            return
        with self._lock:
            elapsed = time.monotonic() - self._last
            if elapsed < self._interval:
                time.sleep(self._interval - elapsed)
            self._last = time.monotonic()


# --------------------------------------------------------------------------- #
# Parameter dataclass
# --------------------------------------------------------------------------- #
@dataclass
class BacktestParams:
    tickers: list[str]
    start_date: str  # YYYY-MM-DD
    end_date: str  # YYYY-MM-DD
    initial_balance: float = 10_000.0
    confidence_floor: float = 65.0
    max_hold_days: int = 10
    use_llm: bool = False
    atr_multiple: float = 1.5
    reward_risk: float = 2.0
    requests_per_minute: int | None = None  # None = no throttle
    is_out_of_sample: bool = False  # True when window is a held-out test set
    # Virtual wallet — fixed-fractional position sizing.
    # Each signal invests initial_balance x position_size_pct dollars.
    # Stored in metrics_json so it round-trips without a new DB column.
    position_size_pct: float = 0.10  # 10% per trade by default
    # Cashout rule — early profit-taking before the original target.
    # If set, a trade is closed for a "cashout" win as soon as its
    # unrealised R reaches this level (checked daily using bar High/Low).
    # Must be positive and less than the signal's R:R ratio to have any effect.
    # None (default) disables the rule — trades run to target / stop / timeout.
    cashout_r: float | None = None
    # How often to check for signals within each trading day.
    # 1440 = once at end-of-day (default; fastest).  Values < 1440 trigger
    # intraday scanning at NYSE market hours (14:30-21:00 UTC / 9:30-16:00 ET).
    # Common values: 15 (every 15 min), 30, 60, 120, 240, 480 (8h = twice daily).
    scan_interval_minutes: int = 1440
    # Parallelism controls — how many tickers and LLM calls run concurrently.
    # Defaults come from env vars / DB settings; request body may override.
    max_concurrent_tickers: int = 4  # ThreadPoolExecutor max_workers
    max_concurrent_llm: int = 2  # Semaphore cap on simultaneous LLM calls

    def __post_init__(self) -> None:
        if not self.tickers:
            raise ValueError("tickers must be a non-empty list")
        try:
            s = date.fromisoformat(self.start_date)
            e = date.fromisoformat(self.end_date)
        except ValueError as exc:
            raise ValueError(f"Invalid date format: {exc}") from exc
        if s >= e:
            raise ValueError("start_date must be before end_date")


# --------------------------------------------------------------------------- #
# Intraday scan-time helper
# --------------------------------------------------------------------------- #
def _intraday_timestamps(day: date, interval_minutes: int) -> list[datetime]:
    """Return UTC datetimes at *interval_minutes* steps during NYSE market hours.

    NYSE: 9:30 AM - 4:00 PM ET ~= 14:30 - 21:00 UTC (EST+5h; DST-naive --
    close enough for backtesting purposes).
    """
    market_open = datetime(day.year, day.month, day.day, 14, 30, tzinfo=timezone.utc)
    market_close = datetime(day.year, day.month, day.day, 21, 0, tzinfo=timezone.utc)
    ts = market_open
    result: list[datetime] = []
    while ts <= market_close:
        result.append(ts)
        ts += timedelta(minutes=interval_minutes)
    return result


# --------------------------------------------------------------------------- #
# Build as-of market_data dict from pre-downloaded frames
# --------------------------------------------------------------------------- #
def _resample_4h(df_1h):
    """Resample 1H OHLCV to 4H, matching the live compute_indicators logic."""
    return (
        df_1h.resample("4h")
        .agg(
            Open=("Open", "first"),
            High=("High", "max"),
            Low=("Low", "min"),
            Close=("Close", "last"),
            Volume=("Volume", "sum"),
        )
        .dropna(subset=["Close"])
    )


def build_market_data_asof(
    ticker: str,
    asof: date | datetime,
    df_1h,  # pd.DataFrame | empty DataFrame
    df_1d,  # pd.DataFrame | empty DataFrame
) -> dict[str, Any]:
    """Assemble a ``get_market_data``-shaped dict using only data up to *asof*.

    *asof* may be a :class:`datetime.date` (end-of-day semantics; cutoff is
    23:59:59 UTC of that day) or a timezone-aware :class:`datetime.datetime`
    (exact intraday cutoff for sub-daily scan intervals).

    *df_1h* and *df_1d* are full pre-downloaded DataFrames (covering the
    lead-in + replay window).  This function slices them to ``<= asof`` before
    computing indicators so no future information leaks in.

    Fundamentals, macro, and news are intentionally left empty — they are not
    point-in-time safe in this implementation and their absence causes the
    related rules to no-op cleanly.
    """
    from .data import _indicators_from_df  # type: ignore[attr-defined]

    # Accept either a bare date (end-of-day) or an exact datetime (intraday).
    if isinstance(asof, datetime):
        asof_ts = asof if asof.tzinfo else asof.replace(tzinfo=timezone.utc)
    else:
        asof_ts = datetime(asof.year, asof.month, asof.day, 23, 59, 59, tzinfo=timezone.utc)

    # Slice to as-of date (inclusive).
    def _slice(df):
        if df is None or df.empty:
            return df
        import pandas as pd

        idx = df.index
        if idx.tzinfo is None:
            idx_utc = idx.tz_localize("UTC")
        else:
            idx_utc = idx.tz_convert("UTC")
        mask = idx_utc <= pd.Timestamp(asof_ts)
        # mask may be a numpy array (DatetimeIndex comparison) or a pandas Series;
        # numpy arrays have no .values — use the mask directly.
        return df[mask if not hasattr(mask, "values") else mask.values]

    sl_1h = _slice(df_1h)
    sl_1d = _slice(df_1d)

    # Indicators for each timeframe.
    ind_1h = _indicators_from_df(sl_1h) if (sl_1h is not None and not sl_1h.empty) else None
    ind_4h = None
    if sl_1h is not None and not sl_1h.empty:
        try:
            ind_4h = _indicators_from_df(_resample_4h(sl_1h))
        except Exception as exc:
            _log.debug("4H resample ✗ %s: %s", ticker, exc)
    ind_1d = _indicators_from_df(sl_1d) if (sl_1d is not None and not sl_1d.empty) else None

    # Price: prefer the last 1H bar (finer granularity for intraday scans);
    # fall back to the last 1D bar close when 1H data is unavailable.
    current_price: float | None = None
    for _price_df in (sl_1h, sl_1d):
        if _price_df is not None and not _price_df.empty:
            try:
                current_price = float(_price_df["Close"].iloc[-1])
                break
            except (IndexError, TypeError, KeyError):
                continue  # dataframe unusable; try next one

    return {
        "ticker": ticker.upper(),
        "timestamp": asof_ts.isoformat(),
        "price": {
            "current": current_price,
            "previous_close": None,
            "change": None,
            "change_pct": None,
            "volume": None,
            "avg_volume": None,
            "volume_ratio": None,
            "ma5": None,
            "ma20": None,
            "day_high": None,
            "day_low": None,
            "week52_high": None,
            "week52_low": None,
        },
        "fundamentals": {},
        "exchange": None,
        "technicals": {"1H": ind_1h, "4H": ind_4h, "1D": ind_1d},
        "news": [],
        "balance_sheet": {},
        "macro": {},
        "errors": [],
    }


# --------------------------------------------------------------------------- #
# ATR bracket synthesis
# --------------------------------------------------------------------------- #
def synthesize_bracket(
    signal: dict[str, Any],
    atr_val: float | None,
    atr_multiple: float,
    reward_risk: float,
) -> dict[str, Any]:
    """Fill in missing stop/target using an ATR-based bracket.

    If the signal already carries both *stop* and *target* (e.g. from the AI
    check), they are left unchanged.  If either is missing and *atr_val* is
    available, a symmetric bracket is synthesised.

    Returns the signal dict (mutated in place) for convenience.
    """
    entry = signal.get("entry")
    if entry is None:
        return signal

    stop = signal.get("stop")
    target = signal.get("target")
    direction = signal.get("type", "long")

    # Only synthesise if at least one side is missing and we have ATR.
    if (stop is not None and target is not None) or atr_val is None or atr_val <= 0:
        return signal

    risk = atr_multiple * atr_val
    if direction == "long":
        if stop is None:
            stop = entry - risk
        if target is None:
            target = entry + reward_risk * (entry - stop)
    else:  # short
        if stop is None:
            stop = entry + risk
        if target is None:
            target = entry - reward_risk * (stop - entry)

    signal["stop"] = round(stop, 4)
    signal["target"] = round(target, 4)
    return signal


# --------------------------------------------------------------------------- #
# Outcome evaluation
# --------------------------------------------------------------------------- #
def evaluate_outcome(
    signal: dict[str, Any],
    forward_bars,  # pd.DataFrame with DatetimeIndex, columns: High, Low, Close
    max_hold_days: int,
    cashout_r: float | None = None,
) -> dict[str, Any]:
    """Walk forward daily bars to determine win / loss / timeout / cashout.

    Tie-break rules (applied in this order each bar):
    1. Stop hit  → loss  (conservative: stop takes priority).
    2. Target hit → win at target price.
    3. Cashout hit → cashout win at cashout price  (only when ``cashout_r`` is
       set AND the cashout price is below the target for longs / above for
       shorts — otherwise the target check already handled it).

    Cashout rule: if ``cashout_r`` is set and > 0, a "cashout" exit is triggered
    on the first bar where the unrealised R reaches ``cashout_r``.  The cashout
    price is ``entry +/- cashout_r x risk``.  The outcome is "cashout" (a
    profitable exit, counted as a win in metrics but distinguished in the trade
    list so you can see how often you left R on the table).

    Returns a dict with keys: exit_date, exit_price, outcome, r_multiple.
    """
    entry = signal.get("entry")
    stop = signal.get("stop")
    target = signal.get("target")
    direction = signal.get("type", "long")

    if entry is None or stop is None or target is None:
        return {
            "exit_date": None,
            "exit_price": None,
            "outcome": "timeout",
            "r_multiple": 0.0,
        }

    risk = abs(entry - stop)
    if risk == 0:
        return {
            "exit_date": None,
            "exit_price": None,
            "outcome": "timeout",
            "r_multiple": 0.0,
        }

    bars = forward_bars.iloc[:max_hold_days] if forward_bars is not None else None
    if bars is None or bars.empty:
        return {
            "exit_date": None,
            "exit_price": float(entry),
            "outcome": "timeout",
            "r_multiple": 0.0,
        }

    # Pre-compute the cashout price once (None when the rule is disabled or
    # would never trigger before the target).
    _cashout_price: float | None = None
    if cashout_r is not None and cashout_r > 0:
        if direction == "long":
            _cp = entry + cashout_r * risk
            if _cp < target:  # only useful when it fires before the target
                _cashout_price = _cp
        else:
            _cp = entry - cashout_r * risk
            if _cp > target:  # short: cashout price is above target
                _cashout_price = _cp

    for idx_val, row in bars.iterrows():
        high = float(row["High"])
        low = float(row["Low"])
        bar_date = idx_val.strftime("%Y-%m-%d") if hasattr(idx_val, "strftime") else str(idx_val)

        if direction == "long":
            stop_hit = low <= stop
            target_hit = high >= target
            cashout_hit = _cashout_price is not None and high >= _cashout_price
        else:
            stop_hit = high >= stop
            target_hit = low <= target
            cashout_hit = _cashout_price is not None and low <= _cashout_price

        # 1. Stop — conservative tie-break: stop beats everything.
        if stop_hit:
            exit_price = stop
            r = (stop - entry) / risk if direction == "long" else (entry - stop) / risk
            return {
                "exit_date": bar_date,
                "exit_price": round(exit_price, 4),
                "outcome": "loss",
                "r_multiple": round(r, 3),
            }
        # 2. Full target.
        if target_hit:
            exit_price = target
            r = (target - entry) / risk if direction == "long" else (entry - target) / risk
            return {
                "exit_date": bar_date,
                "exit_price": round(exit_price, 4),
                "outcome": "win",
                "r_multiple": round(r, 3),
            }
        # 3. Cashout — early exit, records exactly cashout_r.
        if cashout_hit:
            exit_price = _cashout_price  # type: ignore[assignment]
            return {
                "exit_date": bar_date,
                "exit_price": round(exit_price, 4),
                "outcome": "cashout",
                "r_multiple": round(cashout_r, 3),  # type: ignore[arg-type]
            }

    # None of the above — timeout at last bar's close.
    last_close = float(bars["Close"].iloc[-1])
    last_bar = bars.index[-1]
    last_date = last_bar.strftime("%Y-%m-%d") if hasattr(last_bar, "strftime") else str(last_bar)
    if direction == "long":
        r = (last_close - entry) / risk
    else:
        r = (entry - last_close) / risk
    return {
        "exit_date": last_date,
        "exit_price": round(last_close, 4),
        "outcome": "timeout",
        "r_multiple": round(r, 3),
    }


# --------------------------------------------------------------------------- #
# Metrics computation (with floor sweep)
# --------------------------------------------------------------------------- #
def _metrics_at_floor(trades: list[dict[str, Any]], floor: float) -> dict[str, Any]:
    """Compute headline metrics for trades with confidence >= *floor*."""
    filtered = [t for t in trades if t.get("confidence", 0) >= floor]
    total = len(filtered)
    if total == 0:
        return {
            "win_rate": None,
            "avg_r_multiple": None,
            "sharpe": None,
            "max_drawdown": None,
            "false_positive_rate": None,
            "total_trades": 0,
            "cumulative_r": [],
        }

    # "cashout" counts as a profitable close for win-rate purposes.
    wins = sum(1 for t in filtered if t.get("outcome") in ("win", "cashout"))
    cashout_count = sum(1 for t in filtered if t.get("outcome") == "cashout")
    r_series = [t.get("r_multiple") or 0.0 for t in filtered]
    cum_r: list[float] = []
    running = 0.0
    for r in r_series:
        running += r
        cum_r.append(round(running, 3))

    win_rate = wins / total
    avg_r = sum(r_series) / total
    losses = sum(1 for t in filtered if t.get("outcome") == "loss")
    fp_rate = losses / total

    # Sharpe: mean R / std R (undefined if std == 0)
    sharpe: float | None = None
    if total > 1:
        mean_r = avg_r
        var = sum((r - mean_r) ** 2 for r in r_series) / total
        std = math.sqrt(var)
        if std > 0:
            sharpe = round(mean_r / std, 3)

    # Max drawdown on cumulative R series (peak-to-trough).
    peak = cum_r[0]
    max_dd = 0.0
    for v in cum_r[1:]:
        peak = max(peak, v)
        dd = peak - v
        max_dd = max(max_dd, dd)

    return {
        "win_rate": round(win_rate, 4),
        "avg_r_multiple": round(avg_r, 3),
        "sharpe": sharpe,
        "max_drawdown": round(max_dd, 3),
        "false_positive_rate": round(fp_rate, 4),
        "total_trades": total,
        "cashout_count": cashout_count,
        "cumulative_r": cum_r,
    }


def _expectancy_ci95(win_rate: float, avg_r: float, n: int) -> list[float]:
    """Wilson-score CI on win rate, projected onto the avg-R scale.

    Returns ``[lower, upper]`` as rough expectancy bounds.  This is a
    practical approximation — a proper bootstrap would need per-trade R values.
    """
    if n < 2:
        return [round(avg_r, 3), round(avg_r, 3)]
    z = 1.96
    p = win_rate
    denom = 1 + z * z / n
    margin = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    # Scale margin from win-rate space to R space (rough proportional scaling)
    scale = abs(avg_r) / max(p, 0.01)
    lower = round(avg_r - margin * scale, 3)
    upper = round(avg_r + margin * scale, 3)
    return [lower, upper]


# Round-trip cost estimate in R units (commission + spread rough assumption).
_ROUND_TRIP_COST_R: float = 0.05


def compute_dollar_metrics(
    trades: list[dict[str, Any]],
    initial_balance: float,
    position_size_pct: float,
    floor: float,
) -> dict[str, Any]:
    """Compute dollar P&L and equity curve for a virtual wallet simulation.

    Uses fixed-fractional sizing: every trade invests
    ``initial_balance x position_size_pct`` dollars, regardless of running equity.
    That keeps the math a single forward-pass (no cash-flow state machine needed).
    """
    position_size = initial_balance * position_size_pct

    # Closed trades at or above the floor, sorted chronologically by exit date.
    closed = sorted(
        [
            t
            for t in trades
            if (t.get("confidence") or 0) >= floor
            and t.get("exit_date")
            and t.get("r_multiple") is not None
        ],
        key=lambda t: (t["exit_date"], t.get("signal_date", "")),
    )

    equity = initial_balance
    first_date = closed[0]["signal_date"] if closed else None
    curve: list[dict] = [{"date": first_date, "equity": round(initial_balance, 2)}]
    for t in closed:
        entry = t.get("entry") or 1.0
        stop = t.get("stop")
        risk_frac = abs(entry - stop) / entry if stop and entry else 0.02
        dollar_pnl = position_size * risk_frac * (t.get("r_multiple") or 0.0)
        equity += dollar_pnl
        curve.append({"date": t["exit_date"], "equity": round(equity, 2)})

    total_pnl = equity - initial_balance
    peak = max((p["equity"] for p in curve), default=initial_balance)
    return {
        "initial_balance": round(initial_balance, 2),
        "position_size": round(position_size, 2),
        "position_size_pct": round(position_size_pct, 4),
        "final_equity": round(equity, 2),
        "total_pnl": round(total_pnl, 2),
        "total_return_pct": (
            round(total_pnl / initial_balance * 100, 2) if initial_balance else None
        ),
        "peak_equity": round(peak, 2),
        "dollar_equity_curve": curve,
    }


def compute_metrics(trades: list[dict[str, Any]], floor: float) -> dict[str, Any]:
    """Compute full metrics including per-ticker breakdown, floor sweep,
    expectancy CI95, fee-stress pass, and ticker concentration.

    ``trades`` should include ALL trades recorded during the run (captured at
    floor 0.0) so the sweep can re-filter freely.
    """
    base = _metrics_at_floor(trades, floor)

    # ── Extra quality metrics ─────────────────────────────────────────────── #
    n = base["total_trades"]
    wr = base["win_rate"] or 0.0
    avg_r = base["avg_r_multiple"] or 0.0

    base["effective_trades"] = n  # True Neff needs autocorrelation; use n for now
    base["expectancy_ci95"] = _expectancy_ci95(wr, avg_r, n) if n >= 2 else None

    after_cost = round(avg_r - _ROUND_TRIP_COST_R, 3)
    base["after_cost_avg_r"] = after_cost
    base["fee_stress_pass"] = after_cost > 0 if n > 0 else None

    # Ticker concentration: share of trades in the single most-traded ticker
    filtered_trades = [t for t in trades if (t.get("confidence") or 0) >= floor]
    if filtered_trades:
        from collections import Counter

        ticker_counts = Counter(t.get("ticker", "?") for t in filtered_trades)
        base["ticker_concentration"] = round(max(ticker_counts.values()) / n, 3)
    else:
        base["ticker_concentration"] = None

    # ── Per-ticker breakdown ──────────────────────────────────────────────── #
    tickers_seen: dict[str, list[dict]] = {}
    for t in filtered_trades:
        tickers_seen.setdefault(t.get("ticker", "?"), []).append(t)

    per_ticker: list[dict[str, Any]] = []
    for tk, tk_trades in sorted(tickers_seen.items()):
        m = _metrics_at_floor(tk_trades, 0.0)  # already filtered
        per_ticker.append({"ticker": tk, **{k: v for k, v in m.items() if k != "cumulative_r"}})

    # ── Floor sweep ───────────────────────────────────────────────────────── #
    floor_sweep: list[dict[str, Any]] = []
    for f in range(0, 105, 5):
        m = _metrics_at_floor(trades, float(f))
        floor_sweep.append(
            {
                "floor": f,
                "win_rate": m["win_rate"],
                "avg_r_multiple": m["avg_r_multiple"],
                "total_trades": m["total_trades"],
            }
        )

    base["per_ticker"] = per_ticker
    base["floor_sweep"] = floor_sweep
    return base


def generate_experiment_candidates(run: dict[str, Any]) -> list[dict[str, Any]]:
    """Generate parameter-change candidates for the experiment selector.

    The backend produces these; the LLM only selects among them — it never
    invents parameter values.  Each candidate is a one-variable change with
    a hypothesis, expected effect, success/failure criteria, and overfitting
    risk level.
    """
    metrics = run.get("metrics") or {}
    sweep: list[dict] = metrics.get("floor_sweep") or []
    cur_floor = float(run.get("confidence_floor") or 65)
    cur_atr = float(run.get("atr_multiple") or 1.5)
    cur_hold = int(run.get("max_hold_days") or 10)
    cur_avg_r = round(metrics.get("avg_r_multiple") or 0.0, 3)

    candidates: list[dict[str, Any]] = []

    # ── Floor candidates: top-3 sweep entries with ≥10 trades ────────────── #
    eligible = [
        e
        for e in sweep
        if (e.get("total_trades") or 0) >= 10 and e.get("floor") != round(cur_floor / 5) * 5
    ]
    for entry in sorted(eligible, key=lambda e: e.get("avg_r_multiple") or 0, reverse=True)[:3]:
        f = entry["floor"]
        direction = "Raising" if f > cur_floor else "Lowering"
        wr_pct = round((entry.get("win_rate") or 0) * 100, 1)
        ar = entry.get("avg_r_multiple") or 0
        candidates.append(
            {
                "candidate_id": f"floor_{f}",
                "hypothesis": f"{direction} confidence floor from {cur_floor:.0f} to {f}",
                "changes": {"confidence_floor": f},
                "kept_constant": ["atr_multiple", "reward_risk", "max_hold_days"],
                "diagnostic_support": [
                    f"Sweep at floor {f}: {wr_pct}% win rate, avg_R={ar}, "
                    f"{entry.get('total_trades')} trades"
                ],
                "expected_effect": (
                    "Fewer trades with higher average quality"
                    if f > cur_floor
                    else "More trades at lower average quality threshold"
                ),
                "success_criteria": [f"avg_r > {round(cur_avg_r + 0.05, 2)} with ≥10 trades"],
                "failure_criteria": [f"avg_r ≤ {cur_avg_r} OR trade count < 10"],
                "overfitting_risk": "medium" if len(sweep) > 15 else "low",
            }
        )

    # ── ATR candidates ────────────────────────────────────────────────────── #
    for new_atr, label, effect in [
        (
            round(cur_atr + 0.5, 2),
            "wider stop",
            "Fewer premature exits; increases exposure per trade",
        ),
        (
            round(max(0.5, cur_atr - 0.25), 2),
            "tighter stop",
            "Higher R on winners; more stop-outs",
        ),
    ]:
        if new_atr != cur_atr:
            candidates.append(
                {
                    "candidate_id": f"atr_{new_atr}",
                    "hypothesis": f"ATR multiple {cur_atr} → {new_atr} ({label})",
                    "changes": {"atr_multiple": new_atr},
                    "kept_constant": [
                        "confidence_floor",
                        "reward_risk",
                        "max_hold_days",
                    ],
                    "diagnostic_support": [
                        "ATR multiple controls stop-loss width and R-multiple distribution"
                    ],
                    "expected_effect": effect,
                    "success_criteria": [f"avg_r improves vs current ({cur_avg_r})"],
                    "failure_criteria": [f"avg_r ≤ {cur_avg_r} after fee stress"],
                    "overfitting_risk": "low",
                }
            )

    # ── Hold-day candidates ───────────────────────────────────────────────── #
    for new_hold, label, effect in [
        (
            cur_hold + 5,
            "longer hold",
            "Captures full price swing; reduces timeout exits",
        ),
        (
            max(3, cur_hold - 3),
            "shorter hold",
            "Reduces open-trade exposure; exits earlier",
        ),
    ]:
        if new_hold != cur_hold:
            candidates.append(
                {
                    "candidate_id": f"hold_{new_hold}",
                    "hypothesis": f"Max hold {cur_hold} → {new_hold} days ({label})",
                    "changes": {"max_hold_days": new_hold},
                    "kept_constant": [
                        "confidence_floor",
                        "atr_multiple",
                        "reward_risk",
                    ],
                    "diagnostic_support": [
                        "Max hold affects the timeout-exit rate and average trade duration"
                    ],
                    "expected_effect": effect,
                    "success_criteria": [f"avg_r improves vs current ({cur_avg_r})"],
                    "failure_criteria": [f"avg_r ≤ {cur_avg_r}"],
                    "overfitting_risk": "low",
                }
            )

    return candidates


# --------------------------------------------------------------------------- #
# Per-ticker worker (used by ThreadPoolExecutor in run_backtest)
# --------------------------------------------------------------------------- #
def _process_ticker(
    ticker: str,
    params: BacktestParams,
    all_days: list[date],
    use_1h: bool,
    run_id: int,
    rpm_throttle: _RpmThrottle,
    llm_semaphore: threading.Semaphore,
    stop_event: threading.Event,
    emit: Callable[[dict[str, Any]], None],
    db_path: str | None,
    *,
    on_day_done: Callable[[], int] | None = None,
    total_steps: int = 1,
) -> dict[str, Any]:
    """Process one ticker end-to-end: OHLCV fetch → day replay → trade save.

    Returns a dict with keys:
      trades, llm_calls, llm_prompt_tokens, llm_completion_tokens,
      warnings, quota_stopped (bool), quota_stop_event (dict | None).
    """
    import pandas as pd

    from .analysis import LLMError, analyze
    from .data import atr, fetch_ohlcv_range
    from .database import save_backtest_trade
    from .opportunities import detect_opportunities

    start_d = date.fromisoformat(params.start_date)
    end_d = date.fromisoformat(params.end_date)

    emit({"type": "progress", "ticker": ticker, "day": None, "pct": None})
    _log.info("backtest ▶ %s  %s → %s", ticker, params.start_date, params.end_date)

    # --- OHLCV download (cache-first; network only on first ever run) -----------
    lead_1d = (start_d - timedelta(days=_1D_LEADIN_DAYS)).isoformat()
    fetch_end = (end_d + timedelta(days=params.max_hold_days + 5)).isoformat()
    df_1d = fetch_ohlcv_range(ticker, lead_1d, fetch_end, interval="1d")

    df_1h = pd.DataFrame()
    if use_1h:
        lead_1h = (start_d - timedelta(days=_1H_LEADIN_DAYS)).isoformat()
        df_1h = fetch_ohlcv_range(ticker, lead_1h, fetch_end, interval="1h")

    if df_1d.empty:
        return {
            "trades": [],
            "llm_calls": 0,
            "llm_prompt_tokens": 0,
            "llm_completion_tokens": 0,
            "warnings": [f"{ticker}: no 1D OHLCV data — skipped."],
            "quota_stopped": False,
            "quota_stop_event": None,
        }

    # TZ-aware index required for slicing.
    if df_1d.index.tzinfo is None:  # type: ignore[union-attr]
        df_1d.index = df_1d.index.tz_localize("UTC")  # type: ignore[assignment]
    if not df_1h.empty and df_1h.index.tzinfo is None:  # type: ignore[union-attr]
        df_1h.index = df_1h.index.tz_localize("UTC")  # type: ignore[assignment]

    atr_val = atr(df_1d)

    trades: list[dict[str, Any]] = []
    warnings: list[str] = []
    llm_calls = 0
    llm_prompt_tokens = 0
    llm_completion_tokens = 0
    total_days = len(all_days)

    for day_idx, day in enumerate(all_days):
        if stop_event.is_set():
            break

        pct = round(day_idx / max(total_days, 1) * 100)
        global_steps = on_day_done() if on_day_done else (day_idx + 1)
        overall_pct = round(global_steps / max(total_steps, 1) * 100)
        emit(
            {
                "type": "progress",
                "ticker": ticker,
                "day": day.isoformat(),
                "pct": overall_pct,  # global progress for the bar
                "ticker_pct": pct,  # per-ticker progress (for label)
            }
        )

        if params.scan_interval_minutes >= 1440:
            scan_times: list[datetime] = [
                datetime(day.year, day.month, day.day, 23, 59, 59, tzinfo=timezone.utc)
            ]
        else:
            scan_times = _intraday_timestamps(day, params.scan_interval_minutes)

        eod_ts = pd.Timestamp(
            datetime(day.year, day.month, day.day, 23, 59, 59, tzinfo=timezone.utc)
        )
        forward = df_1d[df_1d.index > eod_ts]
        seen_today: set[tuple] = set()

        for scan_ts in scan_times:
            if stop_event.is_set():
                break

            md = build_market_data_asof(ticker, scan_ts, df_1h, df_1d)

            analysis: dict[str, Any] | None = None
            if params.use_llm:
                rpm_throttle.wait()
                with llm_semaphore:
                    try:
                        analysis = analyze(md, memory={}, use_fallback=True)
                        llm_calls += 1
                        llm_prompt_tokens += analysis.get("prompt_tokens") or 0
                        llm_completion_tokens += analysis.get("completion_tokens") or 0
                    except LLMError as exc:
                        stop_event.set()
                        quota_evt = {
                            "type": "quota_stop",
                            "ticker": ticker,
                            "day": day.isoformat(),
                            "msg": str(exc),
                        }
                        emit(quota_evt)
                        _log.warning(
                            "backtest LLM quota exhausted on %s %s: %s",
                            ticker,
                            day,
                            exc,
                        )
                        return {
                            "trades": trades,
                            "llm_calls": llm_calls,
                            "llm_prompt_tokens": llm_prompt_tokens,
                            "llm_completion_tokens": llm_completion_tokens,
                            "warnings": warnings,
                            "quota_stopped": True,
                            "quota_stop_event": quota_evt,
                        }

            opps = detect_opportunities(md, analysis, ai_floor_override=0.0)

            for opp in opps:
                opp = synthesize_bracket(opp, atr_val, params.atr_multiple, params.reward_risk)
                sig_key = (opp.get("type"), round(opp.get("entry") or 0, 4))
                if sig_key in seen_today:
                    continue
                seen_today.add(sig_key)

                result = evaluate_outcome(
                    opp, forward, params.max_hold_days, cashout_r=params.cashout_r
                )
                trade: dict[str, Any] = {
                    "ticker": ticker.upper(),
                    "signal_date": day.isoformat(),
                    "type": opp.get("type"),
                    "confidence": opp.get("confidence"),
                    "source": opp.get("source"),
                    "entry": opp.get("entry"),
                    "stop": opp.get("stop"),
                    "target": opp.get("target"),
                    "reasons": opp.get("reasons", []),
                    **result,
                }
                trades.append(trade)
                save_backtest_trade(
                    run_id,
                    ticker,
                    day.isoformat(),
                    opp.get("type", "long"),
                    opp.get("confidence", 0.0),
                    source=opp.get("source"),
                    entry=opp.get("entry"),
                    stop=opp.get("stop"),
                    target=opp.get("target"),
                    exit_date=result.get("exit_date"),
                    exit_price=result.get("exit_price"),
                    outcome=result.get("outcome"),
                    r_multiple=result.get("r_multiple"),
                    reasons=opp.get("reasons", []),
                    db_path=db_path,
                )

    # ── Buy-and-hold benchmark data for this ticker ──────────────────────────
    # Slice df_1d to the replay window (after the lead-in) so BH starts on
    # start_date and ends on end_date — same period the signals were captured.
    import pandas as _pd

    _start_ts = _pd.Timestamp(params.start_date).tz_localize("UTC")
    _end_ts = _pd.Timestamp(params.end_date).tz_localize("UTC")
    _bh_slice = df_1d[(df_1d.index >= _start_ts) & (df_1d.index <= _end_ts)]
    if not _bh_slice.empty:
        _bh_start = float(_bh_slice["Close"].iloc[0])
        _bh_end = float(_bh_slice["Close"].iloc[-1])
        _bh_daily = [
            {"date": idx.strftime("%Y-%m-%d"), "close": float(row["Close"])}
            for idx, row in _bh_slice.iterrows()
        ]
        _bh_return_pct = round((_bh_end / _bh_start - 1) * 100, 3) if _bh_start else None
    else:
        _bh_start = _bh_end = _bh_return_pct = None
        _bh_daily = []

    return {
        "trades": trades,
        "llm_calls": llm_calls,
        "llm_prompt_tokens": llm_prompt_tokens,
        "llm_completion_tokens": llm_completion_tokens,
        "warnings": warnings,
        "quota_stopped": False,
        "quota_stop_event": None,
        "buy_and_hold": {
            "start_price": _bh_start,
            "end_price": _bh_end,
            "return_pct": _bh_return_pct,
            "daily_closes": _bh_daily,
        },
    }


# --------------------------------------------------------------------------- #
# Main orchestrator
# --------------------------------------------------------------------------- #
def run_backtest(
    params: BacktestParams,
    *,
    emit: Callable[[dict[str, Any]], None] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    """Run the full backtest, persist results, and return the report.

    *emit* is an optional callback called with SSE-style event dicts so the
    API endpoint can stream progress to the browser.  It is called
    synchronously from this blocking function (which runs in a thread).

    Returns a dict with keys: ``run_id``, ``metrics``, ``trades`` (summary),
    ``warnings``.
    """
    from .analysis import LLMError, _effective_provider  # noqa: F401
    from .database import get_setting as _get_db_setting
    from .database import save_backtest_run, update_backtest_run

    def _emit(event: dict[str, Any]) -> None:
        if emit:
            try:
                emit(event)
            except Exception as exc:
                _log.debug("emit ✗: %s", exc)

    start_d = date.fromisoformat(params.start_date)
    end_d = date.fromisoformat(params.end_date)
    today = date.today()

    _bt_provider = _effective_provider() if params.use_llm else None
    if params.use_llm:
        _model_from_db = _get_db_setting("llm_model") or ""
        _prov_env_key = f"{(_bt_provider or '').upper()}_MODEL"
        _model_from_env = os.environ.get(_prov_env_key) or os.environ.get("LLM_MODEL") or ""
        _bt_model = (_model_from_db or _model_from_env).strip() or None
    else:
        _bt_model = None

    run_id = save_backtest_run(
        params.tickers,
        params.start_date,
        params.end_date,
        initial_balance=params.initial_balance,
        confidence_floor=params.confidence_floor,
        max_hold_days=params.max_hold_days,
        signal_mode="llm" if params.use_llm else "rules",
        atr_multiple=params.atr_multiple,
        reward_risk=params.reward_risk,
        requests_per_minute=params.requests_per_minute,
        scan_interval_minutes=params.scan_interval_minutes,
        llm_provider=_bt_provider,
        llm_model=_bt_model,
        is_out_of_sample=params.is_out_of_sample,
        db_path=db_path,
    )

    warnings: list[str] = []
    all_trades: list[dict[str, Any]] = []
    bh_per_ticker: dict[str, dict] = {}  # ticker → buy_and_hold data

    age_days = (today - start_d).days
    use_1h = age_days <= _1H_MAX_AGE_DAYS
    if not use_1h:
        warnings.append(
            f"start_date is > {_1H_MAX_AGE_DAYS} days ago — 1H/4H data unavailable; "
            "only 1D-based rules will fire."
        )

    all_days: list[date] = []
    d = start_d
    while d <= end_d:
        if d.weekday() < 5:
            all_days.append(d)
        d += timedelta(days=1)

    # --- Shared concurrency primitives ------------------------------------
    total_steps = len(params.tickers) * max(len(all_days), 1)
    _steps_done = [0]
    _last_emitted_pct = [-1]  # monotone guard — never let bar go backwards
    emit_lock = threading.Lock()
    steps_lock = threading.Lock()

    def _safe_emit(evt: dict[str, Any]) -> None:
        with emit_lock:
            # Drop out-of-order progress events so the bar never regresses.
            # Race: thread A increments counter to 5 (25%), thread B to 6 (30%).
            # B acquires emit_lock first and emits 30%; then A would emit 25% —
            # discard it instead.
            if evt.get("type") == "progress" and evt.get("pct") is not None:
                if evt["pct"] < _last_emitted_pct[0]:
                    return
                _last_emitted_pct[0] = evt["pct"]
            _emit(evt)

    def _on_day_done() -> int:
        """Atomically increment the global step counter; return new value."""
        with steps_lock:
            _steps_done[0] += 1
            return _steps_done[0]

    rpm_throttle = _RpmThrottle(params.requests_per_minute)
    llm_semaphore = threading.Semaphore(params.max_concurrent_llm)
    stop_event = threading.Event()

    llm_calls = 0
    llm_prompt_tokens = 0
    llm_completion_tokens = 0
    quota_stopped = False

    try:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=params.max_concurrent_tickers,
            thread_name_prefix="bt",
        ) as pool:
            future_to_ticker = {
                pool.submit(
                    _process_ticker,
                    ticker,
                    params,
                    all_days,
                    use_1h,
                    run_id,
                    rpm_throttle,
                    llm_semaphore,
                    stop_event,
                    _safe_emit,
                    db_path,
                    on_day_done=_on_day_done,
                    total_steps=total_steps,
                ): ticker
                for ticker in params.tickers
            }

            for future in concurrent.futures.as_completed(future_to_ticker):
                ticker = future_to_ticker[future]
                try:
                    res = future.result()
                except Exception as exc:
                    _log.exception("backtest ticker ✗ %s run_id=%d: %s", ticker, run_id, exc)
                    warnings.append(f"{ticker}: unexpected error — {exc}")
                    continue

                all_trades.extend(res["trades"])
                llm_calls += res["llm_calls"]
                llm_prompt_tokens += res["llm_prompt_tokens"]
                llm_completion_tokens += res["llm_completion_tokens"]
                warnings.extend(res["warnings"])
                if res.get("buy_and_hold", {}).get("start_price"):
                    bh_per_ticker[ticker] = res["buy_and_hold"]

                if res["quota_stopped"]:
                    quota_stopped = True

    except Exception as exc:
        _log.exception("backtest ✗ run_id=%d: %s", run_id, exc)
        update_backtest_run(run_id, status="error", error=str(exc), db_path=db_path)
        raise

    # ── Buy-and-hold aggregation ─────────────────────────────────────────── #
    _bh_result: dict[str, Any] | None = None
    if bh_per_ticker and params.initial_balance > 0:
        _n = len(bh_per_ticker)
        _share = params.initial_balance / _n
        # Union of all dates across all tickers
        _all_dates = sorted(
            {e["date"] for bh in bh_per_ticker.values() for e in bh.get("daily_closes", [])}
        )
        # Forward-fill each ticker's price series to the union date set
        _series: dict[str, dict[str, float]] = {}
        for _tk, _bh in bh_per_ticker.items():
            _closes = {e["date"]: e["close"] for e in _bh.get("daily_closes", [])}
            _last = _bh["start_price"] or 1.0
            _series[_tk] = {}
            for _d in _all_dates:
                if _d in _closes:
                    _last = _closes[_d]
                _series[_tk][_d] = _last
        # Combine into portfolio equity
        _bh_curve: list[dict[str, Any]] = []
        for _d in _all_dates:
            _eq = sum(
                _share * (_series[_tk][_d] / (bh_per_ticker[_tk]["start_price"] or 1))
                for _tk in bh_per_ticker
            )
            _bh_curve.append({"date": _d, "equity": round(_eq, 2)})
        _bh_final = _bh_curve[-1]["equity"] if _bh_curve else params.initial_balance
        _bh_ret = round((_bh_final - params.initial_balance) / params.initial_balance * 100, 2)
        _bh_result = {
            "return_pct": _bh_ret,
            "final_equity": round(_bh_final, 2),
            "daily_equity_curve": _bh_curve,
            "per_ticker": {
                _tk: {
                    "start_price": _bh["start_price"],
                    "end_price": _bh["end_price"],
                    "return_pct": _bh["return_pct"],
                }
                for _tk, _bh in bh_per_ticker.items()
            },
        }

    def _attach_wallet(metrics: dict[str, Any]) -> None:
        """Add wallet simulation data to metrics dict in-place (no schema change)."""
        if params.initial_balance > 0:
            wallet = compute_dollar_metrics(
                all_trades,
                params.initial_balance,
                params.position_size_pct,
                params.confidence_floor,
            )
            if _bh_result:
                wallet["buy_and_hold"] = _bh_result
            metrics["wallet"] = wallet

    if quota_stopped:
        metrics = compute_metrics(all_trades, params.confidence_floor)
        _attach_wallet(metrics)
        if params.cashout_r is not None:
            metrics["cashout_r"] = params.cashout_r
        update_backtest_run(
            run_id,
            status="stopped_quota",
            metrics=metrics,
            llm_calls=llm_calls,
            llm_prompt_tokens=llm_prompt_tokens,
            llm_completion_tokens=llm_completion_tokens,
            db_path=db_path,
        )
        return {
            "run_id": run_id,
            "status": "stopped_quota",
            "signal_mode": "llm" if params.use_llm else "rules",
            "metrics": metrics,
            "trades": all_trades,
            "warnings": warnings,
            "llm_calls": llm_calls,
            "llm_prompt_tokens": llm_prompt_tokens,
            "llm_completion_tokens": llm_completion_tokens,
            "llm_provider": _bt_provider,
            "llm_model": _bt_model,
        }

    metrics = compute_metrics(all_trades, params.confidence_floor)
    _attach_wallet(metrics)
    # Store cashout_r so the frontend can restore it when cloning a run.
    if params.cashout_r is not None:
        metrics["cashout_r"] = params.cashout_r
    update_backtest_run(
        run_id,
        status="done",
        metrics=metrics,
        llm_calls=llm_calls,
        llm_prompt_tokens=llm_prompt_tokens,
        llm_completion_tokens=llm_completion_tokens,
        db_path=db_path,
    )

    _log.info(
        "backtest ✓ run_id=%d  trades=%d  win_rate=%s  avg_R=%s",
        run_id,
        metrics.get("total_trades"),
        metrics.get("win_rate"),
        metrics.get("avg_r_multiple"),
    )
    return {
        "run_id": run_id,
        "status": "done",
        "signal_mode": "llm" if params.use_llm else "rules",
        "metrics": metrics,
        "trades": all_trades,
        "warnings": warnings,
        "llm_calls": llm_calls,
        "llm_prompt_tokens": llm_prompt_tokens,
        "llm_completion_tokens": llm_completion_tokens,
        "llm_provider": _bt_provider,
        "llm_model": _bt_model,
    }
