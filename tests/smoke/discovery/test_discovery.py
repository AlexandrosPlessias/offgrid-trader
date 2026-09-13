"""Section 16 — Discovery: fetch_candidates, score_candidate, run_discovery."""

from __future__ import annotations

import os
from unittest import mock as _mock16

_TMP_DB = os.environ.get("DATABASE_PATH", "")


def test_discovery(check):
    # --------------------------------------------------------------------------- #
    # 16. Discovery — fetch_candidates, score_candidate, run_discovery
    # --------------------------------------------------------------------------- #
    try:
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
# 16L — HTTP endpoint: GET /discovery/history/{run_id}/candidates
#
# Exercises the full HTTP layer (TestClient) rather than the DB function
# directly.  Three scenarios:
#   • Happy path  — saves a run + candidate, calls endpoint, checks shape.
#   • 404 path    — non-existent run_id returns 404.
#   • JSON decode — reasons and components are returned as decoded objects,
#                   not raw JSON strings.
# --------------------------------------------------------------------------- #
def test_discovery_run_candidates_endpoint(check):
    """16L — GET /discovery/history/{run_id}/candidates via TestClient."""
    from unittest import mock

    from fastapi.testclient import TestClient

    from backend import scheduler
    from backend.database import (
        save_discovery_candidates,
        save_discovery_run,
        update_discovery_run,
    )
    from backend.main import app

    try:
        # ── Seed DB ───────────────────────────────────────────────────────────
        run_id = save_discovery_run("yfinance", _TMP_DB)
        save_discovery_candidates(
            run_id,
            [
                {
                    "symbol":         "TSLA",
                    "ticker":         "TSLA",
                    "score":          68.5,
                    "price":          250.0,
                    "percent_change": 4.1,
                    "volume":         30_000_000,
                    "source":         "yf_day_gainers",
                    "reasons":        ["Strong momentum", "Volume spike"],
                    "components":     {"momentum": 20.0, "volume": 18.5, "trend": 15.0, "rsi_macd": 15.0},
                },
                {
                    "symbol":         "AMZN",
                    "ticker":         "AMZN",
                    "score":          55.0,
                    "price":          185.0,
                    "percent_change": 2.3,
                    "volume":         20_000_000,
                    "source":         "yf_most_actives",
                    "reasons":        ["Moderate move"],
                    "components":     {"momentum": 12.0, "volume": 14.0, "trend": 15.0, "rsi_macd": 14.0},
                },
            ],
            _TMP_DB,
        )
        update_discovery_run(run_id, "done", 2, db_path=_TMP_DB)

        # ── Hit the endpoint via TestClient ───────────────────────────────────
        with mock.patch.object(scheduler.scheduler, "start", lambda: None), \
             mock.patch.object(scheduler.scheduler, "stop", mock.AsyncMock()):
            with TestClient(app) as client:

                # Happy path ──────────────────────────────────────────────────
                resp = client.get(
                    f"/discovery/history/{run_id}/candidates",
                    headers={"Authorization": f"Bearer {os.environ.get('ADMIN_TOKEN', 'test')}"},
                )
                check(
                    "16L. /discovery/history/{run_id}/candidates returns 200",
                    resp.status_code == 200,
                    f"status={resp.status_code} body={resp.text[:200]}",
                )
                body = resp.json()
                check(
                    "16L. response contains run_id field",
                    body.get("run_id") == run_id,
                    str(body),
                )
                cands = body.get("candidates", [])
                check(
                    "16L. response contains expected number of candidates",
                    len(cands) == 2,
                    f"got {len(cands)} candidates",
                )

                # Ordering: sorted descending by score
                check(
                    "16L. candidates ordered descending by score",
                    cands[0]["score"] >= cands[1]["score"],
                    f"scores={[c['score'] for c in cands]}",
                )

                # JSON decode — reasons and components must be objects, not strings
                first = cands[0]
                check(
                    "16L. reasons decoded to list (not raw JSON string)",
                    isinstance(first.get("reasons"), list),
                    f"reasons type={type(first.get('reasons')).__name__}",
                )
                check(
                    "16L. components decoded to dict (not raw JSON string)",
                    isinstance(first.get("components"), dict),
                    f"components type={type(first.get('components')).__name__}",
                )
                check(
                    "16L. component keys present",
                    all(k in first["components"] for k in ("momentum", "volume", "trend", "rsi_macd")),
                    f"components keys={list(first.get('components', {}).keys())}",
                )

                # 404 path — unknown run_id ────────────────────────────────────
                resp_404 = client.get(
                    "/discovery/history/99999/candidates",
                    headers={"Authorization": f"Bearer {os.environ.get('ADMIN_TOKEN', 'test')}"},
                )
                check(
                    "16L. unknown run_id returns 404",
                    resp_404.status_code == 404,
                    f"status={resp_404.status_code}",
                )

        check("16L. discovery run candidates endpoint smoke complete", True)

    except Exception:
        import traceback

        check("16L. discovery run candidates endpoint smoke", False, traceback.format_exc()[-800:])
