"""EoD report — GET /reports/eod

Builds a high-level end-of-day digest from today's signals and paper orders,
dispatches it via all configured notification channels, and returns the
formatted text + per-channel results.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

from backend.database import get_paper_orders, get_recent_signals
from backend.notifications import dispatch

router = APIRouter(tags=["reports"])


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


def _build_eod(
    signals_today: list[dict[str, Any]],
    orders_today: list[dict[str, Any]],
    all_orders: list[dict[str, Any]],
    date_str: str,
) -> tuple[str, str]:
    """Return (subject, body) for the EoD digest."""

    subject = f"MarketSage EoD — {date_str}"
    eco = _economics(all_orders)

    lines: list[str] = [f"📊 {subject}", ""]

    # ── Economics ─────────────────────────────────────────────────────────────
    lines.append("── Economics (all-time) ──")
    if eco["closed_trades"] > 0:
        wr = f"{eco['win_rate']:.0f}%" if eco["win_rate"] is not None else "n/a"
        pnl_sign = "+" if eco["total_pnl"] >= 0 else ""
        lines.append(f"  Total P&L   : {pnl_sign}{eco['total_pnl']:.2f}")
        lines.append(f"  Wins        : {eco['wins']}  (+{eco['win_pnl']:.2f})")
        lines.append(f"  Losses      : {eco['losses']}  ({eco['loss_pnl']:.2f})")
        lines.append(f"  Win rate    : {wr}  ({eco['wins']}/{eco['closed_trades']} closed)")
    else:
        lines.append("  No closed trades yet.")
    if eco["open_positions"]:
        lines.append(
            f"  Open pos    : {eco['open_positions']}  (~${eco['notional_open']:.0f} at risk)"
        )

    lines.append("")

    # ── Signals ──────────────────────────────────────────────────────────────
    lines.append(f"── Signals today: {len(signals_today)} ──")
    if signals_today:
        for s in signals_today:
            arrow = "📈" if s.get("type") == "long" else "📉"
            conf = s.get("confidence") or 0
            lines.append(f"  {arrow} {s['ticker']:<6}  {s.get('type','?').upper():<5}  {conf:.0f}%")
    else:
        lines.append("  (none)")

    lines.append("")

    # ── Paper orders ─────────────────────────────────────────────────────────
    lines.append(f"── Orders today: {len(orders_today)} ──")
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

    eco = _economics(all_orders)
    subject, body = _build_eod(signals_today, orders_today, all_orders, today_utc)

    results = dispatch(subject, body)

    return {
        "date": today_utc,
        "signals_count": len(signals_today),
        "orders_count": len(orders_today),
        "economics": eco,
        "body": body,
        "channels": results,
    }
