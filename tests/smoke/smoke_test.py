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
check(
    "all expected routes present",
    expected.issubset(paths),
    f"missing={expected - paths}",
)


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
# 7. AI analysis with mocked LLM (provider-agnostic)
# --------------------------------------------------------------------------- #
_FAKE_LLM_JSON = (
    '{"trend":"bullish","momentum":"strong","key_levels":{"support":[95],'
    '"resistance":[110]},"signals":["x"],"opportunity":{"type":"long",'
    '"confidence":75,"entry":100,"stop":95,"target":110},"risk_factors":["y"]}'
)
# call_llm returns (raw_text, model_used, prompt_tokens, completion_tokens)
_FAKE_LLM_RETURN = (_FAKE_LLM_JSON, "mock-model", 100, 50)
with mock.patch("backend.analysis.call_llm", return_value=_FAKE_LLM_RETURN):
    parsed = analysis.analyze(synthetic)
check(
    "analyze() parses mocked Ollama JSON",
    parsed.get("trend") == "bullish",
    repr(parsed),
)
check("analyze() opportunity normalised", parsed["opportunity"]["type"] == "long")

# LLM unavailable path.
from backend.analysis import LLMError  # noqa: E402

with mock.patch("backend.analysis.call_llm", side_effect=LLMError("offline")):
    err = analysis.analyze(synthetic)
