"""Opportunity detection: fuse AI output with deterministic rule checks.

Combines the LLM's opinion from :mod:`backend.analysis` with a set of
transparent, rule-based technical checks and returns a scored, de-duplicated,
sorted list of trade opportunities.

Rules implemented:

* **AI-detected** — the model returns a ``long``/``short`` opportunity whose
  confidence meets the configured floor.
* **RSI extreme** — RSI is oversold (long) or overbought (short) on 2+ of the
  1H/4H/1D timeframes.
* **Volume spike** — volume >= ``volume_spike_multiplier`` x average *and* the
  day's move exceeds ``significant_move_pct`` (direction follows the move).
* **MACD crossover** — MACD sits above (bullish) / below (bearish) its signal
  line on both the 1D and 4H timeframes.
* **Valuation extreme** — TTM P/E above 60 fires a low-confidence short flag;
  TTM P/E below 8 (positive) fires a low-confidence long flag.
* **Macro regime filter** (post-merge pass) — adjusts confidence ±N points
  based on yield-curve inversion, Shiller CAPE, and CPI.

Run standalone (uses live data + Ollama)::

    python -m backend.opportunities AAPL
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import Thresholds, get_settings

_TIMEFRAMES = ("1H", "4H", "1D")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_candidate(
    ticker: str,
    side: str,
    confidence: float,
    source: str,
    reason: str,
    price: Optional[float],
    *,
    entry: Optional[float] = None,
    stop: Optional[float] = None,
    target: Optional[float] = None,
) -> Dict[str, Any]:
    return {
        "ticker": ticker,
        "type": side,
        "confidence": round(float(confidence), 2),
        "sources": [source],
        "reasons": [reason],
        "entry": entry,
        "stop": stop,
        "target": target,
        "price": price,
        "timestamp": _now_iso(),
    }


# --------------------------------------------------------------------------- #
# Individual rule checks
# --------------------------------------------------------------------------- #
def _check_ai(ticker: str, analysis: Dict[str, Any], price: Optional[float],
              thresholds: Thresholds) -> List[Dict[str, Any]]:
    opp = analysis.get("opportunity")
    if not isinstance(opp, dict):
        return []
    side = (opp.get("type") or "none").lower()
    confidence = float(opp.get("confidence") or 0.0)
    if side not in ("long", "short") or confidence < thresholds.confidence_floor:
        return []
    reason = f"AI model flagged a {side} setup (confidence {confidence:.0f})"
    signals = analysis.get("signals") or []
    if signals:
        reason += "; " + "; ".join(str(s) for s in signals[:3])
    return [
        _new_candidate(
            ticker, side, confidence, "ai", reason, price,
            entry=opp.get("entry"), stop=opp.get("stop"), target=opp.get("target"),
        )
    ]


def _check_rsi(ticker: str, technicals: Dict[str, Any], price: Optional[float],
               thresholds: Thresholds) -> List[Dict[str, Any]]:
    oversold_tfs: List[str] = []
    overbought_tfs: List[str] = []
    for tf in _TIMEFRAMES:
        tdata = technicals.get(tf) or {}
        rsi = tdata.get("RSI")
        if rsi is None:
            continue
        if rsi <= thresholds.rsi_oversold:
            oversold_tfs.append(tf)
        elif rsi >= thresholds.rsi_overbought:
            overbought_tfs.append(tf)

    results: List[Dict[str, Any]] = []
    if len(oversold_tfs) >= 2:
        conf = min(85.0, 55.0 + 10.0 * len(oversold_tfs))
        results.append(
            _new_candidate(
                ticker, "long", conf, "rsi_extreme",
                f"RSI oversold on {', '.join(oversold_tfs)}", price, entry=price,
            )
        )
    if len(overbought_tfs) >= 2:
        conf = min(85.0, 55.0 + 10.0 * len(overbought_tfs))
        results.append(
            _new_candidate(
                ticker, "short", conf, "rsi_extreme",
                f"RSI overbought on {', '.join(overbought_tfs)}", price, entry=price,
            )
        )
    return results


def _check_volume_spike(ticker: str, price_data: Dict[str, Any], price: Optional[float],
                        thresholds: Thresholds) -> List[Dict[str, Any]]:
    ratio = price_data.get("volume_ratio")
    change_pct = price_data.get("change_pct")
    if ratio is None or change_pct is None:
        return []
    if ratio < thresholds.volume_spike_multiplier or abs(change_pct) < thresholds.significant_move_pct:
        return []
    side = "long" if change_pct > 0 else "short"
    conf = min(80.0, 55.0 + min(ratio, 5.0) * 3.0)
    reason = (
        f"Volume spike {ratio:.1f}x avg with {change_pct:+.1f}% move "
        f"({'up' if change_pct > 0 else 'down'})"
    )
    return [_new_candidate(ticker, side, conf, "volume_spike", reason, price, entry=price)]


def _check_macd_crossover(ticker: str, technicals: Dict[str, Any], price: Optional[float],
                          thresholds: Thresholds) -> List[Dict[str, Any]]:
    def hist(tf: str) -> Optional[float]:
        tdata = technicals.get(tf) or {}
        macd = tdata.get("MACD") or {}
        h = macd.get("histogram")
        if h is not None:
            return h
        m, s = macd.get("macd"), macd.get("signal")
        return (m - s) if (m is not None and s is not None) else None

    h_1d, h_4h = hist("1D"), hist("4H")
    if h_1d is None or h_4h is None:
        return []
    if h_1d > 0 and h_4h > 0:
        return [
            _new_candidate(
                ticker, "long", 62.0, "macd_crossover",
                "MACD bullish (above signal) on 1D and 4H", price, entry=price,
            )
        ]
    if h_1d < 0 and h_4h < 0:
        return [
            _new_candidate(
                ticker, "short", 62.0, "macd_crossover",
                "MACD bearish (below signal) on 1D and 4H", price, entry=price,
            )
        ]
    return []


def _check_valuation(
    ticker: str,
    fundamentals: Dict[str, Any],
    price: Optional[float],
) -> List[Dict[str, Any]]:
    """Rule 5 — fire a low-confidence flag at extreme P/E valuations only.

    Intentionally low confidence (40–42) so this rule reinforces rather than
    drives a signal.  Negative P/E (loss-making companies) is skipped.
    """
    try:
        raw = fundamentals.get("trailing_pe") or fundamentals.get("pe_ratio")
        pe = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return []
    if pe is None or pe <= 0:
        return []
    if pe > 60:
        return [_new_candidate(
            ticker, "short", 40.0, "valuation_extreme",
            f"TTM P/E {pe:.1f}× — severely overvalued (>60×)",
            price, entry=price,
        )]
    if pe < 8:
        return [_new_candidate(
            ticker, "long", 42.0, "valuation_cheap",
            f"TTM P/E {pe:.1f}× — deeply discounted (<8×)",
            price, entry=price,
        )]
    return []


def _apply_macro_regime_filter(
    merged: List[Dict[str, Any]],
    macro: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Post-merge confidence adjuster based on the macro regime.

    Applied after :func:`_merge` so every rule's output is treated equally.
    Adjustments are additive and clamped to [0, 100]; the confidence-floor
    filter runs afterwards in :func:`filter_by_confidence`.

    Conditions checked (additive, applied in order):

    * Yield curve inverted  → long −8, short +3
    * CAPE > 35             → long −5, short +3; append reason
    * CAPE < 15             → long +5, short −3; append reason
    * CPI YoY > 5%          → long −5; append reason
    """
    if not macro:
        return merged

    inverted = bool((macro.get("yield_spread") or {}).get("inverted"))
    cape_val = ((macro.get("shiller_cape") or {}).get("value"))
    cpi_val  = ((macro.get("cpi_yoy") or {}).get("value"))

    def _adj(opp: Dict[str, Any]) -> Dict[str, Any]:
        side = opp.get("type", "")
        delta = 0.0
        extra: List[str] = []

        if inverted:
            if side == "long":
                delta -= 8.0
                extra.append("⚠ yield curve inverted — macro headwind for longs")
            else:
                delta += 3.0

        if cape_val is not None:
            if cape_val > 35:
                if side == "long":
                    delta -= 5.0
                    extra.append(f"⚠ Shiller CAPE {cape_val:.0f}× — market elevated")
                else:
                    delta += 3.0
            elif cape_val < 15:
                if side == "long":
                    delta += 5.0
                    extra.append(
                        f"✓ CAPE {cape_val:.0f}× — market historically cheap"
                    )
                else:
                    delta -= 3.0

        if cpi_val is not None and cpi_val > 5.0:
            if side == "long":
                delta -= 5.0
                extra.append(f"⚠ CPI {cpi_val:.1f}% YoY — Fed likely restrictive")

        if delta == 0.0 and not extra:
            return opp
        out = dict(opp)
        out["confidence"] = round(
            max(0.0, min(100.0, out["confidence"] + delta)), 2
        )
        out["reasons"] = list(out.get("reasons", [])) + extra
        return out

    return [_adj(o) for o in merged]


