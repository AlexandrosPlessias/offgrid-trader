"""Range reports + report comparator — scoped queries, diff maths, strictness, review."""

from __future__ import annotations

import json
from unittest import mock

from fastapi.testclient import TestClient

from backend import analysis, database
from backend.main import app
from backend.routes import reports as rep

_client = TestClient(app)


def _seed_window(prefix: str, n_signals: int, pnls: list[float]) -> None:
    """Insert signals and closed bracket orders dated inside ``prefix`` (YYYY-MM)."""
    with database._connect() as conn:
        # The smoke DB persists between runs — clear this test-owned month first.
        conn.execute("DELETE FROM signals WHERE created_at LIKE ?", (f"{prefix}-%",))
        conn.execute("DELETE FROM paper_orders WHERE created_at LIKE ?", (f"{prefix}-%",))
        for i in range(n_signals):
            ts = f"{prefix}-{(i % 28) + 1:02d}T10:00:00Z"
            conn.execute(
                "INSERT INTO signals (ticker, type, confidence, timestamp, created_at) "
                "VALUES (?, 'long', ?, ?, ?)",
                (f"S{i % 7}", 60 + (i % 30), ts, ts),
            )
        for i, pnl in enumerate(pnls):
            ts = f"{prefix}-{(i % 28) + 1:02d}T15:00:00Z"
            conn.execute(
                "INSERT INTO paper_orders "
                "(ticker, side, status, notional, realized_pnl, created_at) "
                "VALUES (?, 'buy', 'filled', 100, ?, ?)",
                (f"O{i % 5}", pnl, ts),
            )
        conn.commit()


def _fake_report_llm(prompt, system_prompt=None, **_kw):
    body = {
        "headline": "Range review",
        "notification": "All good.",
        "commentary": "Fine.",
        "patterns": [],
        "suggestions": [],
        "tuning": [],
    }
    return json.dumps(body), "fake-model", 11, 7


def test_scoped_queries_are_not_row_capped(check):
    _seed_window("2001-03", 620, [1.0] * 540)
    sigs = database.get_signals_between("2001-03-01", "2001-04-01")
    orders = database.get_paper_orders_between("2001-03-01", "2001-04-01")
    check("signals beyond the old 500 cap are returned", len(sigs) == 620, f"got {len(sigs)}")
    check("orders beyond the old 500 cap are returned", len(orders) == 540, f"got {len(orders)}")
    check(
        "window upper bound is exclusive",
        database.get_signals_between("2001-03-01", "2001-03-02") != sigs,
    )


def test_all_time_aggregates_match_row_economics(check):
    with database._connect() as conn:
        all_orders = [dict(r) for r in conn.execute("SELECT * FROM paper_orders").fetchall()]
        all_frac = [dict(r) for r in conn.execute("SELECT * FROM frac_positions").fetchall()]
    agg = database.get_order_economics_all_time()
    ref = rep._economics(all_orders)
    for k in ("closed_trades", "wins", "losses", "open_positions"):
        check(f"order aggregate {k} matches", agg[k] == ref[k], f"{agg[k]} != {ref[k]}")
    check("order aggregate P&L matches", abs(agg["total_pnl"] - ref["total_pnl"]) < 1e-6)
    fagg = database.get_frac_economics_all_time()
    fref = rep._frac_economics(all_frac)
    check("frac aggregate closed matches", fagg["closed_trades"] == fref["closed_trades"])


def test_bucket_granularity_boundaries(check):
    check("31 days → day", rep._bucket_granularity(31) == "day")
    check("32 days → week", rep._bucket_granularity(32) == "week")
    check("366 days → week", rep._bucket_granularity(366) == "week")
    check("367 days → month", rep._bucket_granularity(367) == "month")
    check(
        "week buckets start Monday", rep._bucket_key("2026-10-01T09:00:00Z", "week") == "2026-09-28"
    )
    check("month bucket", rep._bucket_key("2026-10-01T09:00:00Z", "month") == "2026-10")


