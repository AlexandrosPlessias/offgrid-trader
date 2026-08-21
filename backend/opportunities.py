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
from typing import Any

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
    price: float | None,
    *,
    entry: float | None = None,
    stop: float | None = None,
    target: float | None = None,
) -> dict[str, Any]:
    conf = round(float(confidence), 2)
    return {
        "ticker": ticker,
        "type": side,
        "confidence": conf,
        "sources": [source],
        "reasons": [reason],
        "entry": entry,
        "stop": stop,
        "target": target,
        "price": price,
        "timestamp": _now_iso(),
        # Transparent score audit trail — carried through merge and macro filter.
        "score_breakdown": {
            "sources_detail": [{"source": source, "confidence": conf}],
            "base": conf,        # max of individual source confidences
            "bonus": 0.0,        # 5 × (sources − 1) corroboration bonus
            "pre_macro": conf,   # base + bonus before macro adjustment
            "macro_delta": 0.0,  # net macro regime adjustment (negative = headwind)
            "final": conf,       # pre_macro + macro_delta (== stored confidence)
        },
    }


# --------------------------------------------------------------------------- #
# Individual rule checks
# --------------------------------------------------------------------------- #
def _check_ai(
    ticker: str, analysis: dict[str, Any], price: float | None, thresholds: Thresholds
) -> list[dict[str, Any]]:
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
            ticker,
            side,
            confidence,
            "ai",
            reason,
            price,
            entry=opp.get("entry"),
            stop=opp.get("stop"),
            target=opp.get("target"),
        )
    ]


def _check_rsi(
    ticker: str, technicals: dict[str, Any], price: float | None, thresholds: Thresholds
) -> list[dict[str, Any]]:
    oversold_tfs: list[str] = []
    overbought_tfs: list[str] = []
    for tf in _TIMEFRAMES:
        tdata = technicals.get(tf) or {}
        rsi = tdata.get("RSI")
        if rsi is None:
            continue
        if rsi <= thresholds.rsi_oversold:
            oversold_tfs.append(tf)
        elif rsi >= thresholds.rsi_overbought:
            overbought_tfs.append(tf)

    results: list[dict[str, Any]] = []
    if len(oversold_tfs) >= 2:
        conf = min(85.0, 55.0 + 10.0 * len(oversold_tfs))
        results.append(
            _new_candidate(
                ticker,
                "long",
                conf,
                "rsi_extreme",
                f"RSI oversold on {', '.join(oversold_tfs)}",
                price,
                entry=price,
            )
        )
    if len(overbought_tfs) >= 2:
        conf = min(85.0, 55.0 + 10.0 * len(overbought_tfs))
        results.append(
            _new_candidate(
                ticker,
                "short",
                conf,
                "rsi_extreme",
                f"RSI overbought on {', '.join(overbought_tfs)}",
                price,
                entry=price,
            )
        )
    return results


def _check_volume_spike(
    ticker: str, price_data: dict[str, Any], price: float | None, thresholds: Thresholds
) -> list[dict[str, Any]]:
    ratio = price_data.get("volume_ratio")
    change_pct = price_data.get("change_pct")
    if ratio is None or change_pct is None:
        return []
    if (
        ratio < thresholds.volume_spike_multiplier
        or abs(change_pct) < thresholds.significant_move_pct
    ):
        return []
    side = "long" if change_pct > 0 else "short"
    conf = min(80.0, 55.0 + min(ratio, 5.0) * 3.0)
    reason = (
        f"Volume spike {ratio:.1f}x avg with {change_pct:+.1f}% move "
        f"({'up' if change_pct > 0 else 'down'})"
    )
    return [_new_candidate(ticker, side, conf, "volume_spike", reason, price, entry=price)]


def _macd_hist(tf: str, technicals: dict[str, Any]) -> float | None:
    """Return the MACD histogram value for *tf*, or None if unavailable."""
    tdata = technicals.get(tf) or {}
    macd = tdata.get("MACD") or {}
    h = macd.get("histogram")
    if h is not None:
        return h
    m, s = macd.get("macd"), macd.get("signal")
    return (m - s) if (m is not None and s is not None) else None


def _check_macd_crossover(
    ticker: str, technicals: dict[str, Any], price: float | None, thresholds: Thresholds
) -> list[dict[str, Any]]:
    h_1d, h_4h = _macd_hist("1D", technicals), _macd_hist("4H", technicals)
    if h_1d is None or h_4h is None:
        return []
    if h_1d > 0 and h_4h > 0:
        return [
            _new_candidate(
                ticker,
                "long",
                62.0,
                "macd_crossover",
                "MACD bullish (above signal) on 1D and 4H",
                price,
                entry=price,
            )
        ]
    if h_1d < 0 and h_4h < 0:
        return [
            _new_candidate(
                ticker,
                "short",
                62.0,
                "macd_crossover",
                "MACD bearish (below signal) on 1D and 4H",
                price,
                entry=price,
            )
        ]
    return []