# --------------------------------------------------------------------------- #
# De-duplication + scoring
# --------------------------------------------------------------------------- #
def _merge(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge candidates sharing the same ticker+side.

    The merged confidence is the strongest single signal plus a small
    corroboration bonus for each additional agreeing source.
    """

    merged: Dict[tuple, Dict[str, Any]] = {}
    for cand in candidates:
        key = (cand["ticker"], cand["type"])
        if key not in merged:
            merged[key] = dict(cand)
            merged[key]["sources"] = list(cand["sources"])
            merged[key]["reasons"] = list(cand["reasons"])
            continue

        existing = merged[key]
        base = max(existing["confidence"], cand["confidence"])
        existing["sources"].extend(s for s in cand["sources"] if s not in existing["sources"])
        existing["reasons"].extend(cand["reasons"])
        bonus = 5.0 * (len(existing["sources"]) - 1)
        existing["confidence"] = round(min(100.0, base + bonus), 2)
        # Prefer concrete entry/stop/target when the incoming candidate has them.
        for level in ("entry", "stop", "target"):
            if existing.get(level) is None and cand.get(level) is not None:
                existing[level] = cand[level]
    return list(merged.values())


def detect_opportunities(
    market_data: Dict[str, Any],
    analysis: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Return scored, de-duplicated, sorted opportunities for one ticker.

    ``analysis`` is the dict from :func:`backend.analysis.analyze`. If omitted,
    only rule-based checks run.
    """

    settings = get_settings()
    thresholds = settings.thresholds
    ticker = market_data.get("ticker", "")
    price_data = market_data.get("price", {}) or {}
    technicals = market_data.get("technicals", {}) or {}
    price = price_data.get("current")

    fundamentals = market_data.get("fundamentals", {}) or {}
    macro = market_data.get("macro", {}) or {}

    candidates: List[Dict[str, Any]] = []
    if analysis and not analysis.get("error"):
        candidates.extend(_check_ai(ticker, analysis, price, thresholds))
    candidates.extend(_check_rsi(ticker, technicals, price, thresholds))
    candidates.extend(_check_volume_spike(ticker, price_data, price, thresholds))
    candidates.extend(_check_macd_crossover(ticker, technicals, price, thresholds))
    candidates.extend(_check_valuation(ticker, fundamentals, price))   # Rule 5

    merged = _merge(candidates)
    merged = _apply_macro_regime_filter(merged, macro)                  # Rule 6

    # Finalise the joined ``source`` string for storage.
    for opp in merged:
        opp["source"] = "+".join(opp["sources"])
    merged.sort(key=lambda o: o["confidence"], reverse=True)
    return merged


def filter_by_confidence(
    opportunities: List[Dict[str, Any]],
    floor: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Return only opportunities at or above the confidence *floor*."""

    if floor is None:
        floor = get_settings().thresholds.confidence_floor
    return [o for o in opportunities if o.get("confidence", 0) >= floor]


if __name__ == "__main__":
    import json
    import sys

    from .analysis import analyze
    from .data import get_market_data

    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    md = get_market_data(symbol)
    ai = analyze(md)
    opps = detect_opportunities(md, ai)
    print(json.dumps(opps, indent=2, default=str))
