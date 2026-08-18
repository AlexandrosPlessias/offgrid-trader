"""AIAnalysisSkill — wraps ``analysis.analyze()`` with retry on OllamaError."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class AIAnalysisSkill(Skill):
    """Call the Ollama LLM to produce a structured market analysis.

    Critical: without a valid analysis the opportunity-detection step
    cannot run its AI rule (Rule 1).  The skill retries on transient
    ``OllamaError`` failures (connection reset, timeout) but does NOT
    retry on a parse failure — those indicate a model response issue
    that is unlikely to change with an immediate retry.
    """

    name = "ai_analysis"
    critical = True
    can_retry = True
    max_retries = 2
    retry_delay_base = 2.0

    def run(self, ctx: AgentContext) -> SkillResult:
        from backend.analysis import OllamaError, analyze

        if ctx.market_data is None:
            return SkillResult(success=False, error="market_data not available")

        _log.info("ai_analysis ▶ %s", ctx.ticker)
        try:
            analysis = analyze(ctx.market_data, memory=ctx.memory)
            if analysis.get("error"):
                # analyze() never raises — it returns an error dict on failure.
                # Treat connection/timeout OllamaErrors as retryable.
                err = analysis["error"]
                retryable = any(
                    kw in err.lower()
                    for kw in ("cannot reach", "timed out", "connection")
                )
                if retryable:
                    raise OllamaError(err)
                # Parse errors etc. — surface but don't retry.
                ctx.analysis = analysis
                return SkillResult(success=False, error=err, data=analysis)

            ctx.analysis = analysis
            _log.info("ai_analysis ◀ %s — %s", ctx.ticker, analysis.get("trend", "?"))
            return SkillResult(success=True, data=analysis)

        except OllamaError as exc:
            _log.warning("ai_analysis transient error for %s: %s", ctx.ticker, exc)
            return SkillResult(success=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            _log.exception("ai_analysis unexpected error for %s", ctx.ticker)
            return SkillResult(success=False, error=str(exc))
