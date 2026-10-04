"""Reports — GET /reports/eod and GET /reports/llm-summary.

``/reports/eod`` builds a deterministic end-of-day digest from today's signals and
paper orders. ``/reports/llm-summary`` narrates a daily/weekly performance summary
via the LLM (compute-then-narrate) and falls back to the deterministic digest on any
LLM failure. Both fan out to every configured notification channel (ntfy + Telegram).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.database import (
    delete_report_record,
    get_blocked_event_counts,
    get_frac_economics_all_time,
    get_frac_positions_between,
    get_order_economics_all_time,
    get_paper_orders_between,
    get_report_records,
    get_setting,
    get_signals_between,
    save_event,
    save_report_record,
)
from backend.routes._models import _log_safe

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
    order_eco: dict[str, Any] | None,
    date_str: str,
    frac_today: list[dict[str, Any]] | None = None,
    frac_eco: dict[str, Any] | None = None,
    window_label: str = "today",
) -> tuple[str, str]:
    """Return (subject, body) for the digest. *window_label* names the activity
    window in section headers (e.g. "today" for EoD, "this week" for weekly).
    *order_eco* / *frac_eco* are all-time economics; ``None`` omits that section."""

    subject = f"MarketSage EoD — {date_str}"

    lines: list[str] = [f"📊 {subject}", ""]

    # ── Paper bracket economics (omitted for frac-only reports) ──────────────
    if order_eco is not None:
        eco = order_eco
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
    if frac_eco is not None:
        feco = frac_eco
        if order_eco is not None:
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
    # Allowlist lookup: the path comes from the directory listing, never from the caller.
    path = {p.name: p for p in _PROMPTS_DIR.glob("*.md")}.get(filename)
    if path is None:
        raise FileNotFoundError(f"Unknown report prompt: {filename!r}")
    text = path.read_text(encoding="utf-8")
    for key, value in tokens.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def _resolve_model_override(setting_key: str) -> tuple[str | None, str | None]:
    """Split a ``provider:model`` (or bare ``model``) override setting.

    Returns ``(provider_override, model_override)``; both None when unset.
    """
    raw = get_setting(setting_key, "") if setting_key else ""
    if not raw:
        return None, None
    if ":" in raw:
        provider, model = raw.split(":", 1)
        return provider or None, model or None
    return None, raw


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


# Allowed values per knob, shown next to each value in the prompt so the analyst can't
# propose a value the Settings API would reject (e.g. SIGNAL_DROP_MODE=none).
_TUNING_ALLOWED: dict[str, str] = {
    "RSI_OVERSOLD": "0-100",
    "RSI_OVERBOUGHT": "0-100",
    "VOLUME_SPIKE_MULTIPLIER": "number >= 0 (x average volume)",
    "SIGNIFICANT_MOVE_PCT": "percent > 0 (env-only)",
    "CONFIDENCE_FLOOR": "0-100",
    "SIGNAL_DROP_MODE": (
        "exactly one of untradable | strict | never. untradable drops signals that can "
        "neither bracket nor frac; strict is currently identical; never keeps them but they "
        "still cannot be ordered — no mode turns an untradable signal into a trade"
    ),
    "DISCOVERY_MIN_SCORE": "0-100",
    "DISCOVERY_AUTOADD_ENABLED": "true | false",
    "DISCOVERY_AUTOADD_TOP_N": "integer 1-25",
    "PAPER_MAX_POSITIONS": "integer 0-100",
    "PAPER_TRADE_MIN_CONFIDENCE": "0-100 (0 = use CONFIDENCE_FLOOR)",
    "FRAC_MIN_CONFIDENCE": "0-100",
    "FRAC_BUDGET": "dollars >= 0",
    "FRAC_POSITION_SIZE": "dollars >= 0",
    "FRAC_POLL_SECONDS": "integer >= 10",
}


def _render_tuning(tuning: dict[str, Any]) -> str:
    """One ``KEY=value  (allowed: …)`` line per knob for the analyst prompt."""
    lines = []
    for key, value in tuning.items():
        allowed = _TUNING_ALLOWED.get(key)
        lines.append(f"{key}={value}  (allowed: {allowed})" if allowed else f"{key}={value}")
    return "\n".join(lines)


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
    window_label: str,
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
        "PERIOD": window_label,
        "WINDOW_LABEL": window_label,
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
    model_setting_key: str | None = None,
) -> tuple[dict | None, str | None, str | None, int, int]:
    """One LLM call producing both report versions.

    *model_setting_key* names the ``provider:model`` override setting; it
    defaults to ``llm_model_{report_type}``.

    Returns ``(data, model, provider, prompt_tokens, completion_tokens)``.
    All values are None/0 on failure.
    """
    from backend.analysis import LLMError, call_llm

    key = model_setting_key or (f"llm_model_{report_type}" if report_type else "")
    provider_override, model_override = _resolve_model_override(key)

    # Resolve effective provider for attribution (override or DB/env primary)
    effective_provider = provider_override or get_setting("llm_provider", "") or "unknown"

    # The persisted snapshot is already scoped to this report's flow, so frac
    # reports never suggest bracket-only vars (PAPER_MAX_POSITIONS) and vice-versa.
    tuning = context.get("tuning") or _current_tuning(None)
    tokens = {k: v for k, v in metrics.items() if not k.startswith("_")}
    tokens["CONTEXT_JSON"] = json.dumps(context, default=str)
    tokens["TUNING_CONFIG"] = _render_tuning(tuning)
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
    model_setting_key: str | None = None,
) -> tuple[str, str, str, bool, str | None, str | None, int, int]:
    """Return (headline, notification_body, full_body, used_llm, model, provider, pt, ct)."""
    if prompt_file is None:
        prompt_file = "report_weekly.md" if period == "weekly" else "report_eod.md"
    data, model, provider, pt, ct = _llm_report(
        prompt_file,
        context,
        metrics,
        report_type=report_type,
        model_setting_key=model_setting_key,
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


_PERIOD_DAYS = {"eod": 1, "weekly": 7, "monthly": 30, "quarterly": 90, "yearly": 365}
_RANGE_PERIODS = {"monthly", "quarterly", "yearly", "custom"}
_MAX_RANGE_DAYS = 3 * 366
_PERIOD_LABELS = {
    "eod": "EoD",
    "weekly": "Weekly",
    "monthly": "Monthly",
    "quarterly": "Quarterly",
    "yearly": "Yearly",
    "custom": "Custom",
}


def _bucket_granularity(days: int) -> str:
    """≤31 days → day · ≤1 year → week · longer → month."""
    if days <= 31:
        return "day"
    if days <= 366:
        return "week"
    return "month"


def _bucket_key(ts: str, granularity: str) -> str:
    """Map an ISO timestamp to its bucket label (day, ISO-week Monday, or month)."""
    day = ts[:10]
    if not day or granularity == "day":
        return day
    if granularity == "month":
        return day[:7]
    try:
        d = date.fromisoformat(day)
    except ValueError:
        return day
    return (d - timedelta(days=d.weekday())).isoformat()


def _window_label(period: str, start: str, end: str) -> str:
    return {
        "eod": "today",
        "weekly": "this week",
        "monthly": "the last 30 days",
        "quarterly": "the last 90 days",
        "yearly": "the last 365 days",
    }.get(period, f"{start} to {end}")


def _run_report(
    *,
    report_type: str,
    period: str,
    mode: str,
    start: date | None = None,
    end: date | None = None,
    notify: bool = True,
) -> dict[str, Any]:
    """Shared implementation for every report endpoint.

    *report_type*: ``{period}_{mode}``, e.g. ``eod_frac`` or ``quarterly_orders``.
    *period*: ``eod`` · ``weekly`` · ``monthly`` · ``quarterly`` · ``yearly`` · ``custom``.
    *mode*: ``"frac"`` or ``"orders"`` — determines which trade data to query.
    *start* / *end*: inclusive dates, required for ``custom`` and ignored otherwise.
    *notify*: fan the notification version out to ntfy / Telegram.
    """
    now = datetime.now(timezone.utc)
    if period == "custom":
        if start is None or end is None:
            raise ValueError("custom reports need start and end dates")
        since_d, last_d = start, end
    else:
        # Inclusive window of exactly N calendar days ending today (EoD = today only).
        since_d = (now - timedelta(days=_PERIOD_DAYS[period] - 1)).date()
        last_d = now.date()
    until_d = last_d + timedelta(days=1)
    since = since_d.isoformat()
    until = until_d.isoformat()
    date_str = last_d.isoformat()
    window_days = (until_d - since_d).days
    granularity = _bucket_granularity(window_days)
    window_label = _window_label(period, since, date_str)

    # Window-scoped in SQL: no row cap, so long ranges are never silently truncated.
    signals = get_signals_between(since, until)
    # A position closed after the window belongs to the window it closed in, so
    # consecutive windows never both count it. Legacy rows without closed_at fall
    # back to created_at.
    orders_period = [
        o
        for o in get_paper_orders_between(since, until)
        if not (o.get("closed_at") and o["closed_at"] >= until)
    ]
    frac_period = [
        f
        for f in get_frac_positions_between(since, until)
        if not (f.get("closed_at") and f["closed_at"] >= until)
    ]
    eco = get_order_economics_all_time()
    feco = get_frac_economics_all_time()
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
        window_eco = _frac_economics(frac_period)
    else:
        report_eco = eco
        report_feco = _zero_eco
        report_top_bracket = top_bracket
        report_top_frac = []
        window_orders = orders_period
        window_frac = []
        window_eco = _economics(orders_period)

    # Scope blocked-trade counts to this flow: position-cap hits belong to the
    # bracket/orders flow (PAPER_MAX_POSITIONS), budget-cap hits to the frac flow
    # (FRAC_BUDGET). untradable_dropped is signal-level, so it's shown to both.
    all_blocked = get_blocked_event_counts(since, until)
    if mode == "frac":
        blocked = {
            "budget_cap_hits": all_blocked.get("budget_cap_hits", 0),
            "insufficient_funds_hits": all_blocked.get("insufficient_funds_hits", 0),
            "untradable_dropped": all_blocked.get("untradable_dropped", 0),
            "untradable_tickers": all_blocked.get("untradable_tickers", 0),
        }
    else:
        blocked = {
            "position_cap_hits": all_blocked.get("position_cap_hits", 0),
            "insufficient_funds_hits": all_blocked.get("insufficient_funds_hits", 0),
            "untradable_dropped": all_blocked.get("untradable_dropped", 0),
            "untradable_tickers": all_blocked.get("untradable_tickers", 0),
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
    # Persisted so two reports can later be compared on their own window and
    # on the settings that were actually in force when each was generated.
    context["mode"] = mode
    context["window"] = {"start": since, "end": date_str, "days": window_days}
    context["window_economics"] = window_eco
    context["tuning"] = _current_tuning(mode)
    metrics = _combined_metrics(
        window_label, report_eco, report_feco, signals, report_top_bracket, report_top_frac
    )

    # ── Multi-day reports: bucketed breakdowns for trend/streak analysis ──────
    if period != "eod":
        context["bucket_granularity"] = granularity
        # Signals by bucket — confidence drift, recurrence
        sig_by_day: dict = defaultdict(lambda: {"count": 0, "tickers": [], "confidences": []})
        for s in signals:
            day = _bucket_key(s.get("created_at") or "", granularity)
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
            # Bracket orders by bucket — win/loss clustering
            def _ord_init() -> dict:
                return {"trades": 0, "wins": 0, "losses": 0, "pnl": 0.0, "tickers": []}

            ord_by_day: dict = defaultdict(_ord_init)
            for o in orders_period:
                day = _bucket_key(o.get("closed_at") or o.get("created_at") or "", granularity)
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
            # Frac positions by close bucket — win/loss streaks, P&L
            def _frac_init() -> dict:
                return {"closed": 0, "wins": 0, "losses": 0, "pnl": 0.0, "tickers": []}

            frac_by_day: dict = defaultdict(_frac_init)
            for f in frac_period:
                day = _bucket_key(f.get("closed_at") or f.get("opened_at") or "", granularity)
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

    if period == "weekly":
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

    label = _PERIOD_LABELS[period]
    mode_label = "Fractional" if mode == "frac" else "Orders"
    date_part = f"{since} → {date_str}" if period in _RANGE_PERIODS else date_str
    subject = f"MarketSage {label} {mode_label} — {date_part}"
    _, digest = _build_eod(
        signals,
        window_orders,
        eco if mode == "orders" else None,
        date_str,
        frac_today=window_frac if mode == "frac" else None,
        frac_eco=feco if mode == "frac" else None,
        window_label=window_label,
    )

    is_range = period in _RANGE_PERIODS
    headline, notification_body, full_body, used_llm, model, llm_provider, pt, ct = _compose_report(
        period,
        subject,
        digest,
        context,
        metrics,
        prompt_file=f"report_range_{mode}.md" if is_range else f"report_{report_type}.md",
        report_type=report_type,
        model_setting_key="llm_model_range" if is_range else None,
    )

    results: dict[str, Any] = {}
    if notify:
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
        "window": context["window"],
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


@router.get("/reports/range")
def range_report(
    mode: str = Query(..., pattern="^(frac|orders)$"),
    period: str | None = Query(None, pattern="^(monthly|quarterly|yearly)$"),
    start: date | None = Query(None, description="Inclusive start date (custom range)"),
    end: date | None = Query(None, description="Inclusive end date (custom range)"),
    notify: bool = Query(False, description="Also send the notification to ntfy / Telegram"),
) -> dict[str, Any]:
    """Generate an on-demand report over a preset period or an explicit date range.

    Pass either ``period`` (monthly · quarterly · yearly) or both ``start`` and ``end``.
    """
    if period and (start or end):
        raise HTTPException(status_code=422, detail="Pass either period or start/end, not both.")
    if not period:
        if start is None or end is None:
            raise HTTPException(status_code=422, detail="Pass a period, or both start and end.")
        if start > end:
            raise HTTPException(status_code=422, detail="start must not be after end.")
        if end > datetime.now(timezone.utc).date():
            raise HTTPException(status_code=422, detail="end must not be in the future.")
        if (end - start).days + 1 > _MAX_RANGE_DAYS:
            raise HTTPException(
                status_code=422, detail=f"Range too long — maximum is {_MAX_RANGE_DAYS} days."
            )
        period = "custom"
    return _run_report(
        report_type=f"{period}_{mode}",
        period=period,
        mode=mode,
        start=start,
        end=end,
        notify=notify,
    )


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


# --------------------------------------------------------------------------- #
# Report comparator — deterministic diff (Layer 1) + strict LLM review (Layer 2)
# --------------------------------------------------------------------------- #
# (key, label, higher_is_better). ``None`` = no good/bad direction.
_ECONOMICS_SPECS: list[tuple[str, str, bool | None]] = [
    ("total_pnl", "P&L", True),
    ("win_rate", "Win rate %", True),
    ("closed_trades", "Closed trades", True),
    ("wins", "Wins", True),
    ("losses", "Losses", False),
    ("win_pnl", "Winning P&L", True),
    ("loss_pnl", "Losing P&L", True),  # negative sum — closer to zero is better
    ("open_positions", "Open positions", None),
    ("notional_open", "Notional open", None),
]
_MIN_CLOSED_TRADES = 5
_WINDOW_LENGTH_TOLERANCE = 0.2
_COMPARABILITY_RANK = {"none": 0, "partial": 1, "full": 2}


def _report_ctx(report: dict[str, Any]) -> dict[str, Any] | None:
    try:
        ctx = json.loads(report.get("context_json") or "")
    except (TypeError, ValueError):
        return None
    return ctx if isinstance(ctx, dict) else None


def _report_mode(report: dict[str, Any], ctx: dict[str, Any]) -> str:
    return ctx.get("mode") or (
        "frac" if str(report.get("type", "")).endswith("_frac") else "orders"
    )


def _report_economics(ctx: dict[str, Any], mode: str) -> tuple[dict[str, Any], str]:
    """Return ``(economics, basis)`` — window-scoped when persisted, else the all-time block."""
    if isinstance(ctx.get("window_economics"), dict):
        return ctx["window_economics"], "window"
    key = "frac_economics" if mode == "frac" else "bracket_economics"
    return ctx.get(key) or {}, "all_time"


def _metric_row(key: str, label: str, a: Any, b: Any, higher: bool | None) -> dict[str, Any]:
    a_num = float(a) if isinstance(a, int | float) else None
    b_num = float(b) if isinstance(b, int | float) else None
    delta = b_num - a_num if a_num is not None and b_num is not None else None
    pct = delta / abs(a_num) * 100 if delta is not None and a_num else None
    return {
        "key": key,
        "label": label,
        "a": a_num,
        "b": b_num,
        "delta": round(delta, 4) if delta is not None else None,
        "pct_delta": round(pct, 2) if pct is not None else None,
        "higher_is_better": higher,
    }


def _report_meta(report: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": report["id"],
        "type": report.get("type"),
        "report_date": report.get("report_date"),
        "headline": report.get("headline"),
        "window": ctx.get("window"),
        "llm": bool(report.get("llm")),
        "model": report.get("model"),
        "created_at": report.get("created_at"),
    }


def _order_pair(ra: dict[str, Any], rb: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Put the earlier report first so deltas read as change over time (B - A)."""

    def _key(r: dict[str, Any]) -> tuple[str, int]:
        return (str(r.get("report_date") or ""), int(r["id"]))

    return (ra, rb) if _key(ra) <= _key(rb) else (rb, ra)


