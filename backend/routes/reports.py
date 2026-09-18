"""Reports — GET /reports/eod and GET /reports/llm-summary.

``/reports/eod`` builds a deterministic end-of-day digest from today's signals and
paper orders. ``/reports/llm-summary`` narrates a daily/weekly performance summary
via the LLM (compute-then-narrate) and falls back to the deterministic digest on any
LLM failure. Both fan out to every configured notification channel (ntfy + Telegram).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from backend.database import (
    delete_report_record,
    get_frac_positions,
    get_paper_orders,
    get_recent_signals,
    get_report_records,
    save_event,
    save_report_record,
)

router = APIRouter(tags=["reports"])
_log = logging.getLogger(__name__)


def _economics(all_orders: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute all-time economics from the full order history."""
    closed = [o for o in all_orders if o.get("realized_pnl") is not None]
    wins = [o for o in closed if (o["realized_pnl"] or 0) > 0]
    losses = [o for o in closed if (o["realized_pnl"] or 0) < 0]
    open_pos = [
        o
        for o in all_orders
        if o.get("realized_pnl") is None
        and o.get("status") in ("filled", "partially_filled", "accepted")
    ]

    total_pnl = sum(o["realized_pnl"] for o in closed)
    win_pnl = sum(o["realized_pnl"] for o in wins)
    loss_pnl = sum(o["realized_pnl"] for o in losses)
    win_rate = len(wins) / len(closed) * 100 if closed else None
    notional_open = sum((o.get("notional") or 0) for o in open_pos)

    return {
        "closed_trades": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "open_positions": len(open_pos),
        "total_pnl": total_pnl,
        "win_pnl": win_pnl,
        "loss_pnl": loss_pnl,
        "win_rate": win_rate,
        "notional_open": notional_open,
    }