def _check_valuation(
    ticker: str,
    fundamentals: dict[str, Any],
    price: float | None,
) -> list[dict[str, Any]]:
    """Rule 5 — fire a low-confidence flag at extreme P/E valuations only.

    Intentionally low confidence (40-42) so this rule reinforces rather than
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
        return [
            _new_candidate(
                ticker,
                "short",
                40.0,
                "valuation_extreme",
                f"TTM P/E {pe:.1f}× -- severely overvalued (>60×)",  # noqa: RUF001
                price,
                entry=price,
            )
        ]
    if pe < 8:
        return [
            _new_candidate(
                ticker,
                "long",
                42.0,
                "valuation_cheap",
                f"TTM P/E {pe:.1f}× — deeply discounted (<8×)",  # noqa: RUF001
                price,
                entry=price,
            )
        ]
    return []


def _apply_macro_regime_filter(  # noqa: C901
    merged: list[dict[str, Any]],
    macro: dict[str, Any],
) -> list[dict[str, Any]]:
    """Post-merge confidence adjuster based on the macro regime.

    Applied after :func:`_merge` so every rule's output is treated equally.
    Adjustments are additive and clamped to [0, 100]; the confidence-floor
    filter runs afterwards in :func:`filter_by_confidence`.

    Conditions checked (additive, applied in order):

    * Yield curve inverted  -> long -8, short +3
    * CAPE > 35             -> long -5, short +3; append reason
    * CAPE < 15             -> long +5, short -3; append reason
    * CPI YoY > 5%          -> long -5; append reason
    """
    if not macro:
        return merged

    inverted = bool((macro.get("yield_spread") or {}).get("inverted"))
    cape_val = (macro.get("shiller_cape") or {}).get("value")
    cpi_val = (macro.get("cpi_yoy") or {}).get("value")

    def _adj(opp: dict[str, Any]) -> dict[str, Any]:  # noqa: C901
        side = opp.get("type", "")
        delta = 0.0
        extra: list[str] = []

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
                    msg = f"⚠ Shiller CAPE {cape_val:.0f}× — market elevated"  # noqa: RUF001
                    extra.append(msg)
                else:
                    delta += 3.0
            elif cape_val < 15:
                if side == "long":
                    delta += 5.0
                    msg = f"✓ CAPE {cape_val:.0f}× — market historically cheap"  # noqa: RUF001
                    extra.append(msg)
                else:
                    delta -= 3.0

        if cpi_val is not None and cpi_val > 5.0:
            if side == "long":
                delta -= 5.0
                extra.append(f"⚠ CPI {cpi_val:.1f}% YoY — Fed likely restrictive")

        if delta == 0.0 and not extra:
            return opp
        out = dict(opp)
        out["confidence"] = round(max(0.0, min(100.0, out["confidence"] + delta)), 2)
        out["reasons"] = list(out.get("reasons", [])) + extra
        # Record macro delta in the score breakdown for UI transparency.
        bd = dict(out.get("score_breakdown", {}))
        bd["macro_delta"] = round(delta, 2)
        bd["final"] = out["confidence"]
        out["score_breakdown"] = bd
        return out

    return [_adj(o) for o in merged]


# --------------------------------------------------------------------------- #
# De-duplication + scoring
# --------------------------------------------------------------------------- #
def _merge(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge candidates sharing the same ticker+side.

    The merged confidence is the strongest individual source confidence plus a
    corroboration bonus for each additional agreeing source (5 pts per extra source).

    The ``_source_max`` internal field tracks the true maximum of the *original*
    per-source confidences so that iterative merging never inflates the base.
    """

    merged: dict[tuple, dict[str, Any]] = {}
    for cand in candidates:
        key = (cand["ticker"], cand["type"])
        cand_conf = cand["confidence"]
        if key not in merged:
            out = dict(cand)
            out["sources"] = list(cand["sources"])
            out["reasons"] = list(cand["reasons"])
            out["score_breakdown"] = dict(cand.get("score_breakdown", {}))
            out["score_breakdown"]["sources_detail"] = list(
                cand.get("score_breakdown", {}).get("sources_detail", [])
            )
            out["_source_max"] = cand_conf  # tracks true max of original source confs
            merged[key] = out
            continue

        existing = merged[key]
        existing["_source_max"] = max(existing["_source_max"], cand_conf)
        existing["sources"].extend(s for s in cand["sources"] if s not in existing["sources"])
        existing["reasons"].extend(cand["reasons"])
        base = existing["_source_max"]
        bonus = 5.0 * (len(existing["sources"]) - 1)
        merged_conf = round(min(100.0, base + bonus), 2)
        existing["confidence"] = merged_conf

        # Carry the per-source detail forward in the breakdown.
        bd = existing["score_breakdown"]
        for sd in cand.get("score_breakdown", {}).get("sources_detail", []):
            if not any(x["source"] == sd["source"] for x in bd["sources_detail"]):
                bd["sources_detail"].append(sd)
        bd["base"] = round(base, 2)
        bd["bonus"] = round(bonus, 2)
        bd["pre_macro"] = merged_conf
        bd["final"] = merged_conf

        # Prefer concrete entry/stop/target when the incoming candidate has them.
        for level in ("entry", "stop", "target"):
            if existing.get(level) is None and cand.get(level) is not None:
                existing[level] = cand[level]

    # Strip internal tracking field before returning.
    result = list(merged.values())
    for opp in result:
        opp.pop("_source_max", None)
    return result


