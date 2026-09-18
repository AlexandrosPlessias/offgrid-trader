"""Autonomous trading — tradability gate drop/keep matrix + position-cap counter."""

from __future__ import annotations

import backend.skills.tradability_gate as gate_mod
from backend.skills import AgentContext


class _FakeClient:
    """Stand-in Alpaca client returning canned /v2/assets responses."""

    def __init__(self, assets: dict[str, dict]):
        self._assets = assets

    def _get(self, path: str):
        # path is "/v2/assets/{TICKER}"
        ticker = path.rsplit("/", 1)[-1]
        if ticker not in self._assets:
            from backend.alpaca import AlpacaError

            raise AlpacaError(f"GET {path} → 404: not found")
        return self._assets[ticker]


def _asset(tradable=True, shortable=True, fractionable=True):
    return {"tradable": tradable, "shortable": shortable, "fractionable": fractionable}


def _run_gate(monkeypatch, opps, assets, drop_mode="untradable"):
    from backend import database

    monkeypatch.setattr(gate_mod, "get_client", lambda: _FakeClient(assets))
    monkeypatch.setattr(
        database,
        "get_setting",
        lambda k, d="", *a, **kw: drop_mode if k == "signal_drop_mode" else d,
    )
    monkeypatch.setattr(
        gate_mod,
        "get_setting",
        lambda k, d="", *a, **kw: drop_mode if k == "signal_drop_mode" else d,
    )
    ctx = AgentContext(ticker=opps[0]["ticker"] if opps else "TEST")
    ctx.actionable = [dict(o) for o in opps]
    gate_mod.TradabilityGateSkill().run(ctx)
    return ctx.actionable


def test_tradability_gate(check, monkeypatch):
    long_ok = {"ticker": "AAA", "type": "long", "confidence": 80.0}
    long_nofrac = {"ticker": "BBB", "type": "long", "confidence": 80.0}
    short_noshort = {"ticker": "CCC", "type": "short", "confidence": 80.0}
    nontradable = {"ticker": "DDD", "type": "long", "confidence": 80.0}
    unknown = {"ticker": "EEE", "type": "long", "confidence": 80.0}

    assets = {
        "AAA": _asset(tradable=True, shortable=True, fractionable=True),
        "BBB": _asset(tradable=True, shortable=True, fractionable=False),
        "CCC": _asset(tradable=True, shortable=False, fractionable=True),
        "DDD": _asset(tradable=False, shortable=False, fractionable=False),
        # EEE intentionally absent → unknown/permissive
    }
    kept = _run_gate(
        monkeypatch,
        [long_ok, long_nofrac, short_noshort, nontradable, unknown],
        assets,
    )
    kept_by = {o["ticker"]: o for o in kept}

    check(
        "long+fractionable kept with both flags",
        "AAA" in kept_by and kept_by["AAA"]["can_bracket"] and kept_by["AAA"]["can_frac"],
    )
    check(
        "long non-fractionable kept, can_frac False",
        "BBB" in kept_by and kept_by["BBB"]["can_bracket"] and not kept_by["BBB"]["can_frac"],
    )
    check("short non-shortable dropped", "CCC" not in kept_by)
    check("non-tradable dropped", "DDD" not in kept_by)
    check(
        "unknown ticker kept permissively",
        "EEE" in kept_by and kept_by["EEE"]["can_bracket"] is True,
    )


def test_tradability_gate_never_mode(check, monkeypatch):
    short_noshort = {"ticker": "CCC", "type": "short", "confidence": 80.0}
    nontradable = {"ticker": "DDD", "type": "long", "confidence": 80.0}
    assets = {
        "CCC": _asset(tradable=True, shortable=False, fractionable=True),
        "DDD": _asset(tradable=False, shortable=False, fractionable=False),
    }
    kept = _run_gate(monkeypatch, [short_noshort, nontradable], assets, drop_mode="never")
    tickers = {o["ticker"] for o in kept}
    check("never mode keeps everything (annotate only)", tickers == {"CCC", "DDD"})
    kept_by = {o["ticker"]: o for o in kept}
    check(
        "never mode still annotates can_bracket False on non-tradable",
        kept_by["DDD"]["can_bracket"] is False,
    )


def test_autotrade_db_helpers(check):
    from backend import database

    # Floor resolver: config default when no DB override set.
    database.set_setting("confidence_floor", "")
    check("floor falls back to config default", database.get_confidence_floor() >= 0)
    database.set_setting("confidence_floor", "82")
    check("floor honours DB override", database.get_confidence_floor() == 82.0)
    database.set_setting("confidence_floor", "")  # reset

    # Position counter returns an int and never raises on an empty/seeded table.
    count = database.count_open_paper_positions()
    check("count_open_paper_positions returns int >= 0", isinstance(count, int) and count >= 0)

    # Watchlist add dedups and returns only newly-added tickers.
    newly = database.add_watchlist_tickers(["ZZTOP", "ZZTOP"])
    check("add_watchlist_tickers dedups within a call", newly.count("ZZTOP") <= 1)
    again = database.add_watchlist_tickers(["ZZTOP"])
    check("add_watchlist_tickers skips already-present", again == [])
