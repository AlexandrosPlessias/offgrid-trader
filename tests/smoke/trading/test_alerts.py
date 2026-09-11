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