def test_range_report_validation(check):
    bad = [
        ("period and dates together", "mode=frac&period=monthly&start=2001-01-01&end=2001-01-31"),
        ("neither period nor dates", "mode=frac"),
        ("start after end", "mode=frac&start=2001-02-01&end=2001-01-01"),
        ("future end", "mode=frac&start=2001-01-01&end=2999-01-01"),
        ("span beyond 3 years", "mode=frac&start=1990-01-01&end=2001-01-01"),
        ("unknown mode", "mode=crypto&period=monthly"),
    ]
    for label, qs in bad:
        r = _client.get(f"/reports/range?{qs}")
        check(f"range rejects {label}", r.status_code == 422, f"status {r.status_code}")


def test_custom_range_report_persists_window_and_tuning(check):
    with mock.patch.object(analysis, "call_llm", _fake_report_llm):
        r = _client.get("/reports/range?mode=orders&start=2001-03-01&end=2001-03-31")
    check("custom range report returns 200", r.status_code == 200, r.text[:200])
    body = r.json()
    rec = database.get_report_record(body["id"])
    ctx = json.loads(rec["context_json"])
    check("type follows {period}_{mode}", rec["type"] == "custom_orders")
    check(
        "window persisted",
        ctx["window"] == {"start": "2001-03-01", "end": "2001-03-31", "days": 31},
    )
    check("window economics count every order", ctx["window_economics"]["closed_trades"] == 540)
    check("tuning snapshot persisted", isinstance(ctx.get("tuning"), dict) and ctx["tuning"])
    check("orders tuning excludes frac knobs", "FRAC_BUDGET" not in ctx["tuning"])
    check("orders tuning includes bracket knobs", "PAPER_MAX_POSITIONS" in ctx["tuning"])
    check("31-day window buckets by day", ctx.get("bucket_granularity") == "day")
    check("on-demand report does not notify by default", body["channels"] == {})


def _ctx(
    *,
    start: str,
    end: str,
    days: int,
    closed: int,
    wins: int,
    losses: int,
    pnl: float,
    signals: int,
    tuning: dict | None,
    blocked: int = 0,
) -> str:
    ctx = {
        "mode": "orders",
        "period": "weekly",
        "window": {"start": start, "end": end, "days": days},
        "window_economics": {
            "closed_trades": closed,
            "wins": wins,
            "losses": losses,
            "open_positions": 1,
            "total_pnl": pnl,
            "win_pnl": 0.0,
            "loss_pnl": 0.0,
            "win_rate": wins / closed * 100 if closed else None,
            "notional_open": 100.0,
        },
        "signals_count": signals,
        "blocked_events": {"position_cap_hits": blocked, "insufficient_funds_hits": 0},
    }
    if tuning is not None:
        ctx["tuning"] = tuning
    return json.dumps(ctx)


def _save(report_type: str, report_date: str, context_json: str | None) -> int:
    return database.save_report_record(
        report_type=report_type,
        report_date=report_date,
        headline="h",
        notification_body="n",
        full_body="f",
        context_json=context_json,
    )


_TUNING = {"CONFIDENCE_FLOOR": "70", "PAPER_MAX_POSITIONS": "5"}