def _compare_reports(ra: dict[str, Any], rb: dict[str, Any]) -> dict[str, Any]:
    """Deterministic metric + configuration deltas between two same-type reports."""
    ca, cb = _report_ctx(ra) or {}, _report_ctx(rb) or {}
    mode = _report_mode(rb, cb)
    eco_a, basis_a = _report_economics(ca, mode)
    eco_b, basis_b = _report_economics(cb, mode)
    basis = "window" if basis_a == basis_b == "window" else "all_time"

    metrics = [
        _metric_row(k, label, eco_a.get(k), eco_b.get(k), higher)
        for k, label, higher in _ECONOMICS_SPECS
        if k in eco_a or k in eco_b
    ]
    metrics.append(
        _metric_row(
            "signals_count", "Signals", ca.get("signals_count"), cb.get("signals_count"), None
        )
    )
    blocked_a, blocked_b = ca.get("blocked_events") or {}, cb.get("blocked_events") or {}
    for k in sorted(set(blocked_a) | set(blocked_b)):
        label = k.replace("_", " ").capitalize()
        metrics.append(
            _metric_row(f"blocked.{k}", label, blocked_a.get(k), blocked_b.get(k), False)
        )

    tuning_a, tuning_b = ca.get("tuning"), cb.get("tuning")
    config_available = isinstance(tuning_a, dict) and isinstance(tuning_b, dict)
    config: list[dict[str, Any]] = []
    if config_available:
        for k in sorted(set(tuning_a) | set(tuning_b)):
            va, vb = tuning_a.get(k), tuning_b.get(k)
            if va != vb:
                config.append({"key": k, "a": va, "b": vb})

    return {
        "type": rb.get("type"),
        "mode": mode,
        "a": _report_meta(ra, ca),
        "b": _report_meta(rb, cb),
        "metrics_basis": basis,
        "metrics": metrics,
        "config": config,
        "config_available": config_available,
        "buckets": {
            # Different bucket sizes can't be aligned point-for-point; None hides the overlay.
            "granularity": (
                cb.get("bucket_granularity")
                if cb.get("bucket_granularity") == ca.get("bucket_granularity")
                else None
            ),
            "a": {
                "signals": ca.get("signals_by_day") or {},
                "pnl": ca.get("frac_by_day" if mode == "frac" else "bracket_by_day") or {},
            },
            "b": {
                "signals": cb.get("signals_by_day") or {},
                "pnl": cb.get("frac_by_day" if mode == "frac" else "bracket_by_day") or {},
            },
        },
    }


