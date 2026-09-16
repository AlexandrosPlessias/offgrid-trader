"""Fractional-trading smoke tests: notional orders, skill, exit poller, DB helpers."""

from __future__ import annotations

import asyncio
from unittest import mock


def _reset_frac() -> None:
    """Clear frac_positions so each test starts from a clean slate."""
    from backend.database import _connect

    with _connect() as conn:
        conn.execute("DELETE FROM frac_positions")
        conn.commit()


def _fake_alpaca():
    from backend.alpaca import AlpacaClient

    class _FakeAlpaca(AlpacaClient):
        def __init__(self, positions=None):
            super().__init__(
                key_id="k",
                secret_key="s",  # noqa: S106
                base_url="https://paper-api.alpaca.markets",
            )
            self.posted: list[dict] = []
            self._positions = positions or []

        def _post(self, path, body):
            self.posted.append(body)
            return {"id": "fake-order-id", "status": "accepted"}

        def get_positions(self):
            return self._positions

    return _FakeAlpaca


def test_frac_notional_order(check):
    print("\n[frac] place_notional_order — notional buy / qty sell / validation")
    try:
        from backend.alpaca import AlpacaError

        _Fake = _fake_alpaca()
        c = _Fake()

        c.place_notional_order(ticker="AAPL", side="buy", notional=15)
        check(
            "notional buy body uses notional not qty",
            bool(c.posted)
            and "qty" not in c.posted[-1]
            and float(c.posted[-1].get("notional")) == 15.0,
            detail=str(c.posted[-1] if c.posted else None),
        )
        check(
            "notional buy is a simple market/day order",
            c.posted[-1].get("type") == "market" and c.posted[-1].get("time_in_force") == "day",
        )

        c.place_notional_order(ticker="AAPL", side="sell", qty=0.5)
        check(
            "qty sell body uses qty not notional",
            c.posted[-1].get("qty") == "0.5" and "notional" not in c.posted[-1],
            detail=str(c.posted[-1]),
        )

        for label, kwargs in (
            ("neither notional nor qty", {}),
            ("both notional and qty", {"notional": 10, "qty": 1}),
        ):
            try:
                c.place_notional_order(ticker="AAPL", side="buy", **kwargs)
                raised = False
            except AlpacaError:
                raised = True
            check(f"place_notional_order rejects {label}", raised)

    except Exception:
        import traceback as _tb

        check("frac notional order smoke", False, _tb.format_exc()[-400:])


def test_frac_trade_skill(check):
    print("\n[frac] FracTradeSkill — long buys, short/budget/confidence skips")
    try:
        from backend.database import get_open_frac_position_by_ticker
        from backend.skills import AgentContext
        from backend.skills.frac_trade import FracTradeSkill

        _Fake = _fake_alpaca()

        def _settings(size="15", budget="100", min_conf=""):
            return lambda k, d="": {
                "frac_trading_enabled": "true",
                "frac_position_size": size,
                "frac_budget": budget,
                "frac_min_confidence": min_conf,
            }.get(k, d)

        # ── Long placed, short skipped ──────────────────────────────────────
        _reset_frac()
        ctx = AgentContext(
            ticker="AAPL",
            actionable=[
                {
                    "ticker": "AAPL",
                    "type": "long",
                    "confidence": 80,
                    "entry": 100,
                    "stop": 95,
                    "target": 110,
                },
                {
                    "ticker": "TSLA",
                    "type": "short",
                    "confidence": 80,
                    "entry": 200,
                    "stop": 210,
                    "target": 180,
                },
            ],
        )
        with mock.patch(
            "backend.skills.frac_trade.get_frac_client", return_value=_Fake()
        ), mock.patch("backend.skills.frac_trade.frac_mode", return_value="paper"), mock.patch(
            "backend.skills.frac_trade.get_setting", side_effect=_settings()
        ):
            res = FracTradeSkill().run(ctx)
        check(
            "skill places exactly 1 order (long only)",
            res.success and len(res.data.get("orders_placed", [])) == 1,
            detail=str(res.data),
        )
        check(
            "long AAPL frac position row created",
            get_open_frac_position_by_ticker("AAPL") is not None,
        )
        check(
            "short TSLA never creates a frac position",
            get_open_frac_position_by_ticker("TSLA") is None,
        )

        # ── Budget cap: size 15 > budget 10 → skip ──────────────────────────
        _reset_frac()
        ctx = AgentContext(
            ticker="NVDA",
            actionable=[
                {
                    "ticker": "NVDA",
                    "type": "long",
                    "confidence": 80,
                    "entry": 100,
                    "stop": 95,
                    "target": 110,
                },
            ],
        )
        with mock.patch(
            "backend.skills.frac_trade.get_frac_client", return_value=_Fake()
        ), mock.patch("backend.skills.frac_trade.frac_mode", return_value="paper"), mock.patch(
            "backend.skills.frac_trade.get_setting", side_effect=_settings(budget="10")
        ):
            res = FracTradeSkill().run(ctx)
        check(
            "budget cap blocks the order", res.data.get("orders_placed") == [], detail=str(res.data)
        )

        # ── Confidence floor: 50 < 70 → skip ────────────────────────────────
        _reset_frac()
        ctx = AgentContext(
            ticker="AMD",
            actionable=[
                {
                    "ticker": "AMD",
                    "type": "long",
                    "confidence": 50,
                    "entry": 100,
                    "stop": 95,
                    "target": 110,
                },
            ],
        )
        with mock.patch(
            "backend.skills.frac_trade.get_frac_client", return_value=_Fake()
        ), mock.patch("backend.skills.frac_trade.frac_mode", return_value="paper"), mock.patch(
            "backend.skills.frac_trade.get_setting", side_effect=_settings(min_conf="70")
        ):
            res = FracTradeSkill().run(ctx)
        check(
            "confidence floor blocks the order",
            res.data.get("orders_placed") == [],
            detail=str(res.data),
        )

    except Exception:
        import traceback as _tb

        check("frac trade skill smoke", False, _tb.format_exc()[-400:])


