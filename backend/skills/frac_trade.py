"""FracTradeSkill — place fractional notional buys on the frac Alpaca profile.

Runs after PaperTradeSkill and before AlertSkill.  Non-critical: a failure
here never aborts the pipeline.

Unlike ``PaperTradeSkill`` (whole-share bracket orders on the primary paper
account), this skill places *fractional* notional market buys on a **second**
Alpaca profile (``get_frac_client``) — paper during the monitoring period,
live once the user swaps that profile's host.  Fractional orders carry no
broker-side stop/target, so exits are handled by the scheduler's
``monitor_frac_positions`` poller which reads the stop/target stored here.

Long-only: Alpaca cannot short fractional shares, so short signals are skipped.
Enabled only when the DB setting ``frac_trading_enabled`` is ``"true"``.
"""

from __future__ import annotations

import logging

from backend.alpaca import AlpacaError, frac_mode, get_frac_client
from backend.config import get_settings as _cfg
from backend.database import (
    get_open_frac_notional,
    get_open_frac_position_by_ticker,
    get_setting,
    save_frac_position,
)
from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class FracTradeSkill(Skill):
    """Place a fractional notional buy for every actionable *long* signal.

    De-duplicates by open position: if an open ``frac_positions`` row already
    exists for the ticker, it is skipped.  A budget cap keeps total deployed
    notional at or below ``frac_budget``.
    """

    name = "frac_trade"
    critical = False  # failure never aborts the pipeline
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        if get_setting("frac_trading_enabled", "false") != "true":
            return SkillResult(success=True, data={"skipped": True})

        if not ctx.actionable:
            return SkillResult(success=True, data={"orders_placed": []})

        mode = frac_mode()

        # Safety rail: autonomous frac buys are paper-only unless explicitly allowed.
        allow_live = (
            get_setting("frac_autotrade_allow_live", "")
            or ("true" if _cfg().autotrade.frac_autotrade_allow_live else "false")
        ) == "true"
        if mode == "live" and not allow_live:
            _log.info("frac_trade: live mode + auto-live disabled — skipping autonomous buys")
            return SkillResult(success=True, data={"skipped": "live-mode-blocked"})

        size = float(get_setting("frac_position_size", "15") or 15)
        budget = float(get_setting("frac_budget", "100") or 100)

        # env default lives in AutoTradeConfig (85); setting overrides at call time.
        min_conf_raw = get_setting("frac_min_confidence", "")
        min_conf = (
            float(min_conf_raw) if min_conf_raw else (_cfg().autotrade.frac_min_confidence or None)
        )

        try:
            client = get_frac_client()
        except Exception as exc:  # pragma: no cover
            _log.warning("frac_trade: could not init frac Alpaca client: %s", exc)
            return SkillResult(success=False, error=str(exc))

        deployed = get_open_frac_notional()
        placed: list[str] = []
        budget_notified = False

        for opp in ctx.actionable:
            # Long-only — Alpaca cannot short fractional shares.
            if opp.get("type") != "long":
                continue

            # Tradability gate annotated this — skip if a frac buy can't be placed.
            if opp.get("can_frac") is False:
                continue

            if min_conf is not None and (opp.get("confidence") or 0) < min_conf:
                continue

            ticker = opp["ticker"]
            if get_open_frac_position_by_ticker(ticker):
                _log.debug("frac_trade: open position already exists for %s — skipping", ticker)
                continue

            # Budget cap — never deploy more than frac_budget in total.
            if deployed + size > budget:
                _log.info(
                    "frac_trade: budget cap reached (deployed $%.2f + $%.2f > $%.2f) — skipping %s",
                    deployed,
                    size,
                    budget,
                    ticker,
                )
                if not budget_notified:
                    from backend.alerts import send_order_blocked_notification

                    send_order_blocked_notification(
                        kind="fractional",
                        ticker=ticker,
                        amount=size,
                        reason="budget_cap",
                        mode=mode,
                        detail=f"${deployed:.2f}/${budget:.2f} deployed",
                    )
                    budget_notified = True
                continue

            stop = opp.get("stop")
            target = opp.get("target")
            if stop is None or target is None:
                _log.warning("frac_trade: skipping %s — missing stop or target", ticker)
                continue

            entry_price = opp.get("entry") or opp.get("price")
            signal_id = ctx.saved_signal_ids.get(ticker)

            try:
                result = client.place_notional_order(ticker=ticker, side="buy", notional=size)
                buy_order_id = result.get("id")
                save_frac_position(
                    {
                        "signal_id": signal_id,
                        "ticker": ticker,
                        "side": "buy",
                        "notional": size,
                        "entry_price": entry_price,
                        "stop_price": stop,
                        "take_profit_price": target,
                        "status": "open",  # our lifecycle status, not the Alpaca order ack
                        "alpaca_buy_order_id": buy_order_id,
                        "mode": mode,
                        "signal_confidence": opp.get("confidence"),
                        "signal_source": (
                            opp.get("source") or "+".join(opp.get("sources") or []) or None
                        ),
                        "signal_timestamp": opp.get("timestamp"),
                    }
                )
                deployed += size
                placed.append(buy_order_id or ticker)
                _log.info(
                    "frac_trade: placed %s buy $%.2f (%s) id=%s", ticker, size, mode, buy_order_id
                )
                from backend.alerts import send_order_notification

                send_order_notification(
                    kind="fractional",
                    ticker=ticker,
                    side="buy",
                    amount=size,
                    mode=mode,
                    detail=f"stop {stop} / target {target}",
                )
            except AlpacaError as exc:
                _log.warning("frac_trade: order failed for %s: %s", ticker, exc)
                from backend.alerts import send_order_blocked_notification

                msg = str(exc).lower()
                is_funds = "insufficient" in msg or "buying power" in msg
                send_order_blocked_notification(
                    kind="fractional",
                    ticker=ticker,
                    amount=size,
                    reason="insufficient_funds" if is_funds else "failed",
                    mode=mode,
                )

        return SkillResult(success=True, data={"orders_placed": placed})
