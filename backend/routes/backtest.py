"""Backtest routes: /backtest*."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import get_setting
from backend.routes._models import _clean_ticker, _log_safe, _sse_frame

router = APIRouter()
_log = logging.getLogger(__name__)

_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "prompts")


def _load_prompt(filename: str) -> str:
    """Load a prompt template from ``backend/prompts/``."""
    path = os.path.normpath(os.path.join(_PROMPTS_DIR, filename))
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


def _compute_comparability(runs: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Compute a comparability grade for a set of backtest runs.

    Returns ``(grade, reasons)`` where grade is ``"full"``, ``"partial"``, or ``"none"``.
    """
    reasons: list[str] = []
    r0 = runs[0]
    same_tickers = all(
        sorted(r.get("tickers") or []) == sorted(r0.get("tickers") or []) for r in runs
    )
    same_window = all(
        r.get("start_date") == r0.get("start_date") and r.get("end_date") == r0.get("end_date")
        for r in runs
    )
    same_params = all(
        r.get("atr_multiple") == r0.get("atr_multiple")
        and r.get("reward_risk") == r0.get("reward_risk")
        for r in runs
    )
    modes = {r.get("signal_mode") for r in runs}
    if same_tickers and same_window and same_params:
        if len(modes) > 1:
            reasons.append("Same universe, window, and execution params; signal_mode is controlled")
        else:
            reasons.append("All run parameters are identical")
        return "full", reasons
    if same_tickers:
        if not same_window:
            reasons.append("Date windows differ between runs")
        if not same_params:
            reasons.append("ATR multiple or reward_risk differ between runs")
        return "partial", reasons
    reasons.append("Different ticker universes — runs are not directly comparable")
    return "none", reasons


class BacktestRequest(BaseModel):
    tickers: list[str] = Field(..., min_length=1, description="Ticker symbols to replay")
    start_date: str = Field(..., description="Replay window start (YYYY-MM-DD)")
    end_date: str = Field(..., description="Replay window end (YYYY-MM-DD)")
    initial_balance: float = Field(10_000.0, gt=0, description="Virtual wallet starting balance")
    confidence_floor: float | None = Field(
        None,
        ge=0,
        le=100,
        description="Confidence floor override (default: system setting)",
    )
    max_hold_days: int = Field(10, ge=1, le=120, description="Days before timing out a trade")
    use_llm: bool = Field(False, description="Run LLM analysis on each replay day (slower)")
    atr_multiple: float = Field(1.5, gt=0, description="ATR multiple for stop distance")
    reward_risk: float = Field(2.0, gt=0, description="Reward-to-risk ratio for target")
    requests_per_minute: int | None = Field(
        None, ge=1, description="LLM RPM cap (None = no throttle)"
    )
    scan_interval_minutes: int = Field(
        1440,
        ge=5,
        le=1440,
        description=(
            "How often to check for signals within each trading day. "
            "1440 = once at end-of-day (default). "
            "Common values: 15, 30, 60, 120, 240, 480."
        ),
    )
    is_out_of_sample: bool = Field(
        False,
        description="Mark this window as a held-out test set (OOS). Used by AI Review evidence.",
    )
    max_concurrent_tickers: int | None = Field(
        None,
        ge=1,
        le=20,
        description="Max tickers processed in parallel (None = use system default)",
    )
    max_concurrent_llm: int | None = Field(
        None,
        ge=1,
        le=10,
        description="Max simultaneous LLM calls (None = use system default)",
    )
    position_size_pct: float = Field(
        0.10,
        ge=0.01,
        le=0.50,
        description=(
            "Virtual wallet: fraction of initial_balance invested per signal "
            "(0.01 = 1%, 0.10 = 10%, 0.50 = 50%). Stored in metrics_json."
        ),
    )
    cashout_r: float | None = Field(
        None,
        ge=0.1,
        le=10.0,
        description=(
            "Early profit-taking: close a trade as soon as its unrealised R "
            "reaches this level, before the original target. None = disabled."
        ),
    )