def test_frac_monitor_exits(check):
    print("\n[frac] monitor_frac_positions — target/stop exits + realized P&L")
    try:
        from backend.database import get_frac_positions, save_frac_position
        from backend.scheduler import monitor_frac_positions

        _Fake = _fake_alpaca()
        _sched_settings = lambda k, d="": {  # noqa: E731
            "frac_trading_enabled": "true",
            "frac_eod_close": "false",
            "frac_poll_seconds": "60",
        }.get(k, d)

        def _run(current_price):
            _reset_frac()
            pid = save_frac_position(
                {
                    "ticker": "MSFT",
                    "side": "buy",
                    "notional": 15,
                    "qty": 0.1,
                    "entry_price": 100,
                    "stop_price": 95,
                    "take_profit_price": 110,
                    "status": "open",
                    "mode": "paper",
                    "alpaca_buy_order_id": "b1",
                }
            )
            fake = _Fake(
                positions=[
                    {
                        "symbol": "MSFT",
                        "current_price": current_price,
                        "qty": "0.1",
                        "avg_entry_price": "100",
                    },
                ]
            )
            with mock.patch("backend.alpaca.get_frac_client", return_value=fake), mock.patch(
                "backend.scheduler.get_setting", side_effect=_sched_settings
            ):
                asyncio.run(monitor_frac_positions())
            row = next((r for r in get_frac_positions() if r["id"] == pid), None)
            return row, fake

        # Target hit: price 115 >= 110
        row, fake = _run(115)
        check(
            "target exit closes the position",
            row and row["status"] == "closed" and row["exit_reason"] == "target",
            detail=str(row),
        )
        check(
            "target exit realized P&L = (115-100)*0.1 = 1.5",
            row and abs((row["realized_pnl"] or 0) - 1.5) < 1e-6,
            detail=str(row and row["realized_pnl"]),
        )
        check("target exit placed a sell order", any(b.get("side") == "sell" for b in fake.posted))

        # Stop hit: price 90 <= 95
        row, _ = _run(90)
        check(
            "stop exit closes the position",
            row and row["status"] == "closed" and row["exit_reason"] == "stop",
            detail=str(row),
        )
        check(
            "stop exit realized P&L = (90-100)*0.1 = -1.0",
            row and abs((row["realized_pnl"] or 0) + 1.0) < 1e-6,
            detail=str(row and row["realized_pnl"]),
        )

        # Between stop and target: no exit
        row, fake = _run(103)
        check(
            "no exit while price is inside the bracket",
            row
            and row["status"] == "open"
            and not any(b.get("side") == "sell" for b in fake.posted),
            detail=str(row),
        )

    except Exception:
        import traceback as _tb

        check("frac monitor smoke", False, _tb.format_exc()[-400:])


def test_frac_db_helpers(check):
    print("\n[frac] DB helpers — notional sum + readiness stats")
    try:
        from backend.database import (
            get_frac_readiness_stats,
            get_open_frac_notional,
            save_frac_position,
            update_frac_position,
        )

        _reset_frac()
        save_frac_position({"ticker": "AAA", "notional": 15, "status": "open", "mode": "paper"})
        p2 = save_frac_position(
            {"ticker": "BBB", "notional": 20, "status": "open", "mode": "paper"}
        )
        check(
            "open notional sums across open rows",
            get_open_frac_notional() == 35.0,
            detail=str(get_open_frac_notional()),
        )

        # Close BBB with a win.
        update_frac_position(
            p2,
            {
                "status": "closed",
                "realized_pnl": 4.0,
                "exit_reason": "target",
                "closed_at": "2026-09-16T00:00:00Z",
            },
        )
        stats = get_frac_readiness_stats("paper")
        check("readiness counts the closed trade", stats["trades"] == 1, detail=str(stats))
        check("readiness win_rate = 1.0", stats["win_rate"] == 1.0, detail=str(stats))
        check("readiness realized_pnl = 4.0", stats["realized_pnl"] == 4.0, detail=str(stats))
        check(
            "readiness open_positions = 1 (AAA still open)",
            stats["open_positions"] == 1,
            detail=str(stats),
        )
        check(
            "open notional drops after close",
            get_open_frac_notional() == 15.0,
            detail=str(get_open_frac_notional()),
        )

        # Accumulate: repeat buys bump the same row's notional + refresh stop/target.
        from backend.database import get_open_frac_position_by_ticker

        aaa = get_open_frac_position_by_ticker("AAA")
        update_frac_position(
            aaa["id"],
            {"notional": (aaa["notional"] or 0) + 15, "stop_price": 90, "take_profit_price": 130},
        )
        aaa2 = get_open_frac_position_by_ticker("AAA")
        check(
            "accumulate bumps notional 15 -> 30",
            aaa2["notional"] == 30.0,
            detail=str(aaa2["notional"]),
        )
        check(
            "accumulate updates stop/target",
            aaa2["stop_price"] == 90 and aaa2["take_profit_price"] == 130,
            detail=str(aaa2),
        )

    except Exception:
        import traceback as _tb

        check("frac db helpers smoke", False, _tb.format_exc()[-400:])
