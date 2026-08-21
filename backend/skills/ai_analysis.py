"""AIAnalysisSkill — wraps ``analysis.analyze()`` with retry on LLMError."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class AIAnalysisSkill(Skill):
    """Call the configured LLM to produce a structured market analysis.

    Critical: without a valid analysis the opportunity-detection step
    cannot run its AI rule (Rule 1).  The skill retries on transient
    ``LLMError`` failures (connection reset, timeout) but does NOT
    retry on a parse failure — those indicate a model response issue
    that is unlikely to change with an immediate retry.

    Works with any provider: Ollama (local), Groq, or a custom
    OpenAI-compatible endpoint.  The active provider is read from the DB
    setting ``llm_provider`` or the ``LLM_PROVIDER`` env var.
    """

    name = "ai_analysis"
    critical = True
    can_retry = True
    max_retries = 2
    retry_delay_base = 2.0

    def run(self, ctx: AgentContext) -> SkillResult:
        from backend.analysis import (  # noqa: F401 (OllamaError re-export)
            LLMError,
            OllamaError,
            analyze,
        )

        if ctx.market_data is None:
            return SkillResult(success=False, error="market_data not available")

        _log.info("ai_analysis ▶ %s", ctx.ticker)
        try:
            analysis = analyze(ctx.market_data, memory=ctx.memory)
            if analysis.get("error"):
                # analyze() never raises — it returns an error dict on failure.
                # Treat connection/timeout LLMErrors as retryable.
                err = analysis["error"]
                retryable = any(
                    kw in err.lower() for kw in ("cannot reach", "timed out", "connection")
                )
                if retryable:
                    raise LLMError(err)
                # Parse errors etc. — surface but don't retry.
                ctx.analysis = analysis
                return SkillResult(success=False, error=err, data=analysis)

            ctx.analysis = analysis
            _log.info(
                "ai_analysis ◀ %s — %s (provider=%s model=%s)",
                ctx.ticker,
                analysis.get("trend", "?"),
                analysis.get("llm_provider", "?"),
                analysis.get("llm_model", "?"),
            )
            return SkillResult(success=True, data=analysis)

        except LLMError as exc:
            _log.warning("ai_analysis transient error for %s: %s", ctx.ticker, exc)
            return SkillResult(success=False, error=str(exc))
        except Exception as exc:
            _log.exception("ai_analysis unexpected error for %s", ctx.ticker)
            return SkillResult(success=False, error=str(exc))
