"""Trending-page Explorer confidence: lookup, once-per-run scans, analysis-only pipeline."""

from __future__ import annotations

import asyncio
from unittest import mock

from fastapi.testclient import TestClient

from backend import database
from backend.main import app
from backend.routes import discovery as disc

_client = TestClient(app)
_TICKERS = ("ZCHI", "ZCLO", "ZCNEW")


def _seed_run() -> int:
    with database._connect() as conn:
        marks = ",".join("?" * len(_TICKERS))
        conn.execute(f"DELETE FROM analysis_log WHERE ticker IN ({marks})", _TICKERS)  # noqa: S608
        conn.commit()
    run_id = database.save_discovery_run("alpaca")
    database.save_discovery_candidates(
        run_id,
        [
            {"ticker": "ZCHI", "score": 90, "reasons": [], "components": {}},  # analysed already
            {"ticker": "ZCNEW", "score": 85, "reasons": [], "components": {}},  # needs a scan
            {"ticker": "ZCLO", "score": 10, "reasons": [], "components": {}},  # below min score
        ],
    )
    database.update_discovery_run(run_id, "done", 3)
    database.save_analysis(
        "ZCHI",
        {"trend": "bullish"},
        {"price": 10},
        opportunities=[
            {"type": "short", "confidence": 61},
            {"type": "long", "confidence": 74},
        ],
    )
    return run_id


def test_confidence_lookup_reports_best_setup(check):
    run_id = _seed_run()
    body = _client.get(f"/discovery/runs/{run_id}/confidence").json()["confidence"]
    check("analysed ticker is done", body["ZCHI"]["status"] == "done", str(body))
    check("best setup wins", body["ZCHI"]["confidence"] == 74 and body["ZCHI"]["type"] == "long")
    check("unanalysed ticker is none", body["ZCNEW"]["status"] == "none")


def test_scan_skips_when_market_closed(check):
    run_id = _seed_run()
    with mock.patch("backend.scheduler.is_market_open", return_value=False):
        body = _client.post(f"/discovery/runs/{run_id}/confidence-scan").json()
    check("market closed → nothing started", body == {"started": [], "skipped": "market_closed"})


def test_scan_runs_once_per_run_for_qualifying_tickers(check):
    run_id = _seed_run()
    calls: list[list[str]] = []

    async def _fake_scans(rid, tickers):
        calls.append(list(tickers))

    with (
        mock.patch("backend.scheduler.is_market_open", return_value=True),
        mock.patch.object(disc, "_run_confidence_scans", _fake_scans),
    ):
        first = _client.post(f"/discovery/runs/{run_id}/confidence-scan").json()
        second = _client.post(f"/discovery/runs/{run_id}/confidence-scan").json()
    check("only the unanalysed, above-threshold ticker is scanned", first["started"] == ["ZCNEW"])
    check("a second request for the same run starts nothing", second["started"] == [])
    status = _client.get(f"/discovery/runs/{run_id}/confidence").json()["confidence"]
    check("scan in flight is reported", status["ZCNEW"]["status"] == "scanning", str(status))


def test_confidence_scan_pipeline_cannot_trade(check):
    seen: list[list[str]] = []

    class _FakeAgent:
        def __init__(self, ticker, *, memory, skill_classes, send_alerts):
            seen.append([s.__name__ for s in skill_classes])
            self.send_alerts = send_alerts

        async def run(self):
            return mock.Mock(context=mock.Mock(analysis={"trend": "x"}))

    disc._confscan.update(run_id=-1, pending={"ZCNEW"}, failed=set())
    with mock.patch("backend.agent.TickerAgent", _FakeAgent):
        asyncio.run(disc._run_confidence_scans(-1, ["ZCNEW"]))
    skills = seen[0] if seen else []
    forbidden = {"PersistSkill", "PaperTradeSkill", "FracTradeSkill", "AlertSkill"}
    check("pipeline ran", bool(skills), str(skills))
    check("no signal, trade or alert skills", not forbidden & set(skills), str(skills))
    check("analysis is still saved", "SaveAnalysisSkill" in skills)
    check("pending cleared when done", "ZCNEW" not in disc._confscan["pending"])