def _report_comparability(ra: dict[str, Any], rb: dict[str, Any]) -> tuple[str, list[str]]:
    """Strict ``full`` / ``partial`` / ``none`` grade for comparing A (earlier) with B.

    Decided by the backend before any LLM call so the reviewer can never claim
    more than the data supports.
    """
    ca, cb = _report_ctx(ra) or {}, _report_ctx(rb) or {}
    mode = _report_mode(rb, cb)
    grade = "full"
    reasons: list[str] = []

    def _cap(level: str, reason: str) -> None:
        nonlocal grade
        reasons.append(reason)
        if _COMPARABILITY_RANK[level] < _COMPARABILITY_RANK[grade]:
            grade = level

    eco_a, basis_a = _report_economics(ca, mode)
    eco_b, basis_b = _report_economics(cb, mode)
    if "all_time" in (basis_a, basis_b):
        _cap(
            "none",
            "At least one report predates window-scoped economics — its figures are all-time "
            "totals, so the two periods cannot be compared on performance.",
        )

    wa, wb = ca.get("window") or {}, cb.get("window") or {}
    if wa.get("start") and wb.get("start"):
        a_start, a_end = date.fromisoformat(wa["start"]), date.fromisoformat(wa["end"])
        b_start, b_end = date.fromisoformat(wb["start"]), date.fromisoformat(wb["end"])
        len_a, len_b = int(wa.get("days") or 0), int(wb.get("days") or 0)
        if len_a and len_b and abs(len_a - len_b) / max(len_a, len_b) > _WINDOW_LENGTH_TOLERANCE:
            _cap("none", f"Window lengths differ materially ({len_a} vs {len_b} days).")
        # Inclusive end dates: any positive overlap means a shared, double-counted day.
        overlap = (min(a_end, b_end) - max(a_start, b_start)).days + 1
        if overlap > 0:
            unit = "day" if overlap == 1 else "days"
            _cap(
                "partial",
                f"The windows overlap by {overlap} {unit}, so activity is double-counted.",
            )
        # Consecutive means B starts the day after A ends — any missing day is a gap.
        gap = (b_start - a_end).days
        if overlap <= 0 and gap != 1:
            missing = gap - 1
            _cap(
                "partial",
                f"The periods are not consecutive ({missing} day{'s' if missing != 1 else ''} "
                "missing between them).",
            )
    else:
        _cap("partial", "Window dates are missing on at least one report.")

    closed_a = int(eco_a.get("closed_trades") or 0)
    closed_b = int(eco_b.get("closed_trades") or 0)
    if min(closed_a, closed_b) < _MIN_CLOSED_TRADES:
        _cap(
            "partial",
            f"Too few closed trades to be statistically meaningful "
            f"(A={closed_a}, B={closed_b}; need at least {_MIN_CLOSED_TRADES} each).",
        )

    if not (isinstance(ca.get("tuning"), dict) and isinstance(cb.get("tuning"), dict)):
        _cap(
            "partial",
            "No configuration snapshot on at least one report — no change can be attributed "
            "to a setting.",
        )

    sa, sb = int(ca.get("signals_count") or 0), int(cb.get("signals_count") or 0)
    if max(sa, sb) >= 10 and min(sa, sb) / max(sa, sb) < 0.5:
        _cap(
            "partial", f"Signal volume differs sharply ({sa} vs {sb}) — different opportunity sets."
        )

    if not reasons:
        reasons.append(
            "Consecutive windows of equal length with enough trades and config snapshots."
        )
    return grade, reasons


