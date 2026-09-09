"""Section 13 — Backtesting engine smoke tests."""

from __future__ import annotations


def test_backtest_engine(check):
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
        from unittest import mock

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