def _frac_economics(all_frac: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute all-time economics from the full fractional position history."""
    closed = [f for f in all_frac if f.get("realized_pnl") is not None]
    wins = [f for f in closed if (f["realized_pnl"] or 0) > 0]
    losses = [f for f in closed if (f["realized_pnl"] or 0) < 0]
    open_pos = [f for f in all_frac if f.get("status") == "open"]
    total_pnl = sum(f["realized_pnl"] for f in closed)
    notional_open = sum((f.get("notional") or 0) for f in open_pos)
    return {
        "closed_trades": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "open_positions": len(open_pos),
        "total_pnl": total_pnl,
        "win_rate": len(wins) / len(closed) * 100 if closed else None,
        "notional_open": notional_open,
    }


def _build_eod(
    signals_today: list[dict[str, Any]],
    orders_today: list[dict[str, Any]],
    all_orders: list[dict[str, Any]],
    date_str: str,
    frac_today: list[dict[str, Any]] | None = None,
    all_frac: list[dict[str, Any]] | None = None,
    window_label: str = "today",
) -> tuple[str, str]:
    """Return (subject, body) for the digest. *window_label* names the activity
    window in section headers (e.g. "today" for EoD, "this week" for weekly)."""

    subject = f"MarketSage EoD — {date_str}"
    eco = _economics(all_orders)

    lines: list[str] = [f"📊 {subject}", ""]

    # ── Paper bracket economics ───────────────────────────────────────────────
    lines.append("── Paper bracket (all-time) ──")
    if eco["closed_trades"] > 0:
        wr = f"{eco['win_rate']:.0f}%" if eco["win_rate"] is not None else "n/a"
        pnl_sign = "+" if eco["total_pnl"] >= 0 else ""
        lines.append(f"  Total P&L   : {pnl_sign}{eco['total_pnl']:.2f}")
        lines.append(f"  Wins        : {eco['wins']}  (+{eco['win_pnl']:.2f})")
        lines.append(f"  Losses      : {eco['losses']}  ({eco['loss_pnl']:.2f})")
        lines.append(f"  Win rate    : {wr}  ({eco['wins']}/{eco['closed_trades']} closed)")
    else:
        lines.append("  No closed bracket trades yet.")
    if eco["open_positions"]:
        lines.append(
            f"  Open pos    : {eco['open_positions']}  (~${eco['notional_open']:.0f} at risk)"
        )

    # ── Fractional economics ──────────────────────────────────────────────────
    if all_frac is not None:
        feco = _frac_economics(all_frac)
        lines.append("")
        lines.append("── Fractional (all-time) ──")
        if feco["closed_trades"] > 0:
            fwr = f"{feco['win_rate']:.0f}%" if feco["win_rate"] is not None else "n/a"
            fpnl_sign = "+" if feco["total_pnl"] >= 0 else ""
            lines.append(f"  Total P&L   : {fpnl_sign}{feco['total_pnl']:.2f}")
            lines.append(f"  Win rate    : {fwr}  ({feco['wins']}/{feco['closed_trades']} closed)")
        else:
            lines.append("  No closed fractional trades yet.")
        if feco["open_positions"]:
            lines.append(
                f"  Open pos    : {feco['open_positions']}  (~${feco['notional_open']:.0f} at risk)"
            )

    lines.append("")

    # ── Signals ───────────────────────────────────────────────────────────────
    lines.append(f"── Signals {window_label}: {len(signals_today)} ──")
    if signals_today:
        for s in signals_today:
            arrow = "📈" if s.get("type") == "long" else "📉"
            conf = s.get("confidence") or 0
            sig_type = s.get("type", "?").upper()
            lines.append(f"  {arrow} {s['ticker']:<6}  {sig_type:<5}  {conf:.0f}%")
    else:
        lines.append("  (none)")

    lines.append("")

    # ── Paper bracket orders ──────────────────────────────────────────────────
    lines.append(f"── Bracket orders {window_label}: {len(orders_today)} ──")
    if orders_today:
        for o in orders_today:
            status = (o.get("status") or "pending").replace("_", " ").upper()
            side = (o.get("side") or "?").upper()
            pnl = o.get("realized_pnl")
            pnl_str = f"  P&L {pnl:+.2f}" if pnl is not None else ""
            icon = "✅" if "fill" in status.lower() else "🕐"
            lines.append(f"  {icon} {o['ticker']:<6}  {side:<4}  {status}{pnl_str}")
    else:
        lines.append("  (none)")

    # ── Fractional positions today ────────────────────────────────────────────
    if frac_today is not None:
        lines.append("")
        frac_closed_today = [f for f in frac_today if f.get("status") == "closed"]
        frac_open_today = [f for f in frac_today if f.get("status") == "open"]
        lines.append(
            f"── Fractional {window_label}: {len(frac_closed_today)} closed, "
            f"{len(frac_open_today)} open ──"
        )
        for f in frac_closed_today:
            reason = (f.get("exit_reason") or "closed").replace("_", " ")
            pnl = f.get("realized_pnl")
            pnl_str = f"  P&L {pnl:+.2f}" if pnl is not None else ""
            lines.append(f"  ✅ {f['ticker']:<6}  {reason}{pnl_str}")
        for f in frac_open_today:
            notional = f.get("notional") or 0
            lines.append(f"  🕐 {f['ticker']:<6}  open  ~${notional:.0f}")
        if not frac_closed_today and not frac_open_today:
            lines.append("  (none)")

    lines.append("")
    lines.append("Not financial advice · MarketSage")

    body = "\n".join(lines)
    return subject, body


@router.get("/reports/eod")
def eod_report() -> dict[str, Any]:
    """Generate and dispatch the end-of-day summary digest."""

    today_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Today's signals — filter by created_at date
    all_signals, _ = get_recent_signals(limit=200)
    signals_today = [s for s in all_signals if (s.get("created_at") or "").startswith(today_utc)]

    # Today's paper orders
    all_orders = get_paper_orders(limit=200)
    orders_today = [o for o in all_orders if (o.get("created_at") or "").startswith(today_utc)]

    # Today's fractional positions (opened or closed today)
    all_frac = get_frac_positions(limit=500)
    frac_today = [
        f
        for f in all_frac
        if (f.get("opened_at") or "").startswith(today_utc)
        or (f.get("closed_at") or "").startswith(today_utc)
    ]

    eco = _economics(all_orders)
    feco = _frac_economics(all_frac)
    subject, digest = _build_eod(
        signals_today,
        orders_today,
        all_orders,
        today_utc,
        frac_today=frac_today,
        all_frac=all_frac,
    )

    top_bracket = sorted(
        (o for o in orders_today if o.get("realized_pnl") is not None),
        key=lambda o: abs(o.get("realized_pnl") or 0),
        reverse=True,
    )[:5]
    top_frac = sorted(
        (f for f in frac_today if f.get("realized_pnl") is not None),
        key=lambda f: abs(f.get("realized_pnl") or 0),
        reverse=True,
    )[:5]
    context = _report_context("daily", eco, feco, signals_today, top_bracket, top_frac)
    metrics = _combined_metrics("daily", eco, feco, signals_today, top_bracket, top_frac)

    # One LLM call → short notification version + full analyst report.
    headline, notification_body, full_body, used_llm, model = _compose_report(
        "daily", subject, digest, context, metrics
    )

    from backend.alerts import send_report

    # Fan out to BOTH ntfy and Telegram — send the short notification version.
    results = send_report(subject, notification_body, tags="bar_chart", priority="default")
    if not any(results.values()):
        raise HTTPException(
            status_code=502,
            detail="EoD report reached no channel — enable/configure ntfy or Telegram.",
        )

    report_id = save_report_record(
        report_type="eod",
        report_date=today_utc,
        headline=headline,
        notification_body=notification_body,
        full_body=full_body,
        channels=results,
        llm=used_llm,
        model=model,
    )
    save_event(
        "report",
        f"EoD report generated — {headline}",
        meta={"report_id": report_id, "llm": used_llm, "model": model, "date": today_utc},
    )

    return {
        "id": report_id,
        "date": today_utc,
        "signals_count": len(signals_today),
        "bracket_orders_count": len(orders_today),
        "frac_positions_count": len(frac_today),
        "bracket_economics": eco,
        "frac_economics": feco,
        "llm": used_llm,
        "model": model,
        "headline": headline,
        "notification_body": notification_body,
        "full_body": full_body,
        "channels": results,
    }


# --------------------------------------------------------------------------- #
# LLM analyst reports — externalised prompts, one call → notification + full
# --------------------------------------------------------------------------- #
_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"


def _render_prompt(filename: str, tokens: dict[str, str]) -> str:
    """Load a report prompt from backend/prompts/ and fill its {{TOKEN}} slots."""
    text = (_PROMPTS_DIR / filename).read_text(encoding="utf-8")
    for key, value in tokens.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def _current_tuning() -> dict[str, str]:
    """Effective values of the tunable knobs (DB override → env default), keyed by
    their env-var name so the analyst can reference them precisely in suggestions."""
    from backend.config import get_settings
    from backend.database import get_setting

    cfg = get_settings()
    th = cfg.thresholds
    at = cfg.autotrade
    disc = cfg.discovery

    def _ov(key: str, fallback: Any) -> str:
        """DB setting override if present, else the config/env default."""
        v = get_setting(key, "")
        return v if v != "" else str(fallback)

    return {
        "RSI_OVERSOLD": _ov("rsi_oversold", th.rsi_oversold),
        "RSI_OVERBOUGHT": _ov("rsi_overbought", th.rsi_overbought),
        "VOLUME_SPIKE_MULTIPLIER": _ov("volume_spike_multiplier", th.volume_spike_multiplier),
        "SIGNIFICANT_MOVE_PCT": _ov("significant_move_pct", th.significant_move_pct),
        "CONFIDENCE_FLOOR": _ov("confidence_floor", th.confidence_floor),
        "FRAC_MIN_CONFIDENCE": _ov("frac_min_confidence", at.frac_min_confidence),
        "PAPER_TRADE_MIN_CONFIDENCE": _ov(
            "paper_trade_min_confidence", at.paper_trade_min_confidence
        ),
        "PAPER_MAX_POSITIONS": _ov("paper_max_positions", at.paper_max_positions),
        "SIGNAL_DROP_MODE": _ov("signal_drop_mode", at.signal_drop_mode),
        "DISCOVERY_MIN_SCORE": _ov("discovery_min_score", disc.min_score),
        "DISCOVERY_AUTOADD_ENABLED": _ov("discovery_autoadd_enabled", disc.autoadd_enabled),
        "DISCOVERY_AUTOADD_TOP_N": _ov("discovery_autoadd_top_n", disc.autoadd_top_n),
    }


def _report_context(
    period: str,
    eco: dict[str, Any],
    feco: dict[str, Any],
    signals: list[dict[str, Any]],
    top_bracket: list[dict[str, Any]],
    top_frac: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the compact, numbers-only context handed to the LLM analyst."""
    return {
        "period": period,
        "bracket_economics": eco,
        "frac_economics": feco,
        "signals_count": len(signals),
        "signals": [
            {"ticker": s["ticker"], "type": s.get("type"), "confidence": s.get("confidence")}
            for s in signals[:20]
        ],
        "top_bracket_movers": [
            {"ticker": o["ticker"], "side": o.get("side"), "pnl": o.get("realized_pnl")}
            for o in top_bracket
        ],
        "top_frac_movers": [
            {
                "ticker": f["ticker"],
                "pnl": f.get("realized_pnl"),
                "exit_reason": f.get("exit_reason"),
            }
            for f in top_frac
        ],
    }


def _combined_metrics(
    period: str,
    eco: dict[str, Any],
    feco: dict[str, Any],
    signals: list[dict[str, Any]],
    top_bracket: list[dict[str, Any]],
    top_frac: list[dict[str, Any]],
) -> dict[str, str]:
    """Compute the headline figures interpolated into the prompt + notification."""
    total = (eco.get("total_pnl") or 0) + (feco.get("total_pnl") or 0)
    closed = (eco.get("closed_trades") or 0) + (feco.get("closed_trades") or 0)
    wins = (eco.get("wins") or 0) + (feco.get("wins") or 0)
    win_rate = f"{wins / closed * 100:.0f}%" if closed else "n/a"
    sign = "+" if total >= 0 else ""
    movers = [f"{o['ticker']} {o.get('realized_pnl'):+.2f}" for o in (top_bracket + top_frac)[:5]]
    return {
        "PERIOD": "this week" if period == "weekly" else "today",
        "TOTAL_PNL": f"{sign}${total:.2f}",
        "WIN_RATE": win_rate,
        "CLOSED_TRADES": str(closed),
        "SIGNALS_COUNT": str(len(signals)),
        "TOP_MOVERS": ", ".join(movers) or "none",
        "_pnl_line": f"P&L {sign}${total:.2f} · Win rate {win_rate} · {closed} closed",
    }


def _llm_report(
    prompt_file: str, context: dict[str, Any], metrics: dict[str, str]
) -> tuple[dict | None, str | None]:
    """One LLM call producing both report versions.

    Returns ``(data, model)``: the parsed analyst dict (or None on failure) and the
    model that generated it (or None on failure). The dict carries keys
    {headline, notification, commentary, patterns, suggestions, tuning}.
    """
    from backend.analysis import LLMError, call_llm

    tokens = {k: v for k, v in metrics.items() if not k.startswith("_")}
    tokens["CONTEXT_JSON"] = json.dumps(context, default=str)
    tokens["TUNING_CONFIG"] = "\n".join(f"{k}={v}" for k, v in _current_tuning().items())
    prompt = _render_prompt(prompt_file, tokens)
    try:
        raw, model, _pt, _ct = call_llm(
            prompt,
            system_prompt="You are a precise trading analyst. Return only compact JSON.",
            use_fallback=True,
        )
        # Strip markdown code fences that some providers (e.g. Gemini) add around JSON.
        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw, count=1)
            raw = re.sub(r"\s*```\s*$", "", raw)
            raw = raw.strip()
        data = json.loads(raw)
    except (LLMError, ValueError, TypeError, OSError) as exc:
        _log.warning("LLM report generation failed: %s", exc)
        save_event("report", f"LLM report failed: {exc}", level="error", meta={"error": str(exc)})
        return None, None
    if not isinstance(data, dict) or not (data.get("commentary") or data.get("notification")):
        return None, None
    return data, model


