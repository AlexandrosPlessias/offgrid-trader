"""Section 15 — Alpaca bracket order: qty calculation + price rounding."""

from __future__ import annotations

from unittest import mock


def test_alpaca_bracket_order(check):
    # --------------------------------------------------------------------------- #
    # 15. Alpaca bracket order — qty calculation + price rounding
    # --------------------------------------------------------------------------- #
    print("\n[15] Alpaca bracket order — qty / price rounding")

    try:
        from backend.alpaca import AlpacaClient as _AlpacaClient
        from backend.database import save_signal as _save_signal
        from backend.skills import AgentContext as _AC15
        from backend.skills.paper_trade import PaperTradeSkill as _PTS

        # ── 15a. place_bracket_order builds qty body, rounds prices to 2dp ──────
        _posted: list[dict] = []

        class _FakeAlpaca(_AlpacaClient):
            def __init__(self):
                # Call superclass __init__ with a valid Alpaca hostname so
                # _validate_url passes; _post is overridden so no network call is made.
                super().__init__(
                    key_id="test-key",
                    secret_key="test-secret",  # noqa: S106
                    base_url="https://paper-api.alpaca.markets",
                )

            def _post(self, path, body):
                _posted.append(body)
                return {"id": "fake-order-id", "status": "accepted"}

        _client = _FakeAlpaca()
        _client.place_bracket_order(
            ticker="NVDA",
            side="buy",
            notional=500,
            entry_price=228.0,
            stop_price=219.2636,  # sub-penny — must be rounded
            take_profit_price=239.6077,  # sub-penny — must be rounded
        )

        check(
            "place_bracket_order uses qty not notional",
            _posted and "qty" in _posted[-1] and "notional" not in _posted[-1],
        )
        check(
            "place_bracket_order qty = floor(500/228) = 2",
            _posted[-1].get("qty") == "2",
            detail=str(_posted[-1].get("qty")),
        )
        check(
            "place_bracket_order stop rounded to 2dp",
            _posted[-1]["stop_loss"]["stop_price"] == "219.26",
            detail=str(_posted[-1]["stop_loss"]),
        )
        check(
            "place_bracket_order take_profit rounded to 2dp",
            _posted[-1]["take_profit"]["limit_price"] == "239.61",
            detail=str(_posted[-1]["take_profit"]),
        )

        # ── 15b. PaperTradeSkill places order for actionable signal ─────────────
        _sig_id = _save_signal(
            {
                "ticker": "NVDA",
                "type": "long",
                "confidence": 80.0,
                "source": "ai",
                "entry": 228.0,
                "stop": 219.2636,
                "target": 239.6077,
                "price": 228.0,
                "reasons": ["smoke"],
            }
        )

        _ctx15 = _AC15(
            ticker="NVDA",
            actionable=[
                {
                    "ticker": "NVDA",
                    "type": "long",
                    "confidence": 80.0,
                    "entry": 228.0,
                    "stop": 219.2636,
                    "target": 239.6077,
                    "price": 228.0,
                }
            ],
        )
        _ctx15.saved_signal_ids = {"NVDA": _sig_id}

        with mock.patch(
            "backend.skills.paper_trade.get_client", return_value=_FakeAlpaca()
        ), mock.patch(
            "backend.skills.paper_trade.get_setting",
            side_effect=lambda k, d="": {
                "paper_trading_enabled": "true",
                "paper_trade_position_size": "500",
                "paper_trade_min_confidence": "",
            }.get(k, d),
        ):
            _result15 = _PTS().run(_ctx15)

        check(
            "PaperTradeSkill places order for actionable signal",
            _result15.success and len(_result15.data.get("orders_placed", [])) == 1,
            detail=str(_result15),
        )

        check("Alpaca bracket order smoke complete", True)

    except Exception:
        import traceback as _tb15

        check("Alpaca bracket order smoke", False, _tb15.format_exc()[-400:])