class BacktestCompareRequest(BaseModel):
    run_ids: list[int] = Field(
        ..., min_length=2, max_length=5, description="2-5 run IDs to compare"
    )


@router.post("/backtest/stream")
async def backtest_stream(request: BacktestRequest) -> StreamingResponse:
    """Run a backtest and stream progress + result as SSE events.

    Event types emitted:
    * ``{"type":"progress", "ticker":..., "day":..., "pct":...}``
    * ``{"type":"fallback", "from":..., "to":..., "reason":...}`` (LLM mode)
    * ``{"type":"quota_stop", "ticker":..., "day":..., "msg":...}`` (LLM quota)
    * ``{"type":"result", "run_id":..., "report":...}``
    * ``{"type":"error", "msg":...}``
    """
    from backend.backtest import BacktestParams, run_backtest
    from backend.config import get_settings as _cfg

    # Validate and sanitise each ticker.
    clean_tickers = [_clean_ticker(t) for t in request.tickers]

    # Resolve confidence floor (request overrides system setting).
    floor = (
        request.confidence_floor
        if request.confidence_floor is not None
        else _cfg().thresholds.confidence_floor
    )

    params = BacktestParams(
        tickers=clean_tickers,
        start_date=request.start_date,
        end_date=request.end_date,
        initial_balance=request.initial_balance,
        confidence_floor=floor,
        max_hold_days=request.max_hold_days,
        use_llm=request.use_llm,
        atr_multiple=request.atr_multiple,
        reward_risk=request.reward_risk,
        requests_per_minute=request.requests_per_minute,
        scan_interval_minutes=request.scan_interval_minutes,
        is_out_of_sample=request.is_out_of_sample,
        position_size_pct=request.position_size_pct,
        cashout_r=request.cashout_r,
        max_concurrent_tickers=(
            request.max_concurrent_tickers
            or int(get_setting("concurrent_tickers") or 0)
            or _cfg().concurrent_tickers
        ),
        max_concurrent_llm=(
            request.max_concurrent_llm
            or int(get_setting("concurrent_llm") or 0)
            or _cfg().concurrent_llm
        ),
    )

    event_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def _emit(evt: dict[str, Any]) -> None:
        event_queue.put_nowait(evt)

    async def _stream():
        async def _run():
            try:
                report = await asyncio.to_thread(run_backtest, params, emit=_emit)
                event_queue.put_nowait(
                    {
                        "type": "result",
                        "run_id": report["run_id"],
                        "report": report,
                    }
                )
            except Exception as exc:
                event_queue.put_nowait({"type": "error", "msg": "Backtest failed; check logs."})
                _log.exception("backtest_stream error: %s", _log_safe(str(exc)))
            finally:
                event_queue.put_nowait(None)  # sentinel

        task = asyncio.create_task(_run())
        try:
            while True:
                evt = await event_queue.get()
                if evt is None:
                    break
                yield _sse_frame(evt)
        finally:
            task.cancel()

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/backtest")
def list_backtest_runs() -> dict[str, Any]:
    """List all backtest runs, newest first."""
    from backend.database import get_backtest_runs

    return {"runs": get_backtest_runs()}


