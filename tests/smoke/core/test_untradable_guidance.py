"""Untradable-signal guidance — distinct-ticker counts, allowed tuning values, auto-add."""

from __future__ import annotations

import json
from unittest import mock

from backend import database, scheduler
from backend.routes import reports as rep


def _insert_event(ts: str, level: str, message: str, meta: dict | None = None) -> None:
    with database._connect() as conn:
        conn.execute(
            "INSERT INTO events (ts, category, level, message, meta) VALUES (?, 'scan', ?, ?, ?)",
            (ts, level, message, json.dumps(meta) if meta else None),
        )
        conn.commit()


def test_untradable_counts_drops_and_distinct_tickers(check):
    # The smoke DB persists between runs — clear this test's window first.
    with database._connect() as conn:
        conn.execute("DELETE FROM events WHERE ts >= '2002-05-01' AND ts < '2002-07-01'")
        conn.commit()
    for i, ticker in enumerate(["TGE", "TGE", "TGE", "SDEV", "SDEV"]):
        _insert_event(
            f"2002-05-0{i + 1}T14:00:00Z",
            "warning",
            f"Dropped {ticker} short signal — no shortable/fractionable path",
            {"ticker": ticker, "type": "short"},
        )
    _insert_event("2002-05-02T14:00:00Z", "warn", "LLM parse error for TGE: bad json")
    _insert_event("2002-05-03T14:00:00Z", "warning", "Some other scan warning")

    counts = database.get_blocked_event_counts("2002-05-01", "2002-06-01")
    check("every drop is counted", counts["untradable_dropped"] == 5, str(counts))
    check("re-detections collapse to distinct tickers", counts["untradable_tickers"] == 2)
    check(
        "window bounds are respected",
        database.get_blocked_event_counts("2002-06-01", "2002-07-01")["untradable_tickers"] == 0,
    )


def test_tuning_prompt_lists_allowed_values(check):
    text = rep._render_tuning({"SIGNAL_DROP_MODE": "untradable", "CUSTOM_KNOB": "1"})
    check("drop mode lists its three values", "untradable | strict | never" in text, text)
    check("unknown knobs render plain", "CUSTOM_KNOB=1" in text and "CUSTOM_KNOB=1  (" not in text)


def test_review_rejects_impossible_drop_mode(check):
    allowed = {"SIGNAL_DROP_MODE", "FRAC_BUDGET"}
    bad = {"improve": [{"setting": "SIGNAL_DROP_MODE", "proposed_value": "none"}]}
    good = {"improve": [{"setting": "SIGNAL_DROP_MODE", "proposed_value": "Never"}]}
    check("'none' is a violation", len(rep._scope_violations(bad, allowed)) == 1)
    check("a real mode passes (case-insensitive)", rep._scope_violations(good, allowed) == [])
    check(
        "an in-range numeric value is accepted",
        rep._tuning_value_error({"setting": "FRAC_BUDGET", "proposed_value": "250"}) is None,
    )
    check(
        "an out-of-range numeric value is rejected",
        rep._tuning_value_error({"setting": "RSI_OVERSOLD", "proposed_value": "200"}) is not None,
    )


def test_autoadd_respects_manual_removal(check):
    saved = {k: database.get_setting(k, "") for k in ("watchlist_added", "watchlist_removed")}
    try:
        database.set_setting("watchlist_added", "[]")
        database.set_setting("watchlist_removed", json.dumps(["ZZRM"]))
        client = mock.Mock()
        client._get.return_value = {"tradable": True, "status": "active", "fractionable": True}
        with mock.patch("backend.alpaca.get_client", return_value=client):
            scheduler._autoadd_tradable_candidates([{"ticker": "ZZRM"}, {"ticker": "ZZOK"}])
        added = json.loads(database.get_setting("watchlist_added", "[]"))
        removed = json.loads(database.get_setting("watchlist_removed", "[]"))
        check("a manually removed ticker is not re-added", "ZZRM" not in added, str(added))
        check("it stays in the removed list", "ZZRM" in removed)
        check("other tradable candidates are still added", "ZZOK" in added)
    finally:
        for key, value in saved.items():
            database.set_setting(key, value or "[]")
