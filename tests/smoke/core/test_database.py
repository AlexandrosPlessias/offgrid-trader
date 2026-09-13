"""Section 4 — Database schema + round-trip."""

from __future__ import annotations

import os

from backend import database

_TMP_DB = os.environ.get("DATABASE_PATH", "")


def test_database_roundtrip(check):
    # --------------------------------------------------------------------------- #
    # 4. Database schema + round-trip
    # --------------------------------------------------------------------------- #
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)
    database.init_db()
    sig_id = database.save_signal(
        {
            "ticker": "TEST",
            "type": "long",
            "confidence": 80.0,
            "source": "ai+rsi_extreme",
            "entry": 100.0,
            "stop": 95.0,
            "target": 110.0,
            "price": 100.0,
            "reasons": ["synthetic"],
        }
    )
    check("save_signal returns id", isinstance(sig_id, int) and sig_id > 0)
    recent = database.get_recent_signals(limit=5, ticker="TEST")
    check("get_recent_signals round-trip", len(recent) == 1 and recent[0]["ticker"] == "TEST")

    database.save_analysis("TEST", {"trend": "bullish"}, {"ticker": "TEST"})
    hist = database.get_analysis_history("TEST")
    check(
        "analysis_log round-trip",
        len(hist) == 1 and hist[0]["analysis_json"]["trend"] == "bullish",
    )

    recent_all = database.get_recent_analyses(limit=10)
    check(
        "get_recent_analyses returns saved entry",
        len(recent_all) >= 1 and any(r["ticker"] == "TEST" for r in recent_all),
    )

    deleted_sig = database.delete_signal(sig_id)
    check("delete_signal returns True", deleted_sig is True)
    after_del = database.get_recent_signals(limit=5, ticker="TEST")
    check("signal gone after delete", len(after_del) == 0)

    analysis_id = hist[0]["id"]
    deleted_an = database.delete_analysis(analysis_id)
    check("delete_analysis returns True", deleted_an is True)
    after_del_an = database.get_analysis_history("TEST")
    check("analysis gone after delete", len(after_del_an) == 0)