@router.post("/backtest/compare")
async def backtest_compare(
    request: BacktestCompareRequest,
) -> dict[str, Any]:
    """Ask the LLM to compare 2-5 backtest runs using the v2 comparability-gated methodology.

    Returns ``comparability``, ``summary``, ``winner_run_id``, ``winner_confidence``,
    ``llm_value_add``, per-run ``strengths``/``weaknesses``, and ``recommendation``.
    Persisted to ``backtest_compares`` for full historicity.
    """
    from backend.analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from backend.database import get_backtest_run, save_backtest_compare

    # Load every requested run; 404 on any missing.
    runs: list[dict[str, Any]] = []
    for rid in request.run_ids:
        r = get_backtest_run(rid)
        if r is None:
            raise HTTPException(status_code=404, detail=f"Backtest run {rid} not found.")
        runs.append(r)

    # Compute comparability grade before calling LLM.
    comparability, comp_reasons = _compute_comparability(runs)

    # Build matched mode pairs (rules vs LLM on same universe+window).
    rules_runs = [r for r in runs if r.get("signal_mode") == "rules"]
    llm_runs = [r for r in runs if r.get("signal_mode") == "llm"]
    matched_pairs = [
        {
            "rules_run_id": str(rr["id"]),
            "llm_or_hybrid_run_id": str(lr["id"]),
            "paired_delta_expectancy_r": round(
                (lr.get("metrics", {}).get("avg_r_multiple") or 0)
                - (rr.get("metrics", {}).get("avg_r_multiple") or 0),
                3,
            ),
        }
        for rr in rules_runs
        for lr in llm_runs
        if sorted(rr.get("tickers") or []) == sorted(lr.get("tickers") or [])
        and rr.get("start_date") == lr.get("start_date")
    ]

    # Build the v2 comparison payload.
    run_summaries = []
    for r in runs:
        m = r.get("metrics") or {}
        run_summaries.append(
            {
                "run_id": str(r["id"]),
                "mode": r.get("signal_mode", "rules"),
                "model_id": r.get("llm_model"),
                "is_out_of_sample": bool(r.get("is_out_of_sample")),
                "total_trades": m.get("total_trades", 0),
                "effective_trades": m.get("effective_trades", m.get("total_trades", 0)),
                "win_rate": m.get("win_rate"),
                "avg_r_multiple": m.get("avg_r_multiple"),
                "expectancy_ci95": m.get("expectancy_ci95"),
                "sharpe": m.get("sharpe"),
                "max_drawdown_r": m.get("max_drawdown"),
                "after_cost_avg_r": m.get("after_cost_avg_r"),
                "fee_stress_pass": m.get("fee_stress_pass"),
                "ticker_concentration": m.get("ticker_concentration"),
                "confidence_floor": r.get("confidence_floor"),
            }
        )

    comparison_payload = {
        "comparison_id": f"cmp_{'_'.join(str(i) for i in request.run_ids)}",
        "comparability": {
            "backend_grade": comparability,
            "matched_fields": [],
            "different_fields": [],
            "normalization_notes": comp_reasons,
        },
        "runs": run_summaries,
        "matched_mode_pairs": matched_pairs,
    }

    _subs = {"backtest_comparison_json": json.dumps(comparison_payload, default=str)}
    user_prompt = _load_prompt("backtest_compare_user.md")
    for _k, _v in _subs.items():
        user_prompt = user_prompt.replace(f"{{{_k}}}", _v)
    system_prompt = _load_prompt("backtest_compare_system.md")

    try:
        raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {exc}") from exc
    except Exception as exc:
        _log.exception("backtest_compare error: %s", _log_safe(str(exc)))
        raise HTTPException(status_code=503, detail=f"Compare failed: {exc}") from exc

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        result: dict[str, Any] = json.loads(cleaned)
    except Exception:
        result = {
            "summary": raw,
            "comparability": comparability,
            "winner_run_id": None,
            "winner_confidence": "none",
            "per_run": [],
            "recommendation": "",
        }

    # Schema validation + one-shot repair (pass system_prompt so repair uses the
    # compare instructions, not the default signal-scan prompt).
    errs = _validate_llm_json(result, "backtest_comparison.schema.json")
    if errs:
        _log.warning(
            "backtest_compare v2 schema errors: %s",
            str(errs).replace("\r", "").replace("\n", ""),
        )
        try:
            repaired = _repair_llm_json(raw, errs, call_llm, system_prompt)
            result = json.loads(repaired)
        except Exception:  # noqa: S110
            pass

    # Inject backend-computed comparability so frontend always has it.
    result.setdefault("comparability", comparability)
    result.setdefault("comparability_reasons", comp_reasons)
    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct

    try:
        save_backtest_compare(
            run_ids=request.run_ids,
            result_json=json.dumps(result, default=str),
            llm_provider=get_setting("llm_provider") or get_settings().llm.provider,
            llm_model=model_used,
            prompt_tokens=pt or 0,
            completion_tokens=ct or 0,
        )
    except Exception:  # noqa: S110
        pass  # non-fatal

    return result


