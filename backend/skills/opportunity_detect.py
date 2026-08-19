"""OpportunityDetectSkill — wraps detect_opportunities + filter_by_confidence."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class OpportunityDetectSkill(Skill):
    """Run all six detection rules against market data and analysis output.

    Non-critical: detection is pure computation; a failure here (e.g. a
    badly-shaped analysis dict) should not abort the run — the persist and
    alert skills will simply see empty actionable lists.
    """

    name = "opportunity_detect"
    critical = False
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        from backend.opportunities import detect_opportunities, filter_by_confidence

        if ctx.market_data is None:
            return SkillResult(success=False, error="market_data not available")

        _log.info("opportunity_detect ▶ %s", ctx.ticker)
        try:
            opportunities = detect_opportunities(ctx.market_data, ctx.analysis)
            actionable = filter_by_confidence(opportunities)
            ctx.opportunities = opportunities
            ctx.actionable = actionable
            _log.info(
                "opportunity_detect ◀ %s — %d opportunities, %d actionable",
                ctx.ticker,
                len(opportunities),
                len(actionable),
            )
            return SkillResult(
                success=True,
                data={"opportunities": opportunities, "actionable": actionable},
            )
        except Exception as exc:
            _log.exception("opportunity_detect failed for %s", ctx.ticker)
            ctx.opportunities = []
            ctx.actionable = []
            return SkillResult(success=False, error=str(exc))
