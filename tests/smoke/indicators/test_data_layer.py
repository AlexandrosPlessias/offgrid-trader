"""Section 11 — Backlog item 2: balance sheet, FRED macro, prompt blocks, cache."""

from __future__ import annotations

import urllib.parse
from unittest import mock

from backend import data


def test_data_layer(check, synthetic):
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