def _fmt_tuning(items: list[Any]) -> list[str]:
    """Render the analyst's tuning recommendations as readable lines.

    Each item is either a plain string or a dict
    {setting, current, suggested, reason}; both shapes degrade gracefully.
    """
    lines: list[str] = []
    for it in items:
        if isinstance(it, dict):
            setting = str(it.get("setting") or "").strip()
            current = str(it.get("current") or "").strip()
            suggested = str(it.get("suggested") or "").strip()
            reason = str(it.get("reason") or "").strip()
            if not setting:
                continue
            change = f"{current} → {suggested}" if current or suggested else ""
            head = f"  • {setting}" + (f": {change}" if change else "")
            lines.append(head)
            if reason:
                lines.append(f"      {reason}")
        else:
            s = str(it).strip()
            if s:
                lines.append(f"  • {s}")
    return lines


def _compose_report(
    period: str,
    subject: str,
    digest_body: str,
    context: dict[str, Any],
    metrics: dict[str, str],
) -> tuple[str, str, str, bool, str | None]:
    """Return (headline, notification_body, full_body, used_llm, model).

    One LLM call yields both the short notification text and the full analyst
    report; the hard numbers always come from the deterministic digest. On LLM
    failure both versions degrade to the digest with an 'unavailable' note.
    """
    prompt_file = "report_weekly.md" if period == "weekly" else "report_eod.md"
    data, model = _llm_report(prompt_file, context, metrics)
    pnl_line = metrics.get("_pnl_line", "")

    if not data:
        note = "⚠️ AI analysis unavailable this run — raw summary only."
        notification_body = f"📊 {subject}\n\n{pnl_line}\n\n{note}"
        full_body = f"{digest_body}\n\n{note}"
        return subject, notification_body, full_body, False, None

    headline = str(data.get("headline") or subject).strip()
    notification = str(data.get("notification") or "").strip()
    commentary = str(data.get("commentary") or "").strip()
    patterns = [str(p).strip() for p in (data.get("patterns") or []) if str(p).strip()]
    suggestions = [str(s).strip() for s in (data.get("suggestions") or []) if str(s).strip()]
    tuning = _fmt_tuning(data.get("tuning") or [])

    # Short notification version — sent to ntfy / Telegram.
    notif_lines = [f"📊 {headline}"]
    if notification:
        notif_lines += ["", notification]
    if pnl_line:
        notif_lines += ["", pnl_line]
    notification_body = "\n".join(notif_lines)

    # Full version — digest (accurate numbers) + analyst insights.
    full_lines = [digest_body, "", "── AI analysis ──"]
    if commentary:
        full_lines.append(commentary)
    if patterns:
        full_lines += ["", "Patterns:"] + [f"  • {p}" for p in patterns]
    if suggestions:
        full_lines += ["", "Suggestions:"] + [f"  • {s}" for s in suggestions]
    if tuning:
        full_lines += ["", "Parameter tuning:", *tuning]
    if model:
        full_lines += ["", f"— generated by {model}"]
    full_body = "\n".join(full_lines)

    return headline, notification_body, full_body, True, model


