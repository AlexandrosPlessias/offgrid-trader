"""PersistSkill — saves analysis log and signals to the database."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


def _save_analysis_log(ctx: AgentContext) -> str | None:
    """Write the analysis (with every opportunity) to analysis_log; return an error or None."""
    from backend.database import save_analysis

    if not (ctx.analysis and ctx.market_data):
        return None
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
        return None
    except Exception:
        _log.exception("persist: save_analysis failed for %s", ctx.ticker)
        return "save_analysis failed — check server logs"


class SaveAnalysisSkill(Skill):
    """Persist only the analysis log — no signals, so nothing downstream can trade on it."""

    name = "save_analysis"
    critical = False
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        error = _save_analysis_log(ctx)
        if error:
            ctx.errors.append(error)
        return SkillResult(success=error is None, error=error)


class PersistSkill(Skill):
    """Persist the analysis and each actionable signal to SQLite.

    Non-critical: a database write failure must never abort the pipeline.
    Errors are collected in ``ctx.errors`` and logged; the run continues.
    """

    name = "persist"
    critical = False
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        from backend.database import (
            get_setting,
            get_todays_signal,
            save_event,
            save_signal,
            update_signal_confidence,
        )

        # Points of confidence a repeat signal must gain over the last alerted
        # value to notify again. 0 disables re-alerts (one per ticker+type/day).
        try:
            realert_delta = float(get_setting("signal_realert_delta", "") or 10.0)
        except ValueError:
            realert_delta = 10.0

        saved_ids: dict[str, int] = {}  # {ticker: signal_id}
        errors: list[str] = []

        # Persist analysis log (include full opportunity list so history can replay scores).
        error = _save_analysis_log(ctx)
        if error:
            errors.append(error)

        # Persist each actionable signal.
        llm_provider = (ctx.analysis or {}).get("llm_provider")
        llm_model = (ctx.analysis or {}).get("llm_model")
        for opp in ctx.actionable or []:
            try:
                sig_type = str(opp.get("type") or "")
                new_conf = float(opp.get("confidence") or 0.0)
                # Read before the write — afterwards the row always exists and a
                # first sighting is indistinguishable from a repeat.
                prior = get_todays_signal(opp["ticker"], sig_type)
                signal_id = save_signal(opp, llm_provider=llm_provider, llm_model=llm_model)
                saved_ids[opp["ticker"]] = signal_id

                if prior is None:
                    reason = "new"
                elif realert_delta > 0 and new_conf - prior[1] >= realert_delta:
                    # Confidence climbed materially since the last alert — notify
                    # again and re-baseline so the next climb is measured from here.
                    update_signal_confidence(signal_id, new_conf)
                    reason = f"re-alert {prior[1]:.0f}%→{new_conf:.0f}%"
                else:
                    reason = "repeat"

                if reason != "repeat":
                    ctx.new_signal_keys.add((opp["ticker"], sig_type))
                _log.debug("persist: signal %d for %s (%s)", signal_id, ctx.ticker, reason)
                save_event(
                    "scan",
                    f"Signal {opp.get('type', '?')} {opp['ticker']} "
                    f"{float(opp.get('confidence') or 0):.0f}%",
                    meta={"ticker": opp["ticker"], "signal_id": signal_id},
                )
            except Exception:
                _log.exception("persist: save_signal failed for %s", ctx.ticker)
                errors.append("save_signal failed — check server logs")

        ctx.saved_signal_ids.update(saved_ids)
        ctx.errors.extend(errors)

        return SkillResult(
            success=not errors,
            data={"saved_signal_ids": saved_ids},
            error="; ".join(errors) if errors else None,
        )
