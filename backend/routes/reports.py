"""Reports — GET /reports/eod and GET /reports/llm-summary.

``/reports/eod`` builds a deterministic end-of-day digest from today's signals and
paper orders. ``/reports/llm-summary`` narrates a daily/weekly performance summary
via the LLM (compute-then-narrate) and falls back to the deterministic digest on any
LLM failure. Both fan out to every configured notification channel (ntfy + Telegram).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.database import get_frac_positions, get_paper_orders, get_recent_signals

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
) -> tuple[str, str]:
    """Return (subject, body) for the EoD digest."""

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
            lines.append(
                f"  Win rate    : {fwr}  ({feco['wins']}/{feco['closed_trades']} closed)"
            )
        else:
            lines.append("  No closed fractional trades yet.")
        if feco["open_positions"]:
            lines.append(
                f"  Open pos    : {feco['open_positions']}  (~${feco['notional_open']:.0f} at risk)"
            )

    lines.append("")

    # ── Signals ───────────────────────────────────────────────────────────────
    lines.append(f"── Signals today: {len(signals_today)} ──")
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
    lines.append(f"── Bracket orders today: {len(orders_today)} ──")
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
            f"── Fractional today: {len(frac_closed_today)} closed, {len(frac_open_today)} open ──"
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
        f for f in all_frac
        if (f.get("opened_at") or "").startswith(today_utc)
        or (f.get("closed_at") or "").startswith(today_utc)
    ]

    eco = _economics(all_orders)
    subject, body = _build_eod(
        signals_today, orders_today, all_orders, today_utc,
        frac_today=frac_today, all_frac=all_frac,
    )

    from backend.alerts import send_report

    # Fan out to BOTH ntfy and Telegram — the bare dispatch() was ntfy-only, so the
    # digest never reached Telegram and silently no-op'd when ntfy was unconfigured.
    results = send_report(subject, body, tags="bar_chart", priority="default")
    if not any(results.values()):
        raise HTTPException(
            status_code=502,
            detail="EoD report reached no channel — enable/configure ntfy or Telegram.",
        )

    return {
        "date": today_utc,
        "signals_count": len(signals_today),
        "bracket_orders_count": len(orders_today),
        "frac_positions_count": len(frac_today),
        "bracket_economics": eco,
        "frac_economics": _frac_economics(all_frac),
        "body": body,
        "channels": results,
    }


# --------------------------------------------------------------------------- #
# LLM-generated periodic summary (natural language) — GET /reports/llm-summary
# --------------------------------------------------------------------------- #
_REPORT_SYSTEM_PROMPT = (
    "You are the reporting voice of MarketSage, a personal trading assistant. "
    "Write a concise, factual performance summary for a non-expert. Use ONLY the "
    "numbers provided — never invent, estimate, or recompute figures. Respond as "
    'compact JSON with exactly these keys: {"headline": str, "tldr": str, '
    '"pnl_line": str, "top_movers": [str, ...], "risk_note": str}. Keep every field '
    "short — the whole thing must fit a phone notification. No markdown, no preamble."
)


def _llm_narrative(context: dict[str, Any], subject: str) -> tuple[str | None, bool]:
    """Narrate the structured *context* via the LLM.

    Returns ``(body, True)`` on success, or ``(None, False)`` on any LLM/parse
    failure so the caller can fall back to the deterministic digest.
    """
    from backend.analysis import LLMError, call_llm

    try:
        raw, _model, _pt, _ct = call_llm(
            json.dumps(context, default=str),
            system_prompt=_REPORT_SYSTEM_PROMPT,
            use_fallback=True,
        )
        data = json.loads(raw)
    except (LLMError, ValueError, TypeError) as exc:
        _log.warning("LLM report generation failed; falling back to digest: %s", exc)
        return None, False

    headline = str(data.get("headline") or subject).strip()
    tldr = str(data.get("tldr") or "").strip()
    pnl_line = str(data.get("pnl_line") or "").strip()
    movers = data.get("top_movers") or []
    risk = str(data.get("risk_note") or "").strip()
    if not tldr and not pnl_line:
        return None, False  # model returned nothing usable

    lines = [f"📊 {headline}", ""]
    if tldr:
        lines.append(tldr)
    if pnl_line:
        lines += ["", pnl_line]
    movers = [str(m).strip() for m in movers if str(m).strip()]
    if movers:
        lines += ["", "Top movers:"]
        lines += [f"  • {m}" for m in movers]
    if risk:
        lines += ["", f"⚠️ {risk}"]
    lines += ["", "Not financial advice · MarketSage (AI-generated)"]
    return "\n".join(lines), True


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
        f for f in all_frac
        if (f.get("opened_at") or "") >= since or (f.get("closed_at") or "") >= since
    ]
    eco = _economics(all_orders)
    feco = _frac_economics(all_frac)

    # Compact structured context — the model narrates these, never computes them.
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
    context = {
        "period": period,
        "date": date_str,
        "bracket_economics": eco,
        "frac_economics": feco,
        "signals_count": len(signals),
        "bracket_orders_count": len(orders),
        "frac_positions_count": len(frac_period),
        "signals": [
            {"ticker": s["ticker"], "type": s.get("type"), "confidence": s.get("confidence")}
            for s in signals[:20]
        ],
        "top_bracket_movers": [
            {"ticker": o["ticker"], "side": o.get("side"), "pnl": o.get("realized_pnl")}
            for o in top_movers
        ],
        "top_frac_movers": [
            {
                "ticker": f["ticker"],
                "pnl": f.get("realized_pnl"),
                "exit_reason": f.get("exit_reason"),
            }
            for f in top_frac_movers
        ],
    }

    subject = f"MarketSage {period.capitalize()} Summary — {date_str}"
    body, used_llm = _llm_narrative(context, subject)
    if body is None:
        signals_today = [s for s in all_signals if (s.get("created_at") or "").startswith(date_str)]
        orders_today = [o for o in all_orders if (o.get("created_at") or "").startswith(date_str)]
        frac_today = [
            f for f in all_frac
            if (f.get("opened_at") or "").startswith(date_str)
            or (f.get("closed_at") or "").startswith(date_str)
        ]
        _, body = _build_eod(
            signals_today, orders_today, all_orders, date_str,
            frac_today=frac_today, all_frac=all_frac,
        )
        used_llm = False

    from backend.alerts import send_report

    results = send_report(subject, body, tags="chart_with_upwards_trend", priority="default")
    if not any(results.values()):
        raise HTTPException(
            status_code=502,
            detail="LLM report reached no channel — enable/configure ntfy or Telegram.",
        )
    return {
        "period": period,
        "date": date_str,
        "llm": used_llm,
        "body": body,
        "channels": results,
    }
