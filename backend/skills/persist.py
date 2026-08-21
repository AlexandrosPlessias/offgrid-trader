"""PersistSkill — saves analysis log and signals to the database."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class PersistSkill(Skill):
    """Persist the analysis and each actionable signal to SQLite.

    Non-critical: a database write failure must never abort the pipeline.
    Errors are collected in ``ctx.errors`` and logged; the run continues.
    """

    name = "persist"
    critical = False
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        from backend.database import save_analysis, save_signal

        saved_ids: list[int] = []
        errors: list[str] = []

        # Persist analysis log (include full opportunity list so history can replay scores).
        if ctx.analysis and ctx.market_data:
            try:
                save_analysis(
                    ctx.ticker,
                    ctx.analysis,
                    ctx.market_data,
                    opportunities=ctx.opportunities or [],
                    actionable=ctx.actionable or [],
                    llm_provider=ctx.analysis.get("llm_provider"),
                    llm_model=ctx.analysis.get("llm_model"),
                    prompt_tokens=ctx.analysis.get("prompt_tokens") or None,
                    completion_tokens=ctx.analysis.get("completion_tokens") or None,
                )
                _log.debug("persist: saved analysis for %s", ctx.ticker)
            except Exception:
                _log.exception("persist: save_analysis failed for %s", ctx.ticker)
                errors.append("save_analysis failed — check server logs")

        # Persist each actionable signal.
        llm_provider = (ctx.analysis or {}).get("llm_provider")
        llm_model = (ctx.analysis or {}).get("llm_model")
        for opp in ctx.actionable or []:
            try:
                signal_id = save_signal(opp, llm_provider=llm_provider, llm_model=llm_model)
                saved_ids.append(signal_id)
                _log.debug("persist: saved signal %d for %s", signal_id, ctx.ticker)
            except Exception:
                _log.exception("persist: save_signal failed for %s", ctx.ticker)
                errors.append("save_signal failed — check server logs")

        ctx.saved_signal_ids.extend(saved_ids)
        ctx.errors.extend(errors)

        return SkillResult(
            success=not errors,
            data={"saved_signal_ids": saved_ids},
            error="; ".join(errors) if errors else None,
        )