def test_compare_diff_maths_and_order(check):
    a = _save(
        "weekly_orders",
        "2002-01-08",
        _ctx(
            start="2002-01-01",
            end="2002-01-08",
            days=8,
            closed=0,
            wins=0,
            losses=6,
            pnl=-20.0,
            signals=20,
            tuning=_TUNING,
            blocked=4,
        ),
    )
    b = _save(
        "weekly_orders",
        "2002-01-15",
        _ctx(
            start="2002-01-08",
            end="2002-01-15",
            days=8,
            closed=10,
            wins=7,
            losses=3,
            pnl=30.0,
            signals=22,
            tuning={**_TUNING, "PAPER_MAX_POSITIONS": "8"},
            blocked=1,
        ),
    )
    r = _client.get(f"/reports/compare?a={b}&b={a}")  # passed newest-first on purpose
    check("compare returns 200", r.status_code == 200, r.text[:200])
    d = r.json()
    rows = {m["key"]: m for m in d["metrics"]}
    check("A is always the earlier report", d["a"]["id"] == a and d["b"]["id"] == b)
    check("delta is B - A", rows["total_pnl"]["delta"] == 50.0)
    check("pct delta uses |A|", rows["total_pnl"]["pct_delta"] == 250.0)
    check("pct delta is null when A is zero", rows["closed_trades"]["pct_delta"] is None)
    check("losses: lower is better", rows["losses"]["higher_is_better"] is False)
    check(
        "blocked counters: lower is better",
        rows["blocked.position_cap_hits"]["higher_is_better"] is False,
    )
    check("signals are directionless", rows["signals_count"]["higher_is_better"] is None)
    check("win rate null side gives null delta", rows["win_rate"]["delta"] is None)
    check("metrics use window economics", d["metrics_basis"] == "window")
    check(
        "only changed config keys",
        d["config"] == [{"key": "PAPER_MAX_POSITIONS", "a": "5", "b": "8"}],
    )
    check("A with zero closed trades is only partially comparable", d["comparability"] == "partial")


def test_compare_rejections(check):
    a = _save(
        "weekly_orders",
        "2003-01-08",
        _ctx(
            start="2003-01-01",
            end="2003-01-08",
            days=8,
            closed=6,
            wins=3,
            losses=3,
            pnl=1,
            signals=5,
            tuning=_TUNING,
        ),
    )
    f = _save(
        "weekly_frac",
        "2003-01-15",
        _ctx(
            start="2003-01-08",
            end="2003-01-15",
            days=8,
            closed=6,
            wins=3,
            losses=3,
            pnl=1,
            signals=5,
            tuning=_TUNING,
        ),
    )
    legacy = _save("weekly_orders", "2003-01-22", None)
    check("type mismatch → 409", _client.get(f"/reports/compare?a={a}&b={f}").status_code == 409)
    check("unknown id → 404", _client.get(f"/reports/compare?a={a}&b=999999").status_code == 404)
    check(
        "no structured data → 422",
        _client.get(f"/reports/compare?a={a}&b={legacy}").status_code == 422,
    )
    check(
        "same report twice → 422", _client.get(f"/reports/compare?a={a}&b={a}").status_code == 422
    )


def _pair(**overrides) -> tuple[dict, dict]:
    base = dict(closed=8, wins=5, losses=3, pnl=10.0, signals=20, tuning=_TUNING)
    ra = {
        "id": 1,
        "type": "weekly_orders",
        "report_date": "2004-01-08",
        "context_json": _ctx(start="2004-01-01", end="2004-01-07", days=7, **base),
    }
    b_args = {**base, **overrides}
    b_window = b_args.pop("window", ("2004-01-08", "2004-01-14", 7))
    rb = {
        "id": 2,
        "type": "weekly_orders",
        "report_date": b_window[1],
        "context_json": _ctx(start=b_window[0], end=b_window[1], days=b_window[2], **b_args),
    }
    return ra, rb


def test_comparability_grades(check):
    grade, _ = rep._report_comparability(*_pair())
    check("consecutive, equal, well-sampled → full", grade == "full")
    grade, _ = rep._report_comparability(*_pair(closed=2))
    check("small sample → partial", grade == "partial")
    grade, _ = rep._report_comparability(*_pair(tuning=None))
    check("missing tuning snapshot → partial", grade == "partial")
    grade, _ = rep._report_comparability(*_pair(window=("2004-01-08", "2004-03-08", 60)))
    check("very different window lengths → none", grade == "none")
    grade, _ = rep._report_comparability(*_pair(window=("2004-02-01", "2004-02-07", 7)))
    check("non-consecutive periods → partial", grade == "partial")
    grade, reasons = rep._report_comparability(*_pair(window=("2004-01-07", "2004-01-13", 7)))
    check("a single shared day → partial", grade == "partial", str(reasons))
    grade, _ = rep._report_comparability(*_pair(signals=3))
    check("sharp signal-volume gap → partial", grade == "partial")


