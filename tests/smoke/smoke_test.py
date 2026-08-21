"""Offline smoke test for the offgrid-trader backend.

Verifies that:
* every backend module imports,
* ``backend.main:app`` builds and exposes the expected routes,
* the DB schema initialises and round-trips a signal,
* opportunity detection works on a synthetic market-data dict,
* AI / market-data / alert code paths behave when their network deps are
  mocked out (no live yfinance, ta, Ollama or SMTP calls).

HOW TO RUN
----------
Install dev dependencies (one-time):
    pip install -r tests/lint/requirements.dev.txt

Run from the repo root:
    python tests/smoke/smoke_test.py

Or via pytest:
    pytest tests/smoke/smoke_test.py -v

Or via make (runs all lint tools + this test):
    make lint

Inside the running backend container:
    docker compose exec backend python tests/smoke/smoke_test.py

Exits non-zero on failure; all checks print PASS / FAIL inline.
"""

from __future__ import annotations

import os
import sys
import tempfile
import urllib.parse
from unittest import mock

# Ensure the repo root is on sys.path so ``from backend import …`` works
# whether the script is run from the repo root, from tests/smoke/, or from
# inside the Docker container (where WORKDIR=/app).
# __file__ = tests/smoke/smoke_test.py → three dirname() calls reach the root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

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
    from backend import (
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
    "/signals/{signal_id}",
    "/analysis",
    "/analysis/{entry_id}",
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
    "opportunity": {
        "type": "long",
        "confidence": 82.0,
        "entry": 100.0,
        "stop": 95.0,
        "target": 110.0,
    },
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
# 6. compute_indicators with mocked yfinance (no network)
# --------------------------------------------------------------------------- #
_n = 300  # enough bars for EMA200
_idx = list(range(_n))
_price = [100.0 + i * 0.01 for i in _idx]
_fake_ohlcv = {
    "Open": _price,
    "High": [p + 0.5 for p in _price],
    "Low": [p - 0.5 for p in _price],
    "Close": _price,
    "Volume": [1_000_000] * _n,
}

try:
    import pandas as pd

    _fake_df = pd.DataFrame(_fake_ohlcv)
    _fake_df.index = pd.date_range("2024-01-01", periods=_n, freq="1h")

    with mock.patch("yfinance.download", return_value=_fake_df):
        from backend.data import compute_indicators, fetch_finnhub_news

        ind = compute_indicators("TEST")

    check(
        "compute_indicators returns all three timeframes",
        set(ind.get("technicals", {}).keys()) >= {"1H", "4H", "1D"},
        detail=str(list(ind.get("technicals", {}).keys())),
    )
    tf_1h = (ind.get("technicals") or {}).get("1H") or {}
    check(
        "compute_indicators 1H has RSI and recommendation",
        tf_1h.get("RSI") is not None and tf_1h.get("recommendation") is not None,
        detail=str(tf_1h),
    )
    check(
        "fetch_finnhub_news returns [] when no key set",
        fetch_finnhub_news("TEST", "") == [],
    )
    # New: news returns List[Dict] when key is set
    fake_article = {
        "headline": "Test Co beats estimates",
        "source": "Reuters",
        "url": "https://example.com/1",
        "datetime": 1700000000,
        "summary": "extra field — should be ignored",
    }
    fake_client = mock.MagicMock()
    fake_client.company_news.return_value = [fake_article]
    with mock.patch("finnhub.Client", return_value=fake_client):
        news_result = fetch_finnhub_news("TEST", "fake_key_123")
    check(
        "fetch_finnhub_news returns List[Dict] with key set",
        isinstance(news_result, list)
        and len(news_result) == 1
        and isinstance(news_result[0], dict)
        and news_result[0].get("headline") == "Test Co beats estimates"
        and news_result[0].get("source") == "Reuters"
        and news_result[0].get("datetime") == 1700000000,
        detail=str(news_result),
    )
except Exception as exc:  # pragma: no cover
    check("compute_indicators smoke", False, repr(exc))
    check("compute_indicators 1H has RSI and recommendation", False)
    check("fetch_finnhub_news returns [] when no key set", False)
    check("fetch_finnhub_news returns List[Dict] with key set", False)


# --------------------------------------------------------------------------- #
# 7. AI analysis with mocked Ollama
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
# 8. Alerts formatting + confidence gating (no real sends)
# --------------------------------------------------------------------------- #
msg = alerts.format_alert(opps[0])
check("format_alert builds subject/text", "subject" in msg and "text" in msg)

low_conf = alerts.send_alert({"ticker": "T", "type": "long", "confidence": 10.0})
check("send_alert skips below floor", low_conf["skipped"] is True and low_conf["sent"] is False)


# --------------------------------------------------------------------------- #
# 9. Market-hours logic
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
# 10. TestClient hits /health without touching the network
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
# 11. Backlog item 2 — balance sheet, FRED macro, prompt blocks, cache
# --------------------------------------------------------------------------- #
try:
    import pandas as pd

    from backend.analysis import build_prompt
    from backend.data import (
        _cached_json,
        _store_json,
        fetch_balance_sheet,
        fetch_fred_macro,
    )

    # 11a. Balance sheet: mocked yfinance DataFrame
    _bs_period = pd.Timestamp("2026-03-31")
    _bs_df = pd.DataFrame(
        {
            _bs_period: {
                "Total Assets": 300e9,
                "Total Liabilities Net Minority Interest": 200e9,
                "Stockholders Equity": 100e9,
                "Total Debt": 50e9,
                "Cash And Cash Equivalents": 30e9,
            }
        }
    )

    class _FakeTicker:
        balance_sheet = _bs_df

    with mock.patch("yfinance.Ticker", return_value=_FakeTicker()):
        bs = fetch_balance_sheet("TEST_BS")

    check(
        "fetch_balance_sheet returns expected keys",
        all(
            k in bs
            for k in (
                "period",
                "total_assets",
                "total_liabilities",
                "stockholders_equity",
                "total_debt",
                "cash",
                "debt_to_equity",
            )
        ),
        detail=str(list(bs.keys())),
    )
    check(
        "fetch_balance_sheet computes debt_to_equity",
        bs.get("debt_to_equity") == round(50e9 / 100e9, 3),
        detail=str(bs.get("debt_to_equity")),
    )
    check(
        "fetch_balance_sheet period is ISO string",
        isinstance(bs.get("period"), str) and "-" in (bs.get("period") or ""),
        detail=str(bs.get("period")),
    )

    # Balance sheet: empty DataFrame → all-None, no raise
    class _EmptyTicker:
        balance_sheet = pd.DataFrame()

    with mock.patch("yfinance.Ticker", return_value=_EmptyTicker()):
        bs_empty = fetch_balance_sheet("TEST_EMPTY_BS")

    check(
        "fetch_balance_sheet empty DataFrame → all None, no raise",
        bs_empty.get("total_assets") is None,
    )

    # 11b. FRED macro: mocked requests.get
    _FEDFUNDS_CSV = "DATE,VALUE\n2026-06-01,5.25\n2026-07-01,5.00\n"
    _CPIAUCSL_ROWS = "\n".join(
        ["DATE,VALUE"]
        + [f"202{i:d}-0{(j % 12) + 1:d}-01,310.{j:02d}" for i, j in enumerate(range(14))]
    )
    _UNRATE_CSV = "DATE,VALUE\n2026-07-01,3.9\n"
    _T10Y2Y_CSV = "DATE,VALUE\n2026-07-01,-0.42\n"

    def _fake_fred_get(url, *args, **kwargs):
        # Build a response object that works for both the CSV endpoint and the
        # FRED REST API (used when FRED_API_KEY is set in the environment).
        # The REST API path calls r.json(); the CSV path reads r.text.
        if "FEDFUNDS" in url:
            _text = _FEDFUNDS_CSV
            _json = {
                "observations": [
                    {"date": "2026-07-01", "value": "5.0"},  # newest first (API sort)
                    {"date": "2026-06-01", "value": "5.25"},
                ]
            }
        elif "CPIAUCSL" in url:
            _text = _CPIAUCSL_ROWS
            _json = {
                "observations": [
                    {"date": f"202{i}-{(j % 12) + 1:02d}-01", "value": f"310.{j:02d}"}
                    for i, j in enumerate(range(14))
                ]
            }
        elif "UNRATE" in url:
            _text = _UNRATE_CSV
            _json = {"observations": [{"date": "2026-07-01", "value": "3.9"}]}
        elif "T10Y2Y" in url:
            _text = _T10Y2Y_CSV
            _json = {"observations": [{"date": "2026-07-01", "value": "-0.42"}]}
        elif urllib.parse.urlparse(url).netloc in (
            "multpl.com",
            "www.multpl.com",
        ) or urllib.parse.urlparse(url).netloc.endswith(".multpl.com"):
            _text = "<table><tr><td>Jul 2026</td><td>34.21</td></tr></table>"
            _json = {}
        else:
            _text = ""
            _json = {}

        class _R:
            text = _text
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return _json

        return _R()

    # Clear any macro cache from earlier balance-sheet test runs
    from backend.database import set_setting as _ss

    _ss("macro_cache", "")

    with mock.patch.object(data, "requests") as _mock_req:
        _mock_req.get.side_effect = _fake_fred_get
        macro = fetch_fred_macro()

    # Use `or {}` not the default arg — dict.get(key, default) returns default
    # only when the key is absent, but returns None when the key is present
    # with a None value (which happens if a FRED series fails to fetch).
    check(
        "fetch_fred_macro returns fed_funds_rate",
        (macro.get("fed_funds_rate") or {}).get("value") == 5.0,
        detail=str(macro.get("fed_funds_rate")),
    )
    check(
        "fetch_fred_macro returns unemployment",
        (macro.get("unemployment") or {}).get("value") == 3.9,
        detail=str(macro.get("unemployment")),
    )
    check(
        "fetch_fred_macro yield_spread inverted flag",
        (macro.get("yield_spread") or {}).get("inverted") is True,
        detail=str(macro.get("yield_spread")),
    )
    check(
        "fetch_fred_macro returns shiller_cape",
        (macro.get("shiller_cape") or {}).get("value") == 34.21,
        detail=str(macro.get("shiller_cape")),
    )

    # 11c. build_prompt with all new fields
    _synthetic_news = [
        {
            "headline": "AAPL beats estimates",
            "source": "Reuters",
            "url": "https://example.com",
            "datetime": 1700000000,
        },
    ]
    _synthetic_bs = {
        "period": "2026-03-31",
        "total_assets": 300e9,
        "total_liabilities": 200e9,
        "stockholders_equity": 100e9,
        "total_debt": 50e9,
        "cash": 30e9,
        "debt_to_equity": 0.5,
    }
    _synthetic_macro = {
        "fed_funds_rate": {"value": 5.0, "date": "2026-07-01"},
        "cpi_yoy": {"value": 3.1, "date": "2026-07-01"},
        "unemployment": {"value": 3.9, "date": "2026-07-01"},
        "yield_spread": {"value": -0.42, "date": "2026-07-01", "inverted": True},
        "shiller_cape": {"value": 34.21, "date": "2026-07-01"},
    }
    _prompt_data = {
        **synthetic,
        "fundamentals": {
            "name": "Apple Inc.",
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "market_cap": 3e12,
            "trailing_pe": 28.5,
            "pe_ratio": 28.5,
            "forward_pe": 25.0,
        },
        "news": _synthetic_news,
        "balance_sheet": _synthetic_bs,
        "macro": _synthetic_macro,
    }
    prompt_text = build_prompt(_prompt_data)
    check(
        "build_prompt contains BALANCE SHEET block",
        "BALANCE SHEET" in prompt_text,
        detail=prompt_text[:200],
    )
    check(
        "build_prompt contains MACRO CONTEXT block",
        "MACRO CONTEXT" in prompt_text,
        detail=prompt_text[:200],
    )
    check(
        "build_prompt contains RECENT NEWS HEADLINES block", "RECENT NEWS HEADLINES" in prompt_text
    )
    check("build_prompt news shows source", "(Reuters)" in prompt_text)
    check(
        "build_prompt contains VALUATION block with P/E",
        "VALUATION" in prompt_text and "28.5" in prompt_text,
    )
    check("build_prompt macro shows inverted warning", "INVERTED" in prompt_text)

    # 11d. Cache round-trip via _cached_json / _store_json
    _store_json("smoke_test_cache_key", {"hello": "world", "n": 42})
    _got = _cached_json("smoke_test_cache_key")
    check(
        "_cached_json/_store_json round-trip", _got == {"hello": "world", "n": 42}, detail=str(_got)
    )
    check(
        "_cached_json returns None for missing key",
        _cached_json("smoke_test_no_such_key_xyz") is None,
    )

except Exception as exc:
    check("backlog-item-2 data layer smoke", False, repr(exc))


# --------------------------------------------------------------------------- #
# 12. Agentic architecture — TickerAgent, MemoryLayer, Orchestrator
# --------------------------------------------------------------------------- #
try:
    import asyncio as _asyncio

    from backend.agent import TickerAgent as _TickerAgent
    from backend.memory import MemoryLayer as _MemoryLayer
    from backend.orchestrator import Orchestrator as _Orchestrator
    from backend.skills import AgentContext as _AgentContext
    from backend.skills import Skill as _Skill
    from backend.skills import SkillResult as _SkillResult
    from backend.skills.ai_analysis import AIAnalysisSkill as _AIAnalysisSkill
    from backend.skills.alert import AlertSkill as _AlertSkill
    from backend.skills.fetch_data import FetchDataSkill as _FetchDataSkill
    from backend.skills.persist import PersistSkill as _PersistSkill

    check("import agent/memory/orchestrator/skills", True)

    # ── 12a. MemoryLayer — load returns {} for unknown ticker ───────────────
    _mem = _MemoryLayer()
    _mem_val = _mem.load("SMOKE_UNKNOWN_TICKER_XYZ")
    check("MemoryLayer.load returns {} for unknown ticker", _mem_val == {}, detail=str(_mem_val))

    # ── 12b. MemoryLayer — update and reload ───────────────────────────────
    _ctx_mem = _AgentContext(
        ticker="SMOKE",
        actionable=[{"type": "long", "confidence": 75.0}],
        market_data={"price": {"current": 100.0}, "technicals": {}},
        memory={},
    )
    _mem.update("SMOKE", _ctx_mem)
    _reloaded = _mem.load("SMOKE")
    check(
        "MemoryLayer.update persists last_signal",
        _reloaded.get("last_signal") == "long",
        detail=str(_reloaded),
    )
    check(
        "MemoryLayer.update persists last_confidence",
        _reloaded.get("last_confidence") == 75.0,
        detail=str(_reloaded),
    )

    # ── 12c. MemoryLayer.format_prompt_section ─────────────────────────────
    _section = _mem.format_prompt_section(_reloaded)
    check(
        "MemoryLayer.format_prompt_section returns PRIOR CONTEXT block",
        "PRIOR CONTEXT" in _section,
        detail=repr(_section),
    )

    # ── 12d. MemoryLayer.clear ─────────────────────────────────────────────
    _mem.clear("SMOKE")
    check("MemoryLayer.clear removes row", _mem.load("SMOKE") == {}, detail="expected {}")

    # ── 12e. Skill base — AgentContext and SkillResult shape ───────────────
    _ctx2 = _AgentContext(ticker="TEST")
    check("AgentContext defaults", _ctx2.errors == [] and _ctx2.events == [])
    _sr = _SkillResult(success=True, data={"x": 1})
    check("SkillResult fields", _sr.success is True and _sr.data == {"x": 1})

    # ── 12f. Skills are non-critical where expected ─────────────────────────
    check("PersistSkill critical=False", _PersistSkill.critical is False)
    check("AlertSkill critical=False", _AlertSkill.critical is False)
    check("FetchDataSkill critical=True", _FetchDataSkill.critical is True)
    check("AIAnalysisSkill can_retry=True", _AIAnalysisSkill.can_retry is True)

    # ── 12g. TickerAgent constructs with default skills ────────────────────
    _agent = _TickerAgent("AAPL", memory=_MemoryLayer())
    check("TickerAgent constructs", _agent.ticker == "AAPL")
    check("TickerAgent has 5 default skills", len(_agent._skills) == 5)

    # ── 12h. TickerAgent runs end-to-end with mocked skills ───────────────
    class _OkSkill(_FetchDataSkill):
        """Stub that injects synthetic market_data without hitting yfinance."""

        def run(self, ctx):
            ctx.market_data = {
                "ticker": ctx.ticker,
                "price": {"current": 150.0},
                "technicals": {},
                "fundamentals": {},
                "errors": [],
            }
            return _SkillResult(success=True, data=ctx.market_data)

    class _NoopSkill(_Skill):
        name = "noop"
        critical = False
        can_retry = False
        max_retries = 0
        retry_delay_base = 1.0

        def run(self, ctx):
            return _SkillResult(success=True, data=None)

    _agent2 = _TickerAgent(
        "AAPL",
        memory=_MemoryLayer(),
        skill_classes=[
            _OkSkill,
            type("_Noop1", (_NoopSkill,), {"name": "ai_analysis"}),
            type("_Noop2", (_NoopSkill,), {"name": "opportunity_detect"}),
            type("_Noop3", (_NoopSkill,), {"name": "persist"}),
            type("_Noop4", (_NoopSkill,), {"name": "alert"}),
        ],
        send_alerts=False,
    )
    _result2 = _asyncio.run(_agent2.run())
    check("TickerAgent.run() returns AgentResult", hasattr(_result2, "to_dict"))
    _rd = _result2.to_dict()
    check("AgentResult.to_dict() has ticker key", _rd.get("ticker") == "AAPL")
    check("AgentResult.to_dict() has market_data", _rd.get("market_data") is not None)

    # ── 12i. Orchestrator priority — unknown ticker gets max priority ───────
    _orch = _Orchestrator(memory=_MemoryLayer())
    _p = _orch.priority("COMPLETELY_UNKNOWN_TICKER_XYZ_999")
    check("Orchestrator.priority returns inf for unseen ticker", _p == float("inf"), detail=str(_p))

except Exception as exc:
    check("agentic architecture smoke", False, repr(exc))


# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #
if os.path.exists(_TMP_DB):
    os.remove(_TMP_DB)  # existence already checked above; race window negligible in tests

print("\n" + ("=" * 50))
if failures:
    print(f"SMOKE TEST FAILED — {len(failures)} check(s): {failures}")
    sys.exit(1)
print("SMOKE TEST PASSED — all checks green")