@router.get("/reports/llm-summary")
def llm_summary_report(period: str = "daily") -> dict[str, Any]:
    """Generate a natural-language performance summary via the LLM and dispatch it.

    Compute-then-narrate: every figure is computed in Python (never by the model);
    the LLM only writes prose from a compact structured input. On any LLM/parse
    failure we fall back to the deterministic EoD digest so a report always sends.
    """
    period = "weekly" if str(period).lower().startswith("w") else "daily"
    days = 7 if period == "weekly" else 1
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).strftime("%Y-%m-%d")
    date_str = now.strftime("%Y-%m-%d")

    all_signals, _ = get_recent_signals(limit=500)
    signals = [s for s in all_signals if (s.get("created_at") or "") >= since]
    all_orders = get_paper_orders(limit=500)
    orders = [o for o in all_orders if (o.get("created_at") or "") >= since]
    all_frac = get_frac_positions(limit=500)
    frac_period = [
        f
        for f in all_frac
        if (f.get("opened_at") or "") >= since or (f.get("closed_at") or "") >= since
    ]
    eco = _economics(all_orders)
    feco = _frac_economics(all_frac)

    top_movers = sorted(
        (o for o in orders if o.get("realized_pnl") is not None),
        key=lambda o: abs(o.get("realized_pnl") or 0),
        reverse=True,
    )[:5]
    top_frac_movers = sorted(
        (f for f in frac_period if f.get("realized_pnl") is not None),
        key=lambda f: abs(f.get("realized_pnl") or 0),
        reverse=True,
    )[:5]

    # Deterministic digest carries the accurate numbers (period activity + all-time
    # economics); one LLM call yields both the short notification and full report.
    subject = f"MarketSage {period.capitalize()} Summary — {date_str}"
    window_label = "this week" if period == "weekly" else "today"
    _, digest = _build_eod(
        signals,
        orders,
        all_orders,
        date_str,
        frac_today=frac_period,
        all_frac=all_frac,
        window_label=window_label,
    )
    context = _report_context(period, eco, feco, signals, top_movers, top_frac_movers)
    metrics = _combined_metrics(period, eco, feco, signals, top_movers, top_frac_movers)
    headline, notification_body, full_body, used_llm, model = _compose_report(
        period, subject, digest, context, metrics
    )

    from backend.alerts import send_report

    results = send_report(
        subject, notification_body, tags="chart_with_upwards_trend", priority="default"
    )
    if not any(results.values()):
        raise HTTPException(
            status_code=502,
            detail="LLM report reached no channel — enable/configure ntfy or Telegram.",
        )

    report_id = save_report_record(
        report_type=period,
        report_date=date_str,
        headline=headline,
        notification_body=notification_body,
        full_body=full_body,
        channels=results,
        llm=used_llm,
        model=model,
    )
    save_event(
        "report",
        f"{period.capitalize()} report generated — {headline}",
        meta={"report_id": report_id, "llm": used_llm, "model": model, "date": date_str},
    )

    return {
        "id": report_id,
        "period": period,
        "date": date_str,
        "llm": used_llm,
        "model": model,
        "headline": headline,
        "notification_body": notification_body,
        "full_body": full_body,
        "channels": results,
    }


@router.get("/reports")
def list_reports(
    limit: int = Query(50, ge=1, le=200),
    type: str | None = Query(None, description="Filter by report type: eod | weekly | daily"),
) -> dict[str, Any]:
    """Return persisted reports newest-first (both notification + full bodies)."""
    return {"reports": get_report_records(limit=limit, report_type=type)}


@router.delete("/reports/{report_id}")
def delete_report(report_id: int) -> dict[str, Any]:
    """Delete a persisted report by id."""
    deleted = delete_report_record(report_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"deleted": report_id}