def _fake_review_llm(prompt, system_prompt=None, **_kw):
    body = {
        "verdict": "improved",
        "verdict_confidence": "medium",
        "summary": "B is better.",
        "good": [{"point": "P&L up", "evidence": "A=-20 → B=30", "confidence": "medium"}],
        "bad": [],
        "improve": [
            {
                "setting": "PAPER_MAX_POSITIONS",
                "current_value": "8",
                "proposed_value": "10",
                "rationale": "r",
                "expected_effect": "e",
                "confidence": "low",
            },
            {
                "setting": "FRAC_BUDGET",
                "current_value": "100",
                "proposed_value": "150",
                "rationale": "r",
                "expected_effect": "e",
                "confidence": "low",
            },
        ],
    }
    return json.dumps(body), "fake-model", 120, 40


def test_review_scopes_suggestions_and_tracks_tokens(check):
    a = _save(
        "weekly_orders",
        "2005-01-07",
        _ctx(
            start="2005-01-01",
            end="2005-01-07",
            days=7,
            closed=8,
            wins=4,
            losses=4,
            pnl=-5,
            signals=20,
            tuning=_TUNING,
        ),
    )
    b = _save(
        "weekly_orders",
        "2005-01-14",
        _ctx(
            start="2005-01-08",
            end="2005-01-14",
            days=7,
            closed=9,
            wins=6,
            losses=3,
            pnl=12,
            signals=21,
            tuning=_TUNING,
        ),
    )
    with mock.patch.object(analysis, "call_llm", _fake_review_llm):
        r = _client.post("/reports/compare/review", json={"a": a, "b": b})
    check("review returns 200", r.status_code == 200, r.text[:200])
    body = r.json()
    settings = [i["setting"] for i in body.get("improve", [])]
    check("in-scope suggestion kept", "PAPER_MAX_POSITIONS" in settings)
    check("out-of-scope frac suggestion dropped", "FRAC_BUDGET" not in settings)
    check("comparability echoed", body.get("comparability") == "full")
    check("model reported", body.get("model_used") == "fake-model")
    with database._connect() as conn:
        n = conn.execute(
            "SELECT COUNT(*) FROM report_compares WHERE report_a_id = ? AND report_b_id = ?", (a, b)
        ).fetchone()[0]
    check("review persisted", n == 1)
    sources = {s["source"] for s in database.get_usage_stats(days=36500)["by_source"]}
    check("tokens tracked under report_compare", "report_compare" in sources)


def test_review_forces_inconclusive_when_not_comparable(check):
    a = _save(
        "weekly_orders",
        "2006-01-08",
        _ctx(
            start="2006-01-01",
            end="2006-01-08",
            days=8,
            closed=8,
            wins=4,
            losses=4,
            pnl=-5,
            signals=20,
            tuning=_TUNING,
        ),
    )
    b = _save(
        "weekly_orders",
        "2006-03-30",
        _ctx(
            start="2006-01-01",
            end="2006-03-30",
            days=89,
            closed=9,
            wins=6,
            losses=3,
            pnl=12,
            signals=21,
            tuning=_TUNING,
        ),
    )
    with mock.patch.object(analysis, "call_llm", _fake_review_llm):
        body = _client.post("/reports/compare/review", json={"a": a, "b": b}).json()
    check("grade none forces inconclusive verdict", body.get("verdict") == "inconclusive")


def test_weekly_report_persists_frac_scoped_snapshot(check):
    from backend import alerts

    with mock.patch.object(analysis, "call_llm", _fake_report_llm), mock.patch.object(
        alerts, "send_report", lambda *a, **k: {"ntfy": True}
    ):
        r = _client.get("/reports/weekly/frac")
    check("weekly frac report returns 200", r.status_code == 200, r.text[:200])
    ctx = json.loads(database.get_report_record(r.json()["id"])["context_json"])
    check("frac tuning includes frac knobs", "FRAC_BUDGET" in ctx["tuning"])
    check("frac tuning excludes bracket knobs", "PAPER_MAX_POSITIONS" not in ctx["tuning"])
    check("weekly window is exactly 7 calendar days", ctx["window"]["days"] == 7)
    check("weekly buckets by day", ctx.get("bucket_granularity") == "day")
    check("scheduled report still notifies", r.json()["channels"] == {"ntfy": True})


