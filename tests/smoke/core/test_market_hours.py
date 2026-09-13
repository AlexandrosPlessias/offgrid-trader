"""Section 9 — Market-hours logic."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from backend import scheduler


def test_market_hours(check):
    # --------------------------------------------------------------------------- #
    # 9. Market-hours logic
    # --------------------------------------------------------------------------- #
    et = ZoneInfo("America/New_York")
    # A Wednesday at 11:00 ET should be open; Saturday should be closed.
    open_dt = datetime(2024, 1, 3, 11, 0, tzinfo=et)
    closed_dt = datetime(2024, 1, 6, 11, 0, tzinfo=et)
    check("market open on weekday midday", scheduler.is_market_open(open_dt) is True)
    check("market closed on weekend", scheduler.is_market_open(closed_dt) is False)
