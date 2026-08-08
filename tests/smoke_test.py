"""Offline smoke test for the offgrid-trader backend.

Verifies that:
* every backend module imports,
* ``backend.main:app`` builds and exposes the expected routes,
* the DB schema initialises and round-trips a signal,
* opportunity detection works on a synthetic market-data dict,
* AI / market-data / alert code paths behave when their network deps are
  mocked out (no live yfinance, tradingview-ta, Ollama or SMTP calls).

HOW TO RUN
----------
Install dev dependencies (one-time):
    pip install -r requirements/dev.txt

Run from the repo root:
    python tests/smoke_test.py

Or via pytest:
    pytest tests/smoke_test.py -v

Inside the running backend container:
    docker compose exec backend python tests/smoke_test.py

Exits non-zero on failure; all checks print PASS / FAIL inline.
"""

from __future__ import annotations

import os
import sys
import tempfile
from unittest import mock

# Use an isolated temp DB so we never touch a real one.
_TMP_DB = os.path.join(tempfile.gettempdir(), "offgrid_smoke.db")
os.environ["DATABASE_PATH"] = _TMP_DB
os.environ["EMAIL_ENABLED"] = "false"
os.environ["SLACK_ENABLED"] = "false"

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# --------------------------------------------------------------------------- #
# 1. Imports
# --------------------------------------------------------------------------- #
try:
    from backend import (  # noqa: F401
        alerts,
        analysis,
        config,
        data,
        database,
        opportunities,
        scheduler,
    )
    from backend.main import app

    check("import all backend modules + FastAPI app", True)
except Exception as exc:  # pragma: no cover
    check("import all backend modules + FastAPI app", False, repr(exc))
    print("Fatal import error; aborting.")
    sys.exit(1)


# --------------------------------------------------------------------------- #
# 2. Routes are registered
# --------------------------------------------------------------------------- #
paths = {getattr(r, "path", None) for r in app.routes}
expected = {
    "/analyze",
    "/analyze/stream",
    "/webhook/tradingview",
    "/signals",
    "/analysis",
    "/analysis/{ticker}",
    "/market-data/{ticker}",
    "/market-data/{ticker}/history",
    "/watchlist",
    "/health",
}
check("all expected routes present", expected.issubset(paths), f"missing={expected - paths}")


# --------------------------------------------------------------------------- #
# 3. Config loads and masks secrets
# --------------------------------------------------------------------------- #
settings = config.get_settings()
check("config watchlist non-empty", len(settings.watchlist) > 0)
check("ollama chat url built", settings.ollama.chat_url.endswith("/api/chat"))


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
check("analysis_log round-trip", len(hist) == 1 and hist[0]["analysis_json"]["trend"] == "bullish")

recent_all = database.get_recent_analyses(limit=10)
check("get_recent_analyses returns saved entry",
      len(recent_all) >= 1 and any(r["ticker"] == "TEST" for r in recent_all))


# --------------------------------------------------------------------------- #
# 5. Opportunity detection on synthetic data (no network)
# --------------------------------------------------------------------------- #
synthetic = {
    "ticker": "TEST",
    "price": {"current": 100.0, "change_pct": 3.5, "volume_ratio": 3.0},
    "technicals": {
        "1H": {"RSI": 25.0, "MACD": {"histogram": 0.5}},
        "4H": {"RSI": 28.0, "MACD": {"histogram": 0.4}},
        "1D": {"RSI": 45.0, "MACD": {"histogram": 0.3}},
    },
    "errors": [],
}
ai_result = {
    "opportunity": {"type": "long", "confidence": 82.0, "entry": 100.0, "stop": 95.0, "target": 110.0},
    "signals": ["bullish structure"],
    "error": None,
}
opps = opportunities.detect_opportunities(synthetic, ai_result)
check("detect_opportunities returns results", len(opps) > 0)
check("top opportunity is long", bool(opps) and opps[0]["type"] == "long")
check(
    "multiple sources merged",
    bool(opps) and len(opps[0]["sources"]) >= 2,
    detail=str(opps[0]["sources"]) if opps else "",
)


# --------------------------------------------------------------------------- #
# 6. AI analysis with mocked Ollama
# --------------------------------------------------------------------------- #
fake_response = mock.Mock()
fake_response.status_code = 200
fake_response.json.return_value = {
    "message": {
        "content": (
            '{"trend":"bullish","momentum":"strong","key_levels":{"support":[95],'
            '"resistance":[110]},"signals":["x"],"opportunity":{"type":"long",'
            '"confidence":75,"entry":100,"stop":95,"target":110},"risk_factors":["y"]}'
        )
    }
}
with mock.patch("backend.analysis.requests.post", return_value=fake_response):
    parsed = analysis.analyze(synthetic)
check("analyze() parses mocked Ollama JSON", parsed.get("trend") == "bullish", repr(parsed))
check("analyze() opportunity normalised", parsed["opportunity"]["type"] == "long")

# Ollama-not-running path.
import requests as _requests  # noqa: E402

with mock.patch(
    "backend.analysis.requests.post",
    side_effect=_requests.exceptions.ConnectionError(),
):
    err = analysis.analyze(synthetic)
check("analyze() handles Ollama offline", "error" in err and err["opportunity"] is None)


# --------------------------------------------------------------------------- #
# 7. Alerts formatting + confidence gating (no real sends)
# --------------------------------------------------------------------------- #
msg = alerts.format_alert(opps[0])
check("format_alert builds subject/text", "subject" in msg and "text" in msg)

low_conf = alerts.send_alert({"ticker": "T", "type": "long", "confidence": 10.0})
check("send_alert skips below floor", low_conf["skipped"] is True and low_conf["sent"] is False)


# --------------------------------------------------------------------------- #
# 8. Market-hours logic
# --------------------------------------------------------------------------- #
from datetime import datetime  # noqa: E402
from zoneinfo import ZoneInfo  # noqa: E402

et = ZoneInfo("America/New_York")
# A Wednesday at 11:00 ET should be open; Saturday should be closed.
open_dt = datetime(2024, 1, 3, 11, 0, tzinfo=et)
closed_dt = datetime(2024, 1, 6, 11, 0, tzinfo=et)
check("market open on weekday midday", scheduler.is_market_open(open_dt) is True)
check("market closed on weekend", scheduler.is_market_open(closed_dt) is False)


# --------------------------------------------------------------------------- #
# 9. TestClient hits /health without touching the network
# --------------------------------------------------------------------------- #
try:
    from fastapi.testclient import TestClient

    # Prevent the lifespan scheduler loop from doing real scans during the test.
    with mock.patch.object(scheduler.scheduler, "start", lambda: None), mock.patch.object(
        scheduler.scheduler, "stop", mock.AsyncMock()
    ):
        with TestClient(app) as client:
            resp = client.get("/health")
            check("/health returns 200", resp.status_code == 200)
            check("/health payload ok", resp.json().get("status") == "ok")
            wl = client.get("/watchlist")
            check("/watchlist returns 200", wl.status_code == 200)
except Exception as exc:  # pragma: no cover
    check("TestClient /health", False, repr(exc))


# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #
if os.path.exists(_TMP_DB):
    try:
        os.remove(_TMP_DB)
    except OSError:
        pass

print("\n" + ("=" * 50))
if failures:
    print(f"SMOKE TEST FAILED — {len(failures)} check(s): {failures}")
    sys.exit(1)
print("SMOKE TEST PASSED — all checks green")