def test_frac_position_counts_once_across_consecutive_windows(check):
    with database._connect() as conn:
        conn.execute("DELETE FROM frac_positions WHERE ticker = 'XDBL'")
        conn.execute(
            "INSERT INTO frac_positions "
            "(ticker, notional, status, realized_pnl, opened_at, closed_at) "
            "VALUES ('XDBL', 10, 'closed', 2.5, '2007-01-06T10:00:00Z', '2007-01-09T10:00:00Z')"
        )
        conn.commit()
    ids = []
    with mock.patch.object(analysis, "call_llm", _fake_report_llm):
        for start, end in (("2007-01-01", "2007-01-07"), ("2007-01-08", "2007-01-14")):
            r = _client.get(f"/reports/range?mode=frac&start={start}&end={end}")
            ids.append(r.json()["id"])
    ctx_a, ctx_b = (json.loads(database.get_report_record(i)["context_json"]) for i in ids)
    check(
        "not counted in the window it merely opened in",
        ctx_a["window_economics"]["closed_trades"] == 0,
    )
    check("counted in the window it closed in", ctx_b["window_economics"]["closed_trades"] == 1)


def test_paper_pnl_counts_in_the_window_it_closed(check):
    with database._connect() as conn:
        conn.execute("DELETE FROM paper_orders WHERE ticker IN ('XCLS', 'XLEG')")
        # Opened in window A, closed in window B.
        conn.execute(
            "INSERT INTO paper_orders "
            "(ticker, side, status, notional, realized_pnl, created_at, closed_at) "
            "VALUES ('XCLS', 'buy', 'filled', 100, 7.5, "
            "'2008-01-04T15:00:00Z', '2008-01-09T15:00:00Z')"
        )
        # Legacy row with no closed_at — stays in the window it was created in.
        conn.execute(
            "INSERT INTO paper_orders (ticker, side, status, notional, realized_pnl, created_at) "
            "VALUES ('XLEG', 'buy', 'filled', 100, 1.0, '2008-01-03T15:00:00Z')"
        )
        conn.commit()
    closed = []
    with mock.patch.object(analysis, "call_llm", _fake_report_llm):
        for start, end in (("2008-01-01", "2008-01-07"), ("2008-01-08", "2008-01-14")):
            r = _client.get(f"/reports/range?mode=orders&start={start}&end={end}")
            ctx = json.loads(database.get_report_record(r.json()["id"])["context_json"])
            closed.append(ctx["window_economics"]["closed_trades"])
    check("each trade counted once, in the window it closed in", closed == [1, 1], str(closed))


def test_realizing_pnl_stamps_closed_at(check):
    with database._connect() as conn:
        conn.execute("DELETE FROM paper_orders WHERE alpaca_order_id = 'stamp-1'")
        conn.commit()
    database.save_paper_order(
        {"ticker": "XSTAMP", "side": "buy", "alpaca_order_id": "stamp-1", "notional": 100}
    )
    database.update_paper_order_status("stamp-1", {"status": "filled", "realized_pnl": 2.0})
    with database._connect() as conn:
        closed_at = conn.execute(
            "SELECT closed_at FROM paper_orders WHERE alpaca_order_id = 'stamp-1'"
        ).fetchone()[0]
    check("writing realized_pnl records when the trade closed", bool(closed_at), str(closed_at))


def test_eod_window_is_today_only(check):
    from backend import alerts

    with mock.patch.object(analysis, "call_llm", _fake_report_llm), mock.patch.object(
        alerts, "send_report", lambda *a, **k: {}
    ):
        r = _client.get("/reports/eod/orders")
    ctx = json.loads(database.get_report_record(r.json()["id"])["context_json"])
    check("EoD covers exactly one calendar day", ctx["window"]["days"] == 1, str(ctx["window"]))