@router.post("/backtest/{run_id}/experiment-advisor")
async def backtest_experiment_advisor(run_id: int) -> dict[str, Any]:
    """Experiment Selector v2: backend generates candidates; LLM selects one.

    Returns the ``selected_candidate`` (full dict with hypothesis, changes,
    success/failure criteria, overfitting_risk) plus ``reasoning``,
    ``model_used``, ``prompt_tokens``, ``completion_tokens``.
    Persisted to ``backtest_floor_suggests`` for full historicity.
    """
    from backend.analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from backend.backtest import generate_experiment_candidates
    from backend.database import get_backtest_run, save_backtest_floor_suggest

    run = get_backtest_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")

    metrics = run.get("metrics") or {}
    floor_sweep: list[dict] = metrics.get("floor_sweep") or []

    # Backend generates candidates; LLM only selects.
    # ATR and hold-day candidates are always available; floor candidates require floor_sweep.
    candidates = generate_experiment_candidates(run)
    if not candidates:
        raise HTTPException(
            status_code=422,
            detail=(
                "Could not generate experiment candidates. "
                "Run a backtest first — floor sweep candidates require at least one completed run."
            ),
        )

    current_floor = run.get("confidence_floor") or 65

    selection_payload = {
        "current_run": {
            "run_id": str(run_id),
            "is_out_of_sample": bool(run.get("is_out_of_sample")),
            "metrics": {
                "total_trades": metrics.get("total_trades", 0),
                "win_rate": metrics.get("win_rate"),
                "avg_r_multiple": metrics.get("avg_r_multiple"),
                "expectancy_ci95": metrics.get("expectancy_ci95"),
                "sharpe": metrics.get("sharpe"),
                "max_drawdown_r": metrics.get("max_drawdown"),
                "after_cost_avg_r": metrics.get("after_cost_avg_r"),
                "fee_stress_pass": metrics.get("fee_stress_pass"),
            },
            "diagnostics": {
                "performance_by_floor_train": floor_sweep,
                "performance_by_ticker": metrics.get("per_ticker") or [],
            },
        },
        "research_constraints": {
            "minimum_effective_trades": 10,
            "unchanged_fields": ["tickers", "start_date", "end_date"],
            "objective": "Improve after-cost expectancy (avg_r) while maintaining ≥10 trades",
        },
        "candidate_experiments": candidates,
    }

    _subs = {"experiment_selection_json": json.dumps(selection_payload, default=str)}
    user_prompt = _load_prompt("experiment_selector_user.md")
    for _k, _v in _subs.items():
        user_prompt = user_prompt.replace(f"{{{_k}}}", _v)
    system_prompt = _load_prompt("experiment_selector_system.md")

    try:
        raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {exc}") from exc
    except Exception as exc:
        _log.error("backtest_experiment_advisor error for run %d", run_id)
        raise HTTPException(status_code=503, detail=f"Experiment Advisor failed: {exc}") from exc

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        result: dict[str, Any] = json.loads(cleaned)
    except Exception:
        result = {"selected_candidate_id": None, "reasoning": raw}

    # Schema validation + one-shot repair (pass system_prompt so repair uses the
    # experiment-selector instructions, not the default signal-scan prompt).
    errs = _validate_llm_json(result, "experiment_selection.schema.json")
    if errs:
        _log.warning(
            "experiment_advisor v2 schema errors run=%d: %s",
            run_id,
            str(errs).replace("\r", "").replace("\n", ""),
        )
        try:
            repaired = _repair_llm_json(raw, errs, call_llm, system_prompt)
            result = json.loads(repaired)
        except Exception:  # noqa: S110
            pass

    # Resolve the selected candidate from the backend-generated list.
    sel_id = result.get("selected_candidate_id")
    selected_candidate = next((c for c in candidates if c.get("candidate_id") == sel_id), None)

    # LLM returned null or an unrecognised ID — auto-pick the safest (lowest
    # overfitting_risk) candidate so the card is never empty.  Mark it so the
    # frontend can show an "auto-selected" note.
    if selected_candidate is None and candidates:
        low_risk = [c for c in candidates if c.get("overfitting_risk") == "low"]
        selected_candidate = dict(low_risk[0] if low_risk else candidates[0])
        selected_candidate["_auto_selected"] = True
        _log.info(
            "experiment_advisor run=%d: LLM returned unknown id %s; auto-selected %s",
            run_id,
            str(sel_id).replace("\r", "").replace("\n", ""),
            str(selected_candidate["candidate_id"]).replace("\r", "").replace("\n", ""),
        )

    result["selected_candidate"] = selected_candidate
    result["candidates"] = candidates  # send all so frontend can show alternatives
    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct
    # Normalise v2 schema field names → what frontend reads.
    # schema: "why" → reasoning, "diagnosis" + "next_step" kept as-is.
    if "reasoning" not in result:
        result["reasoning"] = result.get("why") or result.get("diagnosis") or ""

    # Persist using the floor from the selected candidate (if any).
    selected_floor = int(
        (selected_candidate or {}).get("changes", {}).get("confidence_floor") or current_floor
    )
    try:
        save_backtest_floor_suggest(
            run_id=run_id,
            recommended_floor=selected_floor,
            reasoning=result.get("reasoning"),
            trade_off=result.get("next_action"),
            result_json=json.dumps(result, default=str),
            llm_provider=get_setting("llm_provider") or get_settings().llm.provider,
            llm_model=model_used,
            prompt_tokens=pt or 0,
            completion_tokens=ct or 0,
        )
    except Exception:  # noqa: S110
        pass  # non-fatal

    return result


