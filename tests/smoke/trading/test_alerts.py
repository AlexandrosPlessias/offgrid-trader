"""Section 8 — Alerts formatting + confidence gating (no real sends)."""

from __future__ import annotations

from backend import alerts


def test_alerts(check, opps):
    # --------------------------------------------------------------------------- #
    # 8. Alerts formatting + confidence gating (no real sends)
    # --------------------------------------------------------------------------- #
    msg = alerts.format_alert(opps[0])
    check("format_alert builds subject/text", "subject" in msg and "text" in msg)

    low_conf = alerts.send_alert({"ticker": "T", "type": "long", "confidence": 10.0})
    check(
        "send_alert skips below floor",
        low_conf["skipped"] is True and low_conf["sent"] is False,
    )

    check(
        "format_alert subject uses MarketSage brand, not old token",
        "MarketSage" in msg["subject"] and "[offgrid-trader]" not in msg["subject"],
    )

    check(
        "_order_side maps long/short/sell/buy to buy/sell",
        alerts._order_side("long") == "buy"
        and alerts._order_side("short") == "sell"
        and alerts._order_side("SELL") == "sell"
        and alerts._order_side("buy") == "buy",
    )

    bracket = alerts._bracket_payload(opps[0])
    check(
        "_bracket_payload maps long to buy with non-null levels",
        bracket["side"] == "buy"
        and bracket["entry"] is not None
        and bracket["stop"] is not None
        and bracket["target"] is not None
        and bracket["ticker"] is not None,
    )

    frac = alerts._frac_payload(opps[0])
    check(
        "_frac_payload is a buy with confirm_live",
        frac["side"] == "buy" and frac["confirm_live"] is True,
    )
