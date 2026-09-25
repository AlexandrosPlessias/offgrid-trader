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
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from backend.database import (
    delete_report_record,
    get_blocked_event_counts,
    get_frac_positions,
    get_paper_orders,
    get_recent_signals,
    get_report_records,
    get_setting,
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

    lines: list[str] = [f"📊 {subject}", ""]

    # ── Paper bracket economics (omitted for frac-only reports) ──────────────
    if all_orders:
        eco = _economics(all_orders)
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

    # ── Fractional economics (omitted for orders-only reports) ───────────────
    if all_frac is not None:
        feco = _frac_economics(all_frac)
        if all_orders:
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
            # bracket entry (notional set) with no P&L = position still open
            is_open_entry = o.get("notional") is not None and pnl is None
            if is_open_entry:
                icon = "📂"
                pnl_str = "  [position open]"
            elif pnl is not None:
                icon = "✅"
                pnl_str = f"  P&L {pnl:+.2f}"
            else:
                icon = "🕐" if "fill" not in status.lower() else "✅"
                pnl_str = ""
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

    body = "\n".join(lines)
    return subject, body


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


def _current_tuning(mode: str | None = None) -> dict[str, str]:
    """Effective values of the tunable knobs (DB override → env default), keyed by
    their env-var name so the analyst can reference them precisely in suggestions.

    *mode* scopes the flow-specific knobs so a report never suggests a variable
    that doesn't affect its flow: ``"frac"`` omits the bracket-order knobs
    (PAPER_MAX_POSITIONS, PAPER_TRADE_MIN_CONFIDENCE) and ``"orders"`` omits the
    fractional knobs (FRAC_BUDGET, FRAC_POSITION_SIZE, …). ``None`` returns all.
    """
    from backend.config import get_settings
    from backend.database import get_setting

    cfg = get_settings()
    th = cfg.thresholds
    at = cfg.autotrade
    disc = cfg.discovery
    frac = cfg.frac

    def _ov(key: str, fallback: Any) -> str:
        """DB setting override if present, else the config/env default."""
        v = get_setting(key, "")
        return v if v != "" else str(fallback)

    # Signal-generation + discovery knobs — shared by both flows.
    shared = {
        "RSI_OVERSOLD": _ov("rsi_oversold", th.rsi_oversold),
        "RSI_OVERBOUGHT": _ov("rsi_overbought", th.rsi_overbought),
        "VOLUME_SPIKE_MULTIPLIER": _ov("volume_spike_multiplier", th.volume_spike_multiplier),
        "SIGNIFICANT_MOVE_PCT": _ov("significant_move_pct", th.significant_move_pct),
        "CONFIDENCE_FLOOR": _ov("confidence_floor", th.confidence_floor),
        "SIGNAL_DROP_MODE": _ov("signal_drop_mode", at.signal_drop_mode),
        "DISCOVERY_MIN_SCORE": _ov("discovery_min_score", disc.min_score),
        "DISCOVERY_AUTOADD_ENABLED": _ov("discovery_autoadd_enabled", disc.autoadd_enabled),
        "DISCOVERY_AUTOADD_TOP_N": _ov("discovery_autoadd_top_n", disc.autoadd_top_n),
    }
    orders_only = {
        "PAPER_MAX_POSITIONS": _ov("paper_max_positions", at.paper_max_positions),
        "PAPER_TRADE_MIN_CONFIDENCE": _ov(
            "paper_trade_min_confidence", at.paper_trade_min_confidence
        ),
    }
    frac_only = {
        "FRAC_MIN_CONFIDENCE": _ov("frac_min_confidence", at.frac_min_confidence),
        "FRAC_BUDGET": _ov("frac_budget", frac.budget),
        "FRAC_POSITION_SIZE": _ov("frac_position_size", frac.position_size),
        "FRAC_POLL_SECONDS": _ov("frac_poll_seconds", frac.poll_seconds),
    }
    if mode == "frac":
        return {**shared, **frac_only}
    if mode == "orders":
        return {**shared, **orders_only}
    return {**shared, **orders_only, **frac_only}


def _report_context(
    period: str,
    eco: dict[str, Any],
    feco: dict[str, Any],
    signals: list[dict[str, Any]],
    top_bracket: list[dict[str, Any]],
    top_frac: list[dict[str, Any]],
    blocked: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Build the compact, numbers-only context handed to the LLM analyst."""
    ctx: dict[str, Any] = {
        "period": period,
        "bracket_economics": eco,
        "frac_economics": feco,
        "signals_count": len(signals),
        "signals": [
            {
                "ticker": s["ticker"],
                "type": s.get("type"),
                "confidence": s.get("confidence"),
            }
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
    if blocked:
        ctx["blocked_events"] = blocked
    return ctx


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
    prompt_file: str,
    context: dict[str, Any],
    metrics: dict[str, str],
    *,
    report_type: str = "",
) -> tuple[dict | None, str | None, str | None, int, int]:
    """One LLM call producing both report versions.

    Returns ``(data, model, provider, prompt_tokens, completion_tokens)``.
    All values are None/0 on failure.
    """
    from backend.analysis import LLMError, call_llm

    model_override: str | None = None
    provider_override: str | None = None
    if report_type:
        raw_override = get_setting(f"llm_model_{report_type}", "")
        if raw_override:
            if ":" in raw_override:
                provider_override, model_override = raw_override.split(":", 1)
            else:
                model_override = raw_override

    # Resolve effective provider for attribution (override or DB/env primary)
    effective_provider = provider_override or get_setting("llm_provider", "") or "unknown"

    # Scope the tuning knobs to this report's flow so frac reports never suggest
    # bracket-only vars (PAPER_MAX_POSITIONS) and vice-versa.
    tuning_mode = "frac" if "frac" in report_type else ("orders" if report_type else None)
    tokens = {k: v for k, v in metrics.items() if not k.startswith("_")}
    tokens["CONTEXT_JSON"] = json.dumps(context, default=str)
    tokens["TUNING_CONFIG"] = "\n".join(f"{k}={v}" for k, v in _current_tuning(tuning_mode).items())
    prompt = _render_prompt(prompt_file, tokens)
    try:
        raw, model, pt, ct = call_llm(
            prompt,
            system_prompt="You are a precise trading analyst. Return only compact JSON.",
            model=model_override,
            use_fallback=True,
            _primary_provider_override=provider_override,
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
        provider_label = f"{effective_provider}" + (
            f" ({model_override})" if model_override else ""
        )
        save_event(
            "report",
            f"LLM call failed [{provider_label}]: {exc}",
            level="error",
            meta={
                "error": str(exc),
                "provider": effective_provider,
                "model_override": model_override,
            },
        )
        return None, None, None, 0, 0
    if not isinstance(data, dict) or not (data.get("commentary") or data.get("notification")):
        _log.warning("LLM returned unusable response (bad structure) — falling back to digest")
        save_event(
            "report",
            "LLM returned invalid/empty response — report will use digest only",
            level="warn",
            meta={"provider": effective_provider},
        )
        return None, None, None, 0, 0
    return data, model, effective_provider, pt or 0, ct or 0


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
    *,
    prompt_file: str | None = None,
    report_type: str = "",
) -> tuple[str, str, str, bool, str | None, str | None, int, int]:
    """Return (headline, notification_body, full_body, used_llm, model, provider, pt, ct)."""
    if prompt_file is None:
        prompt_file = "report_weekly.md" if period == "weekly" else "report_eod.md"
    data, model, provider, pt, ct = _llm_report(
        prompt_file, context, metrics, report_type=report_type
    )
    pnl_line = metrics.get("_pnl_line", "")

    if not data:
        note = "⚠️ AI analysis unavailable this run — raw summary only."
        notification_body = f"📊 {subject}\n\n{pnl_line}\n\n{note}"
        full_body = f"{digest_body}\n\n{note}"
        save_event(
            "report",
            f"Report generated without AI — digest only ({subject})",
            level="warn",
            meta={"subject": subject, "report_type": report_type},
        )
        return subject, notification_body, full_body, False, None, None, 0, 0

    headline = str(data.get("headline") or subject).strip()
    notification = str(data.get("notification") or "").strip()
    commentary = str(data.get("commentary") or "").strip()
    patterns = [str(p).strip() for p in (data.get("patterns") or []) if str(p).strip()]
    suggestions = [str(s).strip() for s in (data.get("suggestions") or []) if str(s).strip()]
    tuning = _fmt_tuning(data.get("tuning") or [])

    # Short notification version — sent to ntfy / Telegram.
    # Includes: headline · prose summary · top suggestion · top tuning hint.
    notif_lines = [f"📊 {headline}"]
    if notification:
        notif_lines += ["", notification]
    if suggestions:
        notif_lines += ["", f"💡 {suggestions[0]}"]
    if data.get("tuning"):
        top = data["tuning"][0] if isinstance(data["tuning"][0], dict) else None
        if top and top.get("setting"):
            cur = top.get("current", "")
            sug = top.get("suggested", "")
            change = f"{cur} → {sug}" if cur or sug else ""
            hint = f"⚙️ {top['setting']}" + (f": {change}" if change else "")
            if top.get("reason"):
                hint += f" — {top['reason']}"
            notif_lines += ["", hint]
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

    return headline, notification_body, full_body, True, model, provider, pt, ct


def _run_report(
    *,
    report_type: str,
    period: str,
    mode: str,
) -> dict[str, Any]:
    """Shared implementation for the 4 focused report endpoints.

    *report_type*: one of ``eod_frac``, ``eod_orders``, ``weekly_frac``, ``weekly_orders``.
    *period*: ``"eod"`` or ``"weekly"`` — determines the look-back window.
    *mode*: ``"frac"`` or ``"orders"`` — determines which trade data to query.
    """
    days = 7 if period == "weekly" else 1
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).strftime("%Y-%m-%d")
    today_utc = now.strftime("%Y-%m-%d")
    date_str = today_utc

    all_signals, _ = get_recent_signals(limit=500)
    signals = [s for s in all_signals if (s.get("created_at") or "") >= since]

    all_orders = get_paper_orders(limit=500)
    all_frac = get_frac_positions(limit=500)

    orders_period = [o for o in all_orders if (o.get("created_at") or "") >= since]
    frac_period = [
        f
        for f in all_frac
        if (f.get("opened_at") or "") >= since or (f.get("closed_at") or "") >= since
    ]
    eco = _economics(all_orders)
    feco = _frac_economics(all_frac)
    top_bracket = sorted(
        (o for o in orders_period if o.get("realized_pnl") is not None),
        key=lambda o: abs(o.get("realized_pnl") or 0),
        reverse=True,
    )[:5]
    top_frac_movers = sorted(
        (f for f in frac_period if f.get("realized_pnl") is not None),
        key=lambda f: abs(f.get("realized_pnl") or 0),
        reverse=True,
    )[:5]

    # Scope economics, top-movers, and digest to this report's flow so frac and
    # orders reports never show each other's figures.
    _zero_eco = {
        "closed_trades": 0,
        "wins": 0,
        "losses": 0,
        "open_positions": 0,
        "total_pnl": 0.0,
        "win_rate": None,
        "notional_open": 0.0,
    }
    if mode == "frac":
        report_eco = _zero_eco
        report_feco = feco
        report_top_bracket: list[dict] = []
        report_top_frac = top_frac_movers
        window_orders: list[dict] = []
        window_frac = frac_period
    else:
        report_eco = eco
        report_feco = _zero_eco
        report_top_bracket = top_bracket
        report_top_frac = []
        window_orders = orders_period
        window_frac = []

    # Scope blocked-trade counts to this flow: position-cap hits belong to the
    # bracket/orders flow (PAPER_MAX_POSITIONS), budget-cap hits to the frac flow
    # (FRAC_BUDGET). untradable_dropped is signal-level, so it's shown to both.
    all_blocked = get_blocked_event_counts(since)
    if mode == "frac":
        blocked = {
            "budget_cap_hits": all_blocked.get("budget_cap_hits", 0),
            "insufficient_funds_hits": all_blocked.get("insufficient_funds_hits", 0),
            "untradable_dropped": all_blocked.get("untradable_dropped", 0),
        }
    else:
        blocked = {
            "position_cap_hits": all_blocked.get("position_cap_hits", 0),
            "insufficient_funds_hits": all_blocked.get("insufficient_funds_hits", 0),
            "untradable_dropped": all_blocked.get("untradable_dropped", 0),
        }
    context = _report_context(
        period,
        report_eco,
        report_feco,
        signals,
        report_top_bracket,
        report_top_frac,
        blocked,
    )
    metrics = _combined_metrics(
        period, report_eco, report_feco, signals, report_top_bracket, report_top_frac
    )

    # ── Weekly-only: per-day breakdowns so the LLM can do trend/streak analysis ─
    if period == "weekly":
        # Signals by day — confidence drift, recurrence
        sig_by_day: dict = defaultdict(lambda: {"count": 0, "tickers": [], "confidences": []})
        for s in signals:
            day = (s.get("created_at") or "")[:10]
            if day:
                sig_by_day[day]["count"] += 1
                sig_by_day[day]["tickers"].append(s["ticker"])
                if s.get("confidence") is not None:
                    sig_by_day[day]["confidences"].append(s["confidence"])
        context["signals_by_day"] = {
            day: {
                "count": v["count"],
                "tickers": v["tickers"],
                "avg_confidence": (
                    round(sum(v["confidences"]) / len(v["confidences"]), 1)
                    if v["confidences"]
                    else None
                ),
            }
            for day, v in sorted(sig_by_day.items())
        }

        if mode == "orders":
            # Bracket orders by day — day-of-week win/loss clustering
            def _ord_init() -> dict:
                return {"trades": 0, "wins": 0, "losses": 0, "pnl": 0.0, "tickers": []}

            ord_by_day: dict = defaultdict(_ord_init)
            for o in orders_period:
                day = (o.get("created_at") or "")[:10]
                if day and o.get("realized_pnl") is not None:
                    ord_by_day[day]["trades"] += 1
                    ord_by_day[day]["tickers"].append(o["ticker"])
                    pnl = o.get("realized_pnl") or 0
                    ord_by_day[day]["pnl"] += pnl
                    if pnl > 0:
                        ord_by_day[day]["wins"] += 1
                    elif pnl < 0:
                        ord_by_day[day]["losses"] += 1
            context["bracket_by_day"] = {
                day: {**v, "pnl": round(v["pnl"], 2)} for day, v in sorted(ord_by_day.items())
            }

        if mode == "frac":
            # Frac positions by close date — win/loss streaks, daily P&L
            def _frac_init() -> dict:
                return {"closed": 0, "wins": 0, "losses": 0, "pnl": 0.0, "tickers": []}

            frac_by_day: dict = defaultdict(_frac_init)
            for f in frac_period:
                day = (f.get("closed_at") or f.get("opened_at") or "")[:10]
                if day and f.get("status") == "closed":
                    frac_by_day[day]["closed"] += 1
                    frac_by_day[day]["tickers"].append(f["ticker"])
                    pnl = f.get("realized_pnl") or 0
                    frac_by_day[day]["pnl"] += pnl
                    if pnl > 0:
                        frac_by_day[day]["wins"] += 1
                    elif pnl < 0:
                        frac_by_day[day]["losses"] += 1
            context["frac_by_day"] = {
                day: {**v, "pnl": round(v["pnl"], 2)} for day, v in sorted(frac_by_day.items())
            }

        # Inject stored EoD daily summaries so the weekly LLM can reference
        # what the model itself wrote each day instead of re-deriving patterns.
        eod_type = "eod_frac" if mode == "frac" else "eod_orders"
        recent_eods = get_report_records(limit=5, report_type=eod_type)
        if recent_eods:
            context["daily_summaries"] = [
                {
                    "date": r.get("report_date"),
                    "headline": r.get("headline"),
                    "summary": r.get("notification_body"),
                }
                for r in reversed(recent_eods)  # oldest first
            ]

    label = "Weekly" if period == "weekly" else "EoD"
    mode_label = "Fractional" if mode == "frac" else "Orders"
    subject = f"MarketSage {label} {mode_label} — {date_str}"
    window_label = "this week" if period == "weekly" else "today"
    _, digest = _build_eod(
        signals,
        window_orders,
        all_orders if mode == "orders" else [],
        date_str,
        frac_today=window_frac if mode == "frac" else None,
        all_frac=all_frac if mode == "frac" else None,
        window_label=window_label,
    )

    headline, notification_body, full_body, used_llm, model, llm_provider, pt, ct = _compose_report(
        period,
        subject,
        digest,
        context,
        metrics,
        prompt_file=f"report_{report_type}.md",
        report_type=report_type,
    )

    from backend.alerts import send_report

    results = send_report(
        subject, notification_body, tags="chart_with_upwards_trend", priority="default"
    )

    report_id = save_report_record(
        report_type=report_type,
        report_date=date_str,
        headline=headline,
        notification_body=notification_body,
        full_body=full_body,
        channels=results,
        llm=used_llm,
        model=model,
        llm_provider=llm_provider,
        prompt_tokens=pt,
        completion_tokens=ct,
        context_json=json.dumps(context, default=str),
    )
    save_event(
        "report",
        f"{label} {mode_label} report generated — {headline}",
        level="info" if used_llm else "warn",
        meta={
            "report_id": report_id,
            "report_type": report_type,
            "llm": used_llm,
            "model": model,
        },
    )

    return {
        "id": report_id,
        "report_type": report_type,
        "period": period,
        "mode": mode,
        "date": date_str,
        "llm": used_llm,
        "model": model,
        "headline": headline,
        "notification_body": notification_body,
        "full_body": full_body,
        "blocked_events": blocked,
        "channels": results,
    }


@router.get("/reports/eod/frac")
def eod_frac_report() -> dict[str, Any]:
    """Generate today's fractional trade EoD report."""
    return _run_report(report_type="eod_frac", period="eod", mode="frac")


@router.get("/reports/eod/orders")
def eod_orders_report() -> dict[str, Any]:
    """Generate today's bracket orders EoD report."""
    return _run_report(report_type="eod_orders", period="eod", mode="orders")


@router.get("/reports/weekly/frac")
def weekly_frac_report() -> dict[str, Any]:
    """Generate the 7-day fractional trade weekly report."""
    return _run_report(report_type="weekly_frac", period="weekly", mode="frac")


@router.get("/reports/weekly/orders")
def weekly_orders_report() -> dict[str, Any]:
    """Generate the 7-day bracket orders weekly report."""
    return _run_report(report_type="weekly_orders", period="weekly", mode="orders")


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