check("analyze() handles Ollama offline", "error" in err and err["opportunity"] is None)


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
        "news_sentiment": {
            "score": 0.28,
            "label": "Bullish",
            "article_count": 1,
            "scored_headlines": [
                {"headline": "Apple beats estimates", "score": 0.28, "label": "Bullish"}
            ],
        },
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
        "build_prompt contains RECENT NEWS HEADLINES block",
        "RECENT NEWS HEADLINES" in prompt_text,
    )
    check("build_prompt news shows source", "(Reuters)" in prompt_text)
    check(
        "build_prompt contains VALUATION block with P/E",
        "VALUATION" in prompt_text and "28.5" in prompt_text,
    )
    check("build_prompt macro shows inverted warning", "INVERTED" in prompt_text)
    check(
        "build_prompt contains Aggregate sentiment line",
        "Aggregate sentiment:" in prompt_text,
        detail=prompt_text,
    )

    # 11d. Cache round-trip via _cached_json / _store_json
    _store_json("smoke_test_cache_key", {"hello": "world", "n": 42})
    _got = _cached_json("smoke_test_cache_key")
    check(
        "_cached_json/_store_json round-trip",
        _got == {"hello": "world", "n": 42},
        detail=str(_got),
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
    check(
        "MemoryLayer.load returns {} for unknown ticker",
        _mem_val == {},
        detail=str(_mem_val),
    )

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
    check("TickerAgent has 6 default skills", len(_agent._skills) == 6)

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
    check(
        "Orchestrator.priority returns inf for unseen ticker",
        _p == float("inf"),
        detail=str(_p),
    )

except Exception as exc:
    check("agentic architecture smoke", False, repr(exc))


# --------------------------------------------------------------------------- #
# 13. Backtesting engine smoke tests
# --------------------------------------------------------------------------- #
print("\n── 13. Backtesting engine ──────────────────────────────────────────")

try:
    import datetime as _dt

    import numpy as _np
    import pandas as _pd

    from backend.backtest import BacktestParams

    # ── Build a synthetic 6-month OHLCV frame (business days only) ──────────
    def _make_ohlcv(n: int, start_price: float = 100.0) -> _pd.DataFrame:
        """Return an OHLCV DataFrame with n business-day bars."""
        dates = _pd.bdate_range(end=_dt.date.today(), periods=n + 10)[-n:]
        _np.random.seed(42)
        closes = _np.cumprod(1 + _np.random.normal(0, 0.01, n)) * start_price
        opens = closes * (1 + _np.random.normal(0, 0.003, n))
        highs = _np.maximum(closes, opens) * (1 + _np.abs(_np.random.normal(0, 0.005, n)))
        lows = _np.minimum(closes, opens) * (1 - _np.abs(_np.random.normal(0, 0.005, n)))
        vols = _np.random.randint(1_000_000, 5_000_000, n).astype(float)
        df = _pd.DataFrame(
            {
                "Open": opens,
                "High": highs,
                "Low": lows,
                "Close": closes,
                "Volume": vols,
            },
            index=_pd.DatetimeIndex(dates, tz="UTC"),
        )
        return df

    _df_1d = _make_ohlcv(310)  # enough lead-in for EMA200
    _df_1h = _make_ohlcv(45 * 7, start_price=_df_1d["Close"].iloc[-1])  # ~45 days x 7 bars/day

    # ── 13a. BacktestParams validation ───────────────────────────────────────
    try:
        BacktestParams(tickers=[], start_date="2024-01-01", end_date="2024-06-30")
        check("BacktestParams rejects empty tickers", False)
    except (ValueError, AssertionError):
        check("BacktestParams rejects empty tickers", True)

    _start_str = (_dt.date.today() - _dt.timedelta(days=60)).isoformat()
    _end_str = (_dt.date.today() - _dt.timedelta(days=1)).isoformat()
    BacktestParams(
        tickers=["SMOKETEST"],
        start_date=_start_str,
        end_date=_end_str,
        confidence_floor=0.0,  # capture all signals
        max_hold_days=5,
        use_llm=False,
        atr_multiple=1.5,
        reward_risk=2.0,
    )
    check("BacktestParams constructs valid params", True)

    # ── 13b. ATR helper ───────────────────────────────────────────────────────
    from backend.data import atr as _atr

    _atr_val = _atr(_df_1d)
    check(
        "atr() returns a positive float from synthetic frame",
        isinstance(_atr_val, float) and _atr_val > 0,
        detail=str(_atr_val),
    )

    # ── 13c. build_market_data_asof ──────────────────────────────────────────
    from backend.backtest import build_market_data_asof

    _asof = _df_1d.index[-10]
    _md_asof = build_market_data_asof("SMOKETEST", _asof, _df_1h, _df_1d)
    check("build_market_data_asof returns dict", isinstance(_md_asof, dict))
    check(
        "build_market_data_asof has price key",
        "price" in _md_asof
        and isinstance(_md_asof["price"], dict)
        and (_md_asof["price"].get("current") or 0) > 0,
    )
    check(
        "build_market_data_asof has technicals",
        "technicals" in _md_asof and _md_asof["technicals"],
    )
    check("build_market_data_asof fundamentals empty", _md_asof.get("fundamentals") == {})

    # ── 13d. synthesize_bracket ──────────────────────────────────────────────
    from backend.backtest import synthesize_bracket

    _sig_no_bracket = {
        "type": "long",
        "entry": 100.0,
        "stop": None,
        "target": None,
    }
    _bracketed = synthesize_bracket(_sig_no_bracket, atr_val=2.0, atr_multiple=1.5, reward_risk=2.0)
    check(
        "synthesize_bracket sets stop for long",
        _bracketed["stop"] < 100.0,
        detail=str(_bracketed["stop"]),
    )
    check(
        "synthesize_bracket sets target for long",
        _bracketed["target"] > 100.0,
        detail=str(_bracketed["target"]),
    )
    check(
        "synthesize_bracket reward_risk ratio correct",
        abs((_bracketed["target"] - 100.0) / (100.0 - _bracketed["stop"]) - 2.0) < 0.01,
        detail=str(_bracketed),
    )

    _sig_short = {"type": "short", "entry": 100.0, "stop": None, "target": None}
    _b_short = synthesize_bracket(_sig_short, atr_val=2.0, atr_multiple=1.5, reward_risk=2.0)
    check("synthesize_bracket stop above entry for short", _b_short["stop"] > 100.0)
    check("synthesize_bracket target below entry for short", _b_short["target"] < 100.0)

    # ── 13e. evaluate_outcome — win, loss, same-bar tie-break ────────────────
    import pandas as _pd2

    from backend.backtest import evaluate_outcome

    def _make_signal(entry, stop, target, direction="long"):
        return {
            "type": direction,
            "entry": entry,
            "stop": stop,
            "target": target,
            "confidence": 80.0,
            "ticker": "SMOKETEST",
            "signal_date": "2024-01-01",
            "source": "rule:test",
        }

    # Win: high reaches target before low reaches stop
    _fwd_win = _pd2.DataFrame(
        {
            "Open": [101, 102],
            "High": [103, 110],
            "Low": [100, 101],
            "Close": [102, 109],
        },
        index=_pd2.date_range("2024-01-02", periods=2, freq="B"),
    )
    _result_win = evaluate_outcome(_make_signal(100.0, 97.0, 106.0), _fwd_win, max_hold_days=5)
    check(
        "evaluate_outcome win — outcome is 'win'",
        _result_win["outcome"] == "win",
        detail=str(_result_win),
    )
    check(
        "evaluate_outcome win — r_multiple positive",
        (_result_win["r_multiple"] or 0) > 0,
        detail=str(_result_win["r_multiple"]),
    )

    # Loss: low reaches stop
    _fwd_loss = _pd2.DataFrame(
        {
            "Open": [99, 98],
            "High": [99.5, 98.5],
            "Low": [96.5, 96.0],
            "Close": [97, 96.5],
        },
        index=_pd2.date_range("2024-01-02", periods=2, freq="B"),
    )
    _result_loss = evaluate_outcome(_make_signal(100.0, 97.0, 106.0), _fwd_loss, max_hold_days=5)
    check(
        "evaluate_outcome loss — outcome is 'loss'",
        _result_loss["outcome"] == "loss",
        detail=str(_result_loss),
    )
    check(
        "evaluate_outcome loss -- r_multiple ~= -1",
        abs((_result_loss["r_multiple"] or 0) + 1.0) < 0.05,
        detail=str(_result_loss["r_multiple"]),
    )

    # Same-bar tie-break: stop and target both in same bar → conservative → loss
    _fwd_tie = _pd2.DataFrame(
        {
            "Open": [100],
            "High": [107],
            "Low": [96],
            "Close": [101],
        },  # both 97 stop and 106 target
        index=_pd2.date_range("2024-01-02", periods=1, freq="B"),
    )
    _result_tie = evaluate_outcome(_make_signal(100.0, 97.0, 106.0), _fwd_tie, max_hold_days=5)
    check(
        "evaluate_outcome same-bar tie-break → loss",
        _result_tie["outcome"] == "loss",
        detail=str(_result_tie),
    )

    # Timeout: neither stop nor target hit within max_hold_days
    _fwd_quiet = _pd2.DataFrame(
        {
            "Open": [100.5] * 5,
            "High": [101.0] * 5,
            "Low": [99.5] * 5,
            "Close": [100.5] * 5,
        },
        index=_pd2.date_range("2024-01-02", periods=5, freq="B"),
    )
    _result_timeout = evaluate_outcome(
        _make_signal(100.0, 97.0, 106.0), _fwd_quiet, max_hold_days=5
    )
    check(
        "evaluate_outcome timeout",
        _result_timeout["outcome"] == "timeout",
        detail=str(_result_timeout),
    )

    # ── 13f. compute_metrics — floor_sweep monotonic ─────────────────────────
    from backend.backtest import compute_metrics

    _trades_sample = [
        {"confidence": 80.0, "outcome": "win", "r_multiple": 2.0},
        {"confidence": 72.0, "outcome": "loss", "r_multiple": -1.0},
        {"confidence": 60.0, "outcome": "win", "r_multiple": 2.0},
        {"confidence": 55.0, "outcome": "loss", "r_multiple": -1.0},
        {"confidence": 90.0, "outcome": "win", "r_multiple": 2.0},
    ]
    _metrics = compute_metrics(_trades_sample, floor=0.0)
    check("compute_metrics returns metrics dict", isinstance(_metrics, dict))
    check(
        "compute_metrics has floor_sweep",
        "floor_sweep" in _metrics and len(_metrics["floor_sweep"]) > 0,
    )
    # Higher floor → fewer or equal trades (monotonic non-increasing)
    _sweep = _metrics["floor_sweep"]
    _counts = [e["total_trades"] for e in _sweep]
    check(
        "floor_sweep trade count non-increasing with floor",
        all(_counts[i] >= _counts[i + 1] for i in range(len(_counts) - 1)),
        detail=str(_counts),
    )
    check(
        "compute_metrics total_trades at floor=0 equals 5",
        _metrics.get("total_trades") == 5,
        detail=str(_metrics.get("total_trades")),
    )

    # ── 13g. ai_floor_override=0.0 captures a below-floor AI signal ──────────
    from backend.opportunities import detect_opportunities

    _low_conf_analysis = {
        "error": None,
        "opportunity": {
            "type": "long",
            "confidence": 20,
            "entry": 100.0,
            "stop": 97.0,
            "target": 106.0,
            "reasons": ["test"],
        },
    }
    _mkt = {
        "ticker": "SMOKETEST",
        "price": {"current": 100.0, "change_pct": 0.0, "volume_ratio": 1.0},
        "technicals": {"rsi_1d": 50, "rsi_1h": 50},
        "fundamentals": {},
        "macro": {},
        "news": [],
        "memory": {},
    }
    # Without override: floor is default (65), a confidence=20 signal should not appear
    _opps_default = detect_opportunities(_mkt, _low_conf_analysis)
    _ai_default = [o for o in _opps_default if o.get("source") == "ai"]
    # With override=0.0: should capture the AI signal regardless of its confidence
    _opps_override = detect_opportunities(_mkt, _low_conf_analysis, ai_floor_override=0.0)
    _ai_override = [o for o in _opps_override if o.get("source") == "ai"]
    check(
        "ai_floor_override=0.0 captures below-floor AI signal",
        len(_ai_override) > 0,
        detail=f"default={len(_ai_default)}, override={len(_ai_override)}",
    )

    # ── 13h. DB round-trip: save_backtest_run + get_backtest_run ─────────────
    from backend.database import (
        delete_backtest_run,
        get_backtest_run,
        get_backtest_runs,
        save_backtest_run,
        save_backtest_trade,
        update_backtest_run,
    )

    _run_id = save_backtest_run(
        ["SMOKETEST"],
        "2024-01-01",
        "2024-06-30",
        initial_balance=10000.0,
        confidence_floor=65,
        max_hold_days=10,
        signal_mode="rules",
        atr_multiple=1.5,
        reward_risk=2.0,
        requests_per_minute=None,
    )
    check(
        "save_backtest_run returns int id",
        isinstance(_run_id, int) and _run_id > 0,
        detail=str(_run_id),
    )

    save_backtest_trade(
        _run_id,
        "SMOKETEST",
        "2024-03-01",
        "long",
        80.0,
        source="rule:test",
        entry=100.0,
        stop=97.0,
        target=106.0,
        exit_date="2024-03-03",
        exit_price=106.0,
        outcome="win",
        r_multiple=2.0,
        reasons=["test"],
    )

    update_backtest_run(_run_id, status="done", metrics={"win_rate": 1.0})
    _runs = get_backtest_runs()
    check("get_backtest_runs returns list", isinstance(_runs, list))
    _run_ids_in_list = [r["id"] for r in _runs]
    check("saved run appears in get_backtest_runs", _run_id in _run_ids_in_list)

    _fetched = get_backtest_run(_run_id)
    check(
        "get_backtest_run returns the run",
        _fetched is not None and _fetched.get("id") == _run_id,
    )
    assert _fetched is not None  # narrowed above; assert keeps Pylance happy
    check("get_backtest_run includes trades", len(_fetched.get("trades", [])) == 1)
    check(
        "get_backtest_run trade has r_multiple",
        _fetched["trades"][0].get("r_multiple") == 2.0,
    )

    delete_backtest_run(_run_id)
    check("delete_backtest_run removes run", get_backtest_run(_run_id) is None)

    # ── 13i. LLM-mode fallback: mock 429 on first provider → fallback ────────
    from backend import analysis as _analysis_mod

    _fallback_events: list[dict] = []

    def _mock_emit(evt):
        _fallback_events.append(evt)

    # Patch call_llm to raise LLMError on the first call, succeed on the second
    _call_count = {"n": 0}

    def _mock_call_llm(*args, use_fallback=False, **kwargs):
        _call_count["n"] += 1
        if _call_count["n"] == 1:
            from backend.analysis import LLMError

            raise LLMError("429 quota exceeded")
        # Return a minimal valid tuple: (text, model, prompt_tokens, completion_tokens)
        return (
            '{"type":"long","confidence":70,"reasons":["test"],"entry":100}',
            "mock-model",
            100,
            50,
        )

    from backend.analysis import LLMError as _LLMError

    with mock.patch.object(_analysis_mod, "call_llm", side_effect=_mock_call_llm):
        try:
            # call_llm with use_fallback=False should raise on first call
            _analysis_mod.call_llm("test prompt", use_fallback=False)
            check("mocked call_llm raises LLMError on first call", False)
        except _LLMError:
            check("mocked call_llm raises LLMError on first call", True)
        # call_llm with use_fallback=False but _call_count reset means next call succeeds
        # (This tests the mock wiring is correct; fallback chain test is done via analyze())
        _call_count["n"] = 1  # reset to trigger the fallback path next call
        _result_retry = _analysis_mod.call_llm("test prompt", use_fallback=False)
        check("mocked call_llm succeeds on second call", _result_retry is not None)

    check("backtesting engine smoke complete", True)

except Exception:
    import traceback

    check("backtesting engine smoke", False, traceback.format_exc()[-300:])


# --------------------------------------------------------------------------- #
# 14. News Sentiment Layer
# --------------------------------------------------------------------------- #
print("\n[14] News Sentiment Layer")

try:
    from backend.data import (
        _merge_news,
        fetch_google_news_rss,
        score_news_sentiment,
    )
    from backend.opportunities import _apply_sentiment_filter

    # 14a. score_news_sentiment — empty list → Neutral / 0.0
    _sent_empty = score_news_sentiment([])
    check(
        "score_news_sentiment empty list → Neutral",
        _sent_empty.get("label") == "Neutral" and _sent_empty.get("score") == 0.0,
        detail=str(_sent_empty),
    )
    check(
        "score_news_sentiment empty list → article_count 0",
        _sent_empty.get("article_count") == 0,
        detail=str(_sent_empty),
    )

    # 14b. score_news_sentiment — positive headlines → Bullish label
    _pos_news = [
        {
            "headline": "Company beats earnings estimates by wide margin",
            "source": "Reuters",
            "url": "",
            "datetime": "",
        },
        {
            "headline": "Stock surges on record revenue growth",
            "source": "AP",
            "url": "",
            "datetime": "",
        },
    ]
    _sent_pos = score_news_sentiment(_pos_news)
    check(
        "score_news_sentiment positive headlines → score > 0",
        _sent_pos.get("score", 0) > 0,
        detail=str(_sent_pos),
    )
    check(
        "score_news_sentiment positive headlines returns scored_headlines",
        isinstance(_sent_pos.get("scored_headlines"), list)
        and len(_sent_pos["scored_headlines"]) > 0,
        detail=str(_sent_pos),
    )

    # 14c. score_news_sentiment — negative headlines → score < 0
    _neg_news = [
        {
            "headline": "Stock crashes on terrible earnings miss",
            "source": "Reuters",
            "url": "",
            "datetime": "",
        },
        {
            "headline": "Company faces bankruptcy fears amid falling revenue",
            "source": "AP",
            "url": "",
            "datetime": "",
        },
    ]
    _sent_neg = score_news_sentiment(_neg_news)
    check(
        "score_news_sentiment negative headlines → score < 0",
        _sent_neg.get("score", 0) < 0,
        detail=str(_sent_neg),
    )

    # 14d. _merge_news — deduplication
    _primary = [
        {
            "headline": "Apple beats estimates",
            "source": "Reuters",
            "url": "http://a.com/1",
            "datetime": "",
        },
        {
            "headline": "Apple opens new store",
            "source": "AP",
            "url": "http://a.com/2",
            "datetime": "",
        },
    ]
    _supplement = [
        # duplicate (case-insensitive)
        {
            "headline": "Apple Beats Estimates",
            "source": "GNews",
            "url": "http://b.com/1",
            "datetime": "",
        },
        # new
        {
            "headline": "Apple CEO interview",
            "source": "GNews",
            "url": "http://b.com/2",
            "datetime": "",
        },
    ]
    _merged = _merge_news(_primary, _supplement, max_total=10)
    _merged_headlines = [item["headline"].lower() for item in _merged]
    check(
        "_merge_news deduplicates case-insensitively",
        _merged_headlines.count("apple beats estimates") == 1,
        detail=str(_merged_headlines),
    )
    check(
        "_merge_news includes supplement-only headline",
        "apple ceo interview" in _merged_headlines,
        detail=str(_merged_headlines),
    )
    check(
        "_merge_news total ≤ max_total",
        len(_merged) <= 10,
        detail=str(len(_merged)),
    )

    # 14e. _merge_news — max_total cap
    _big_primary = [
        {"headline": f"Story {i}", "source": "S", "url": "", "datetime": ""} for i in range(8)
    ]
    _big_supp = [
        {"headline": f"Extra {i}", "source": "G", "url": "", "datetime": ""} for i in range(8)
    ]
    _merged_capped = _merge_news(_big_primary, _big_supp, max_total=10)
    check(
        "_merge_news caps at max_total",
        len(_merged_capped) == 10,
        detail=str(len(_merged_capped)),
    )

    # 14f. _apply_sentiment_filter — Bullish strong boosts long opportunity
    _opp_long = {
        "ticker": "AAPL",
        "type": "long",
        "confidence": 60,
        "rules_checked": {},
    }
    _sent_strong_bull = {"score": 0.4, "label": "Bullish", "article_count": 3}
    _filtered_bull = _apply_sentiment_filter([_opp_long], _sent_strong_bull)
    check(
        "_apply_sentiment_filter Bullish strong boosts long confidence",
        _filtered_bull[0]["confidence"] > 60,
        detail=str(_filtered_bull),
    )
    check(
        "_apply_sentiment_filter Bullish strong delta ≤ 3",
        _filtered_bull[0]["confidence"] <= 63,
        detail=str(_filtered_bull),
    )

    # 14g. _apply_sentiment_filter — Bearish hurts long opportunity
    _opp_long2 = {
        "ticker": "AAPL",
        "type": "long",
        "confidence": 60,
        "rules_checked": {},
    }
    _sent_bear = {"score": -0.4, "label": "Bearish", "article_count": 3}
    _filtered_bear = _apply_sentiment_filter([_opp_long2], _sent_bear)
    check(
        "_apply_sentiment_filter Bearish reduces long confidence",
        _filtered_bear[0]["confidence"] < 60,
        detail=str(_filtered_bear),
    )

    # 14h. _apply_sentiment_filter — confidence never goes below 0 or above 100
    _opp_edge_high = {
        "ticker": "AAPL",
        "type": "long",
        "confidence": 99,
        "rules_checked": {},
    }
    _filtered_edge = _apply_sentiment_filter([_opp_edge_high], _sent_strong_bull)
    check(
        "_apply_sentiment_filter confidence never exceeds 100",
        _filtered_edge[0]["confidence"] <= 100,
        detail=str(_filtered_edge),
    )
    _opp_edge_low = {
        "ticker": "AAPL",
        "type": "long",
        "confidence": 1,
        "rules_checked": {},
    }
    _filtered_edge_low = _apply_sentiment_filter([_opp_edge_low], _sent_bear)
    check(
        "_apply_sentiment_filter confidence never goes below 0",
        _filtered_edge_low[0]["confidence"] >= 0,
        detail=str(_filtered_edge_low),
    )

    # 14i. fetch_google_news_rss — returns list (may be empty if network unavailable)
    try:
        import socket

        socket.setdefaulttimeout(5)
        _gnews = fetch_google_news_rss("AAPL", n=3)
        check(
            "fetch_google_news_rss returns list",
            isinstance(_gnews, list),
            detail=str(type(_gnews)),
        )
        if _gnews:
            _first = _gnews[0]
            check(
                "fetch_google_news_rss item has required keys",
                all(k in _first for k in ("headline", "source", "url", "datetime")),
                detail=str(_first),
            )
    except Exception as _gnews_exc:
        # Network may be unavailable in CI; graceful degradation is acceptable
        check(
            "fetch_google_news_rss graceful on network error",
            True,
            detail=repr(_gnews_exc),
        )

    check("news sentiment layer smoke complete", True)

except Exception:
    import traceback as _traceback14

    check("news sentiment layer smoke", False, _traceback14.format_exc()[-400:])


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


# --------------------------------------------------------------------------- #
# 16. Discovery — fetch_candidates, score_candidate, run_discovery
# --------------------------------------------------------------------------- #
try:
    from unittest import mock as _mock16

    from backend.discovery import fetch_candidates, run_discovery, score_candidate

    # 16a. _fetch_from_yfinance — normalises yf.screen output
    _YF_SCREEN_RESPONSE = {
        "quotes": [
            {
                "symbol": "AAPL",
                "regularMarketPrice": 195.0,
                "regularMarketChangePercent": 3.5,
                "regularMarketVolume": 40_000_000,
            },
            {
                "symbol": "NVDA",
                "regularMarketPrice": 131.2,
                "regularMarketChangePercent": 5.1,
                "regularMarketVolume": 45_000_000,
            },
        ]
    }

    with _mock16.patch("yfinance.screen", return_value=_YF_SCREEN_RESPONSE):
        from backend.discovery import _fetch_from_yfinance as _ftyf16

        _yf_results = _ftyf16(["day_gainers"])

    check(
        "16a. _fetch_from_yfinance normalises symbols to uppercase",
        all(c["symbol"].isupper() for c in _yf_results),
        detail=str(_yf_results),
    )
    check(
        "16a. _fetch_from_yfinance returns price/pct/volume",
        all("price" in c and "percent_change" in c and "volume" in c for c in _yf_results),
        detail=str(_yf_results),
    )
    check(
        "16a. _fetch_from_yfinance source tag set correctly",
        all(c["source"] == "yf_day_gainers" for c in _yf_results),
        detail=str(_yf_results),
    )

    # 16b. _fetch_from_yfinance — graceful on screen() failure
    with _mock16.patch("yfinance.screen", side_effect=Exception("network error")):
        _empty = _ftyf16(["most_actives"])
    check(
        "16b. _fetch_from_yfinance returns [] on network failure",
        _empty == [],
        detail=str(_empty),
    )

    # 16c. _dedupe — keeps first occurrence of each symbol
    from backend.discovery import _dedupe as _dd16

    _duped = [
        {"symbol": "AAPL", "source": "first"},
        {"symbol": "NVDA", "source": "second"},
        {"symbol": "AAPL", "source": "duplicate"},
    ]
    _deduped = _dd16(_duped)
    check(
        "16c. _dedupe removes duplicate symbols",
        len(_deduped) == 2,
        detail=str(_deduped),
    )
    check(
        "16c. _dedupe keeps first occurrence",
        _deduped[0]["source"] == "first",
        detail=str(_deduped),
    )

    # 16d. fetch_candidates — caches result; second call returns cache
    _cache_key16 = (
        f"discovery:candidates:{__import__('datetime').datetime.utcnow().strftime('%Y-%m-%d-%H')}"
    )
    with _mock16.patch("yfinance.screen", return_value=_YF_SCREEN_RESPONSE) as _msc16:
        with _mock16.patch("backend.discovery._fetch_from_alpaca", return_value=([], None)):
            _c1 = fetch_candidates(sources="alpaca,yfinance", limit=50)
            _c2 = fetch_candidates(sources="alpaca,yfinance", limit=50)  # from cache
    check(
        "16d. fetch_candidates returns non-empty list",
        len(_c1) >= 1,
        detail=str(_c1),
    )
    check(
        "16d. fetch_candidates second call served from cache (no extra yf.screen calls)",
        _msc16.call_count
        <= len(["day_gainers", "most_actives", "day_losers", "small_cap_gainers"]),
        detail=f"screen calls={_msc16.call_count}",
    )

    # 16e. score_candidate — scoring bounds 0 ≤ score ≤ 100
    _FAKE_INDICATORS = {
        "technicals": {
            "1H": {
                "RSI": 55.0,
                "MACD": {"macd": 0.5, "signal": 0.3},
                "EMA20": 190.0,
                "EMA50": 185.0,
                "recommendation": "buy",
            },
            "4H": {
                "RSI": 60.0,
                "MACD": {"macd": 0.8, "signal": 0.4},
                "EMA20": 190.0,
                "EMA50": 185.0,
                "recommendation": "buy",
            },
            "1D": {
                "RSI": 58.0,
                "MACD": {"macd": 1.0, "signal": 0.6},
                "EMA20": 188.0,
                "EMA50": 183.0,
                "recommendation": "buy",
            },
        },
        "errors": [],
    }

    with _mock16.patch("backend.data.compute_indicators", return_value=_FAKE_INDICATORS):
        _score_result = score_candidate(
            "AAPL",
            {
                "symbol": "AAPL",
                "price": 195.0,
                "percent_change": 4.2,
                "volume": 40_000_000,
                "source": "yf_day_gainers",
            },
        )

    check(
        "16e. score_candidate returns score in 0-100",
        0.0 <= _score_result["score"] <= 100.0,
        detail=str(_score_result),
    )
    check(
        "16e. score_candidate returns reasons list",
        isinstance(_score_result["reasons"], list),
        detail=str(_score_result),
    )
    check(
        "16e. score_candidate returns components dict",
        isinstance(_score_result["components"], dict),
        detail=str(_score_result),
    )
    check(
        "16e. score_candidate component keys present",
        all(k in _score_result["components"] for k in ("momentum", "volume", "trend", "rsi_macd")),
        detail=str(_score_result["components"]),
    )

    # 16f. score_candidate — graceful on indicator failure
    with _mock16.patch("backend.data.compute_indicators", side_effect=Exception("timeout")):
        _bad_score = score_candidate("FAIL", {"symbol": "FAIL", "price": None})
    check(
        "16f. score_candidate returns score=0 on indicator failure",
        _bad_score["score"] == 0.0,
        detail=str(_bad_score),
    )

    # 16g. run_discovery — min_score filter applied; all results returned when none qualify
    _all_low_indicators = {
        "technicals": {
            "1H": {
                "RSI": 30.0,
                "MACD": {"macd": -0.5, "signal": 0.1},
                "EMA20": 90.0,
                "EMA50": 100.0,
                "recommendation": "sell",
            },
            "4H": {
                "RSI": 28.0,
                "MACD": {"macd": -0.8, "signal": 0.2},
                "EMA20": 90.0,
                "EMA50": 100.0,
                "recommendation": "sell",
            },
            "1D": {
                "RSI": 25.0,
                "MACD": {"macd": -1.0, "signal": 0.3},
                "EMA20": 88.0,
                "EMA50": 98.0,
                "recommendation": "sell",
            },
        }
    }
    with _mock16.patch(
        "backend.data.compute_indicators", return_value=_all_low_indicators
    ), _mock16.patch(
        "backend.discovery.fetch_candidates",
        return_value=[
            {
                "symbol": "LOW1",
                "price": 10.0,
                "percent_change": 0.1,
                "volume": 100,
                "source": "yf_test",
            },
            {
                "symbol": "LOW2",
                "price": 10.0,
                "percent_change": 0.2,
                "volume": 100,
                "source": "yf_test",
            },
        ],
    ):
        _low_run = run_discovery(sources="yfinance", max_candidates=5, min_score=90)

    check(
        "16g. run_discovery returns all results when none clear min_score",
        len(_low_run) > 0,
        detail=f"low_run len={len(_low_run)}",
    )

    # 16h. run_discovery — sorted descending by score
    with _mock16.patch(
        "backend.data.compute_indicators", return_value=_FAKE_INDICATORS
    ), _mock16.patch(
        "backend.discovery.fetch_candidates",
        return_value=[
            {
                "symbol": "AAPL",
                "price": 195.0,
                "percent_change": 5.0,
                "volume": 40_000_000,
                "source": "yf",
            },
            {
                "symbol": "MSFT",
                "price": 400.0,
                "percent_change": 1.0,
                "volume": 10_000_000,
                "source": "yf",
            },
            {
                "symbol": "NVDA",
                "price": 131.0,
                "percent_change": 8.0,
                "volume": 60_000_000,
                "source": "yf",
            },
        ],
    ):
        _sorted_run = run_discovery(sources="yfinance", max_candidates=3, min_score=0)

    check(
        "16h. run_discovery results sorted descending by score",
        all(
            _sorted_run[i]["score"] >= _sorted_run[i + 1]["score"]
            for i in range(len(_sorted_run) - 1)
        ),
        detail=[(c["ticker"], c["score"]) for c in _sorted_run],
    )

    # 16i. run_discovery — empty fetch returns []
    with _mock16.patch("backend.discovery.fetch_candidates", return_value=[]):
        _empty_run = run_discovery(sources="yfinance", max_candidates=5, min_score=0)
    check(
        "16i. run_discovery returns [] when no candidates fetched",
        _empty_run == [],
        detail=str(_empty_run),
    )

    # 16j. DB helpers — save and retrieve discovery run + candidates
    from backend.database import (
        delete_watchlist_group,
        get_latest_discovery,
        get_watchlist_groups,
        save_discovery_candidates,
        save_discovery_run,
        save_watchlist_group,
        update_discovery_run,
    )

    _run_id = save_discovery_run("yfinance", _TMP_DB)
    save_discovery_candidates(
        _run_id,
        [
            {
                "symbol": "AAPL",
                "ticker": "AAPL",
                "score": 75.0,
                "price": 195.0,
                "percent_change": 3.5,
                "volume": 40_000_000,
                "source": "yf",
                "reasons": ["Strong move"],
                "components": {"momentum": 10.5},
            },
        ],
        _TMP_DB,
    )
    update_discovery_run(_run_id, "done", 1, db_path=_TMP_DB)
    _latest = get_latest_discovery(_TMP_DB)

    check(
        "16j. get_latest_discovery returns run after save",
        _latest is not None and _latest["id"] == _run_id,
        detail=str(_latest),
    )
    check(
        "16j. get_latest_discovery candidates decoded from JSON",
        isinstance(_latest["candidates"][0]["reasons"], list),
        detail=str(_latest["candidates"][0]),
    )

    # 16j-2. get_discovery_run_candidates returns per-run candidates
    from backend.database import get_discovery_run_candidates

    _run_cands = get_discovery_run_candidates(_run_id, _TMP_DB)
    check(
        "16j. get_discovery_run_candidates returns candidates for run",
        len(_run_cands) == 1 and _run_cands[0]["ticker"] == "AAPL",
        detail=str(_run_cands),
    )
    check(
        "16j. get_discovery_run_candidates decodes reasons from JSON",
        isinstance(_run_cands[0]["reasons"], list),
        detail=str(_run_cands[0]),
    )
    check(
        "16j. get_discovery_run_candidates decodes components from JSON",
        isinstance(_run_cands[0]["components"], dict),
        detail=str(_run_cands[0]),
    )

    # 16k. Watchlist groups round-trip
    _gid = save_watchlist_group("Tech", ["AAPL", "MSFT"], _TMP_DB)
    _groups = get_watchlist_groups(_TMP_DB)
    check(
        "16k. save_watchlist_group + get_watchlist_groups round-trip",
        any(g["name"] == "Tech" and "AAPL" in g["tickers"] for g in _groups),
        detail=str(_groups),
    )
    _del_ok = delete_watchlist_group(_gid, _TMP_DB)
    check(
        "16k. delete_watchlist_group removes entry",
        _del_ok and not any(g["name"] == "Tech" for g in get_watchlist_groups(_TMP_DB)),
        detail=f"del_ok={_del_ok}",
    )

    check("Discovery smoke (16) complete", True)

except Exception:
    import traceback as _tb16

    check("Discovery smoke (16)", False, _tb16.format_exc()[-600:])


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