def test_overlay_hidden_when_bucket_sizes_differ(check):
    ra, rb = _pair()
    ca, cb = json.loads(ra["context_json"]), json.loads(rb["context_json"])
    ca["bucket_granularity"], cb["bucket_granularity"] = "day", "week"
    ra["context_json"], rb["context_json"] = json.dumps(ca), json.dumps(cb)
    check(
        "mismatched granularity → no overlay",
        rep._compare_reports(ra, rb)["buckets"]["granularity"] is None,
    )
    cb["bucket_granularity"] = "day"
    rb["context_json"] = json.dumps(cb)
    check(
        "matching granularity kept", rep._compare_reports(ra, rb)["buckets"]["granularity"] == "day"
    )


def _review_pair(year: int, tuning_b: dict | None = _TUNING) -> tuple[int, int]:
    common = dict(closed=8, wins=4, losses=4, pnl=-5, signals=20)
    a = _save(
        "weekly_orders",
        f"{year}-01-07",
        _ctx(start=f"{year}-01-01", end=f"{year}-01-07", days=7, tuning=_TUNING, **common),
    )
    b = _save(
        "weekly_orders",
        f"{year}-01-14",
        _ctx(start=f"{year}-01-08", end=f"{year}-01-14", days=7, tuning=tuning_b, **common),
    )
    return a, b


def _llm_returning(body: dict):
    return lambda prompt, system_prompt=None, **_kw: (json.dumps(body), "fake-model", 10, 5)


_REVIEW_BASE = {
    "verdict": "mixed",
    "verdict_confidence": "low",
    "summary": "s",
    "good": [],
    "bad": [],
}


def _improve(setting: str, value: str) -> dict:
    return {
        "setting": setting,
        "current_value": "1",
        "proposed_value": value,
        "rationale": "r",
        "expected_effect": "e",
        "confidence": "low",
    }


def test_review_drops_unsaveable_and_unsnapshotted_suggestions(check):
    a, b = _review_pair(2009)
    body = {
        **_REVIEW_BASE,
        "improve": [_improve("PAPER_MAX_POSITIONS", "999"), _improve("CONFIDENCE_FLOOR", "80%")],
    }
    with mock.patch.object(analysis, "call_llm", _llm_returning(body)):
        kept = _client.post("/reports/compare/review", json={"a": a, "b": b}).json()["improve"]
    settings = [i["setting"] for i in kept]
    check("out-of-range numeric value dropped", "PAPER_MAX_POSITIONS" not in settings)
    check("valid value with a % sign kept", "CONFIDENCE_FLOOR" in settings, str(settings))

    a, b = _review_pair(2010, tuning_b=None)
    body = {**_REVIEW_BASE, "improve": [_improve("CONFIDENCE_FLOOR", "80")]}
    with mock.patch.object(analysis, "call_llm", _llm_returning(body)):
        kept = _client.post("/reports/compare/review", json={"a": a, "b": b}).json()["improve"]
    check("no tuning snapshot on B → no suggestions", kept == [], str(kept))


def test_review_falls_back_when_repair_stays_invalid(check):
    a, b = _review_pair(2011)
    broken = {**_REVIEW_BASE, "good": "not a list", "improve": []}
    with mock.patch.object(analysis, "call_llm", _llm_returning(broken)):
        body = _client.post("/reports/compare/review", json={"a": a, "b": b}).json()
    check("still-invalid output falls back to inconclusive", body.get("verdict") == "inconclusive")
    check("fallback lists are lists", body.get("good") == [] and body.get("improve") == [])


def test_review_hides_llm_error_details(check):
    a, b = _review_pair(2012)

    def _boom(*_a, **_kw):
        raise analysis.LLMError("upstream 500 from https://internal.example/secret-path")

    with mock.patch.object(analysis, "call_llm", _boom):
        r = _client.post("/reports/compare/review", json={"a": a, "b": b})
    check("LLM failure → 503", r.status_code == 503, str(r.status_code))
    check("provider detail not exposed", "secret-path" not in r.text, r.text)