def detect_opportunities(
    market_data: dict[str, Any],
    analysis: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
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

    candidates: list[dict[str, Any]] = []
    ai_cands: list[dict[str, Any]] = []
    if analysis and not analysis.get("error"):
        ai_cands = _check_ai(ticker, analysis, price, thresholds)
        candidates.extend(ai_cands)
    rsi_cands   = _check_rsi(ticker, technicals, price, thresholds)
    vol_cands   = _check_volume_spike(ticker, price_data, price, thresholds)
    macd_cands  = _check_macd_crossover(ticker, technicals, price, thresholds)
    val_cands   = _check_valuation(ticker, fundamentals, price)
    candidates.extend(rsi_cands)
    candidates.extend(vol_cands)
    candidates.extend(macd_cands)
    candidates.extend(val_cands)

    merged = _merge(candidates)
    merged = _apply_macro_regime_filter(merged, macro)  # Rule 6

    # Build per-rule diagnostic snapshot (actual values, whether rule fired).
    # Attached to every merged opportunity's score_breakdown for UI transparency.
    rsi_values = {tf: (technicals.get(tf) or {}).get("RSI") for tf in _TIMEFRAMES}
    vol_ratio  = price_data.get("volume_ratio")
    change_pct = price_data.get("change_pct")
    h_1d       = _macd_hist("1D", technicals)
    h_4h       = _macd_hist("4H", technicals)
    try:
        pe_raw = fundamentals.get("trailing_pe") or fundamentals.get("pe_ratio")
        pe_val = float(pe_raw) if pe_raw is not None else None
    except (TypeError, ValueError):
        pe_val = None
    ai_opp = (analysis or {}).get("opportunity") or {}

    def _r(v: float | None, decimals: int = 2) -> float | None:
        return round(v, decimals) if v is not None else None

    rules_checked: dict[str, Any] = {
        "ai": {
            "fired": bool(ai_cands),
            "type": (ai_opp.get("type") or "none").lower() if analysis else None,
            "confidence": _r(float(ai_opp.get("confidence") or 0), 0) if analysis else None,
        },
        "rsi_extreme": {
            "fired": bool(rsi_cands),
            "values": {tf: _r(v, 1) for tf, v in rsi_values.items()},
            "oversold":   [tf for tf, v in rsi_values.items() if v is not None and v <= thresholds.rsi_oversold],
            "overbought": [tf for tf, v in rsi_values.items() if v is not None and v >= thresholds.rsi_overbought],
            "threshold_low":  thresholds.rsi_oversold,
            "threshold_high": thresholds.rsi_overbought,
        },
        "volume_spike": {
            "fired": bool(vol_cands),
            "ratio": _r(vol_ratio, 2),
            "change_pct": _r(change_pct, 2),
            "threshold_ratio": thresholds.volume_spike_multiplier,
            "threshold_move":  thresholds.significant_move_pct,
        },
        "macd_crossover": {
            "fired": bool(macd_cands),
            "hist_1d": _r(h_1d, 4),
            "hist_4h": _r(h_4h, 4),
        },
        "valuation": {
            "fired": bool(val_cands),
            "pe": _r(pe_val, 1),
            "threshold_high": 60,
            "threshold_low":  8,
        },
    }

    for opp in merged:
        opp["score_breakdown"]["rules_checked"] = rules_checked

    # Finalise the joined ``source`` string for storage.
    for opp in merged:
        opp["source"] = "+".join(opp["sources"])
    merged.sort(key=lambda o: o["confidence"], reverse=True)
    return merged


def filter_by_confidence(
    opportunities: list[dict[str, Any]],
    floor: float | None = None,
) -> list[dict[str, Any]]:
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