def _load_pair(a: int, b: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fetch and validate two reports; returns them earlier-first."""
    from backend.database import get_report_record

    if a == b:
        raise HTTPException(status_code=422, detail="Pick two different reports.")
    ra, rb = get_report_record(a), get_report_record(b)
    if ra is None or rb is None:
        missing = a if ra is None else b
        raise HTTPException(status_code=404, detail=f"Report {missing} not found.")
    if ra.get("type") != rb.get("type"):
        raise HTTPException(
            status_code=409,
            detail=f"Can't compare a {ra.get('type')} report with a {rb.get('type')} report — "
            "pick two reports of the same type.",
        )
    for rec in (ra, rb):
        if _report_ctx(rec) is None:
            raise HTTPException(
                status_code=422,
                detail=f"Report {rec['id']} has no structured data and can't be compared.",
            )
    return _order_pair(ra, rb)


@router.get("/reports/compare")
def compare_reports(
    a: int = Query(..., ge=1, description="First report id"),
    b: int = Query(..., ge=1, description="Second report id"),
) -> dict[str, Any]:
    """Deterministic deltas between two same-type reports (no LLM call)."""
    ra, rb = _load_pair(a, b)
    grade, reasons = _report_comparability(ra, rb)
    return {**_compare_reports(ra, rb), "comparability": grade, "comparability_reasons": reasons}


class ReportCompareRequest(BaseModel):
    a: int = Field(..., ge=1)
    b: int = Field(..., ge=1)


_ENUM_KNOBS: dict[str, set[str]] = {
    "SIGNAL_DROP_MODE": {"untradable", "strict", "never"},
    "DISCOVERY_AUTOADD_ENABLED": {"true", "false"},
}
# (min, max, integer-only) — mirrors the Settings API validators, so a suggestion
# the review shows is always one the user could actually save. None = unbounded.
_NUMERIC_KNOBS: dict[str, tuple[float | None, float | None, bool]] = {
    "RSI_OVERSOLD": (0, 100, False),
    "RSI_OVERBOUGHT": (0, 100, False),
    "VOLUME_SPIKE_MULTIPLIER": (0, None, False),
    "SIGNIFICANT_MOVE_PCT": (0, None, False),
    "CONFIDENCE_FLOOR": (0, 100, False),
    "DISCOVERY_MIN_SCORE": (0, 100, True),
    "DISCOVERY_AUTOADD_TOP_N": (1, 25, True),
    "PAPER_MAX_POSITIONS": (0, 100, True),
    "PAPER_TRADE_MIN_CONFIDENCE": (0, 100, False),
    "FRAC_MIN_CONFIDENCE": (0, 100, False),
    "FRAC_BUDGET": (0, None, False),
    "FRAC_POSITION_SIZE": (0, None, False),
    "FRAC_POLL_SECONDS": (10, None, True),
}


def _tuning_value_error(item: dict[str, Any]) -> str | None:
    """Why *item*'s proposed value can't be saved for its setting, or None if it can."""
    setting = str(item.get("setting") or "")
    raw = str(item.get("proposed_value", "")).strip()
    if setting in _ENUM_KNOBS:
        choices = _ENUM_KNOBS[setting]
        return None if raw.lower() in choices else "must be one of " + " | ".join(sorted(choices))
    if setting in _NUMERIC_KNOBS:
        lo, hi, integer = _NUMERIC_KNOBS[setting]
        try:
            value = float(raw.replace("%", "").replace("$", "").replace(",", "").strip())
        except ValueError:
            return "must be a number"
        if (lo is not None and value < lo) or (hi is not None and value > hi):
            return f"must be between {lo} and {hi if hi is not None else 'unbounded'}"
        if integer and not value.is_integer():
            return "must be a whole number"
    return None


def _scope_violations(result: dict[str, Any], allowed: set[str]) -> list[str]:
    """Out-of-flow settings and unsaveable values are schema errors.

    *allowed* is report B's tuning snapshot. With no snapshot nothing can be checked,
    so every suggestion is a violation.
    """
    errs: list[str] = []
    for item in result.get("improve") or []:
        setting = item.get("setting") if isinstance(item, dict) else None
        if not setting:
            continue
        if setting not in allowed:
            errs.append(
                f"improve[].setting '{setting}' is not allowed for this report — "
                + (
                    "use only: " + ", ".join(sorted(allowed))
                    if allowed
                    else "report B has no tuning snapshot, so `improve` must be empty"
                )
            )
        elif (problem := _tuning_value_error(item)) is not None:
            errs.append(f"improve[].proposed_value for {setting} {problem}")
    return errs


@router.post("/reports/compare/review")
async def review_report_comparison(request: ReportCompareRequest) -> dict[str, Any]:
    """Strict "trading-master" LLM review of two same-type reports.

    The model receives both full snapshots, the deterministic diff and the backend's
    comparability grade. Persisted to ``report_compares`` for AI-usage tracking.
    """
    from backend.analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from backend.config import get_settings
    from backend.database import save_report_compare

    ra, rb = _load_pair(request.a, request.b)
    grade, reasons = _report_comparability(ra, rb)
    diff = _compare_reports(ra, rb)

    def _snapshot(rec: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": rec["id"],
            "report_date": rec.get("report_date"),
            "headline": rec.get("headline"),
            **(_report_ctx(rec) or {}),
        }

    snap_a, snap_b = _snapshot(ra), _snapshot(rb)
    knobs = set(snap_a.get("tuning") or {}) | set(snap_b.get("tuning") or {})
    payload = {
        "comparability": {"grade": grade, "reasons": reasons},
        "diff": {k: v for k, v in diff.items() if k != "buckets"},
        "report_a": snap_a,
        "report_b": snap_b,
        "tuning_allowed": {k: v for k, v in _TUNING_ALLOWED.items() if k in knobs},
    }
    user_prompt = _render_prompt(
        "report_compare_user.md",
        {
            "REPORT_TYPE": str(diff["type"]),
            "COMPARISON_JSON": json.dumps(payload, default=str),
        },
    )
    system_prompt = (_PROMPTS_DIR / "report_compare_system.md").read_text(encoding="utf-8")

    provider_override, model_override = _resolve_model_override("llm_model_report_compare")
    llm = partial(
        call_llm,
        model=model_override,
        use_fallback=True,
        _primary_provider_override=provider_override,
    )
    try:
        raw, model_used, pt, ct = await asyncio.to_thread(llm, user_prompt, system_prompt)
    except LLMError as exc:
        # Provider errors can carry URLs and upstream response text — keep them server-side.
        _log.warning("report compare review: LLM unavailable: %s", _log_safe(str(exc)))
        raise HTTPException(status_code=503, detail="LLM unavailable — see server logs.") from exc

    def _parse(text: str) -> dict[str, Any] | None:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned, count=1)
            cleaned = re.sub(r"\s*```\s*$", "", cleaned).strip()
        try:
            parsed = json.loads(cleaned)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None

    allowed = set((_report_ctx(rb) or {}).get("tuning") or {})

    result = _parse(raw)
    errs = (
        ["Response is not a JSON object."]
        if result is None
        else _validate_llm_json(result, "report_compare.schema.json")
        + _scope_violations(result, allowed)
    )
    if errs:
        _log.warning("report compare review invalid: %s", _log_safe(str(errs)[:300]))
        repaired = await asyncio.to_thread(_repair_llm_json, raw, errs, llm, system_prompt)
        result = _parse(repaired)
        # The repair returns the original text when it fails, so re-check the structure;
        # anything still malformed falls back to the safe result below.
        if result is not None and _validate_llm_json(result, "report_compare.schema.json"):
            result = None

    if result is None:
        result = {
            "verdict": "inconclusive",
            "verdict_confidence": "none",
            "summary": raw.strip()[:2000],
            "good": [],
            "bad": [],
            "improve": [],
        }
    # Never show out-of-scope or unsaveable suggestions, even if the repair didn't fix them.
    result["improve"] = [
        i
        for i in (result.get("improve") or [])
        if isinstance(i, dict) and i.get("setting") in allowed and _tuning_value_error(i) is None
    ]
    if grade == "none":
        # The deterministic gate wins: discard every claim the model made, not just the verdict.
        result = {
            "verdict": "inconclusive",
            "verdict_confidence": "none",
            "summary": "These two reports cannot be compared — "
            + "; ".join(reasons or ["the comparability check failed"]),
            "comparability_note": "Comparability is none, so no performance or tuning "
            "conclusions are drawn.",
            "good": [],
            "bad": [],
            "improve": [],
        }

    result["comparability"] = grade
    result["comparability_reasons"] = reasons
    result["report_a_id"] = ra["id"]
    result["report_b_id"] = rb["id"]
    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct

    try:
        save_report_compare(
            report_a_id=ra["id"],
            report_b_id=rb["id"],
            result_json=json.dumps(result, default=str),
            llm_provider=provider_override
            or get_setting("llm_provider", "")
            or get_settings().llm.provider,
            llm_model=model_used,
            prompt_tokens=pt or 0,
            completion_tokens=ct or 0,
        )
    except Exception:  # noqa: BLE001 - history row is best-effort; the review is still returned
        _log.warning("could not persist report compare review", exc_info=True)

    return result