@router.get("/backtest/profiles")
def list_backtest_profiles() -> dict[str, Any]:
    """Return all saved backtest parameter profiles, newest first."""
    from backend.database import get_backtest_profiles

    return {"profiles": get_backtest_profiles()}


@router.post("/backtest/profiles")
def save_backtest_profile_endpoint(
    body: dict[str, Any] = Body(...),
) -> dict[str, Any]:
    """Upsert a named backtest profile.  Body: ``{name, params}``."""
    from backend.database import save_backtest_profile

    name: str = (body.get("name") or "").strip()
    params: dict[str, Any] = body.get("params") or {}
    if not name:
        raise HTTPException(status_code=400, detail="name is required.")
    return save_backtest_profile(name, params)


@router.delete("/backtest/profiles/{profile_id}")
def delete_backtest_profile_endpoint(profile_id: int) -> dict[str, Any]:
    """Delete a saved backtest profile by id."""
    from backend.database import delete_backtest_profile

    deleted = delete_backtest_profile(profile_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Profile {profile_id} not found.")
    return {"deleted": True, "id": profile_id}


@router.get("/backtest/{run_id}")
def get_backtest_run_detail(run_id: int) -> dict[str, Any]:
    """Return a single backtest run with all its trades."""
    from backend.database import get_backtest_run

    run = get_backtest_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")
    return run


@router.delete("/backtest/{run_id}")
def delete_backtest_run_endpoint(run_id: int) -> dict[str, Any]:
    """Delete a backtest run and its trades."""
    from backend.database import delete_backtest_run

    deleted = delete_backtest_run(run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")
    return {"deleted": True, "run_id": run_id}


@router.post("/backtest/{run_id}/review")
async def backtest_review(run_id: int) -> dict[str, Any]:
    """Ask the LLM to evaluate a backtest run using the v2 methodology.

    Returns: ``verdict``, ``deployment_stage``, ``edge_assessment``, ``evidence_quality``,
    ``strengths``, ``weaknesses``, ``blocking_issues``, ``next_action``,
    ``model_used``, ``prompt_tokens``, ``completion_tokens``.
    """
    from backend.analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from backend.database import (
        get_backtest_run,
        save_backtest_review_tokens,
        update_backtest_run,
    )

    run = get_backtest_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")

    metrics = run.get("metrics") or {}

    # Build enriched v2 payload for the LLM.
    review_payload = {
        "run": {
            "run_id": str(run_id),
            "mode": run.get("signal_mode", "rules"),
            "universe": run.get("tickers") or [],
            "start": run.get("start_date", ""),
            "end": run.get("end_date", ""),
            "is_out_of_sample": bool(run.get("is_out_of_sample")),
        },
        "metric_definitions": {
            "return_frequency": "per_trade",
            "sharpe_method": "mean_R / std_R",
            "max_drawdown_unit": "R",
            "false_positive_definition": "losing trade",
        },
        "metrics": {
            "total_trades": metrics.get("total_trades", 0),
            "effective_trades": metrics.get("effective_trades", metrics.get("total_trades", 0)),
            "win_rate": metrics.get("win_rate"),
            "avg_r_multiple": metrics.get("avg_r_multiple"),
            "expectancy_ci95": metrics.get("expectancy_ci95"),
            "sharpe": metrics.get("sharpe"),
            "max_drawdown_r": metrics.get("max_drawdown"),
            "false_positive_rate": metrics.get("false_positive_rate"),
            "after_cost_avg_r": metrics.get("after_cost_avg_r"),
        },
        "robustness": {
            "fee_stress_pass": metrics.get("fee_stress_pass"),
            "ticker_concentration": metrics.get("ticker_concentration"),
            "number_of_trials": 1,
            "untouched_holdout": bool(run.get("is_out_of_sample")),
        },
        "per_ticker": metrics.get("per_ticker") or [],
        "backend_flags": [],
    }

    _subs = {"backtest_run_json": json.dumps(review_payload, default=str)}
    user_prompt = _load_prompt("backtest_review_user.md")
    for _k, _v in _subs.items():
        user_prompt = user_prompt.replace(f"{{{_k}}}", _v)
    system_prompt = _load_prompt("backtest_review_system.md")

    try:
        raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {exc}") from exc
    except Exception as exc:
        _log.error("backtest_review error for run %d", run_id)
        raise HTTPException(status_code=503, detail=f"Review failed: {exc}") from exc

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        result: dict[str, Any] = json.loads(cleaned)
    except Exception:
        result = {
            "verdict": raw,
            "deployment_stage": "research_only",
            "edge_assessment": "inconclusive",
            "evidence_quality": "weak",
            "strengths": [],
            "weaknesses": [],
            "blocking_issues": [],
            "next_action": "Inspect raw LLM output",
        }

    # Schema validation + one-shot repair (pass system_prompt so repair uses the
    # review instructions, not the default signal-scan prompt).
    errs = _validate_llm_json(result, "backtest_review.schema.json")
    if errs:
        _log.warning(
            "backtest_review v2 schema errors run=%d: %s",
            run_id,
            str(errs).replace("\r", "").replace("\n", ""),
        )
        try:
            repaired = _repair_llm_json(raw, errs, call_llm, system_prompt)
            result = json.loads(repaired)
        except Exception:  # noqa: S110
            pass

    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct

    # Persist token usage + deployment_stage.
    try:
        save_backtest_review_tokens(run_id, pt or 0, ct or 0)
        stage = result.get("deployment_stage")
        if stage:
            update_backtest_run(run_id, status="done", deployment_stage=stage)
    except Exception:  # noqa: S110
        pass  # non-fatal

    return result
