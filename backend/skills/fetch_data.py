"""FetchDataSkill — wraps ``data.get_market_data()``."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class FetchDataSkill(Skill):
    """Fetch price, fundamentals, technicals, news, balance sheet and macro
    data for the ticker.

    Critical: if this skill fails the pipeline cannot continue.
    Retries up to 2 times with exponential back-off to handle transient
    network errors.
    """

    name = "fetch_data"
    critical = True
    can_retry = True
    max_retries = 2
    retry_delay_base = 3.0

    def run(self, ctx: AgentContext) -> SkillResult:
        from backend.data import get_market_data

        _log.info("fetch_data ▶ %s", ctx.ticker)
        try:
            market_data = get_market_data(ctx.ticker)
            ctx.market_data = market_data
            errors = market_data.get("errors") or []
            _log.info(
                "fetch_data ◀ %s — %d source error(s)", ctx.ticker, len(errors)
            )
            return SkillResult(success=True, data=market_data)
        except Exception as exc:  # noqa: BLE001
            _log.exception("fetch_data failed for %s", ctx.ticker)
            return SkillResult(success=False, error=str(exc))
