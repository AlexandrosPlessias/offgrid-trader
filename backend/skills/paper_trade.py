"""PaperTradeSkill — place bracket orders on Alpaca paper account.

Runs after PersistSkill (which populates ctx.saved_signal_ids) and before
AlertSkill.  Non-critical: a failure here never aborts the pipeline.

Enabled only when the DB setting ``paper_trading_enabled`` is ``"true"``.
"""

from __future__ import annotations

import logging

from backend.alpaca import AlpacaError, get_client
from backend.database import (
    get_open_order_by_ticker_side,
    get_paper_order_by_signal,
    get_setting,
    save_paper_order,
)
from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class PaperTradeSkill(Skill):
    """Place Alpaca paper bracket orders for every actionable signal.

    De-duplicates by signal_id: if an order already exists in ``paper_orders``
    for a given signal, the ticker is skipped.  This prevents duplicate orders
    when the scheduler re-scans the same ticker while a signal is still fresh.
    """

    name = "paper_trade"
    critical = False  # failure never aborts the pipeline
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        if get_setting("paper_trading_enabled", "true") != "true":
            return SkillResult(success=True, data={"skipped": True})

        if not ctx.actionable:
            return SkillResult(success=True, data={"orders_placed": []})

        # Position size in dollars (configurable from Settings → Paper Trading).
        notional = float(get_setting("paper_trade_position_size", "500") or 500)

        # Optional per-trade confidence override (independent from alert floor).
        min_conf_raw = get_setting("paper_trade_min_confidence", "")
        min_conf = float(min_conf_raw) if min_conf_raw else None

        try:
            client = get_client()
        except Exception as exc:  # pragma: no cover
            _log.warning("paper_trade: could not init Alpaca client: %s", exc)
            return SkillResult(success=False, error=str(exc))

        placed: list[str] = []

        for opp in ctx.actionable:
            if min_conf is not None and (opp.get("confidence") or 0) < min_conf:
                _log.debug(
                    "paper_trade: skipping %s — confidence %.1f < min %.1f",
                    opp["ticker"],
                    opp.get("confidence", 0),
                    min_conf,
                )
                continue

            # PersistSkill stores {ticker: signal_id} in ctx.saved_signal_ids (dict).
            signal_id: int | None = ctx.saved_signal_ids.get(opp["ticker"])

            side = "buy" if opp.get("type") == "long" else "sell"

            # Dedup by signal_id (exact match) or by open ticker+side (prevents
            # duplicate positions across multiple scan runs for the same ticker).
            if signal_id and get_paper_order_by_signal(signal_id):
                _log.debug(
                    "paper_trade: order already exists for signal %d (%s)",
                    signal_id,
                    opp["ticker"],
                )
                continue
            if get_open_order_by_ticker_side(opp["ticker"], side):
                _log.debug(
                    "paper_trade: open %s %s order already exists — skipping",
                    side,
                    opp["ticker"],
                )
                continue

            stop = opp.get("stop")
            target = opp.get("target")
            if stop is None or target is None:
                _log.warning("paper_trade: skipping %s — missing stop or target", opp["ticker"])
                continue

            entry_price = float(opp.get("entry") or opp.get("price") or 1)

            # Guard: skip if the notional budget can't even buy 1 whole share.
            if entry_price > 0 and int(notional / entry_price) < 1:
                _log.warning(
                    "paper_trade: skipping %s — $%.0f notional too small for "
                    "1 share at $%.2f (need $%.2f). Increase position size in Settings.",
                    opp["ticker"],
                    notional,
                    entry_price,
                    entry_price,
                )
                continue

            try:
                result = client.place_bracket_order(
                    ticker=opp["ticker"],
                    side=side,
                    notional=notional,
                    entry_price=entry_price,
                    stop_price=stop,
                    take_profit_price=target,
                )
                alpaca_order_id = result.get("id")
                save_paper_order(
                    {
                        "signal_id": signal_id,
                        "ticker": opp["ticker"],
                        "side": side,
                        "alpaca_order_id": alpaca_order_id,
                        "status": result.get("status", "pending"),
                        "notional": notional,
                        "entry_price": opp.get("entry"),
                        "stop_price": stop,
                        "take_profit_price": target,
                        # Denormalised signal fields — stored directly so they
                        # survive even if the signal row is later deleted.
                        "signal_confidence": opp.get("confidence"),
                        "signal_source": (
                            opp.get("source") or "+".join(opp.get("sources") or []) or None
                        ),
                        "signal_timestamp": opp.get("timestamp"),
                    }
                )
                placed.append(alpaca_order_id or opp["ticker"])
                _log.info(
                    "paper_trade: placed %s %s order id=%s",
                    side,
                    opp["ticker"],
                    alpaca_order_id,
                )
            except AlpacaError as exc:
                _log.warning("paper_trade: order failed for %s: %s", opp["ticker"], exc)

        return SkillResult(success=True, data={"orders_placed": placed})
