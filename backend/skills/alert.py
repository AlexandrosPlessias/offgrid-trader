"""AlertSkill — sends configured alerts for each actionable opportunity."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class AlertSkill(Skill):
    """Fire alerts (email / Telegram / Slack) for each actionable signal.

    Non-critical: alert delivery failures must never abort the pipeline.
    Respects the ``ctx.send_alerts`` flag — when False the skill is a no-op.
    """

    name = "alert"
    critical = False
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        if not ctx.send_alerts:
            return SkillResult(success=True, data={"alerts": []})

        from backend.alerts import send_alert

        sent: list[dict] = []
        errors: list[str] = []

        for opp in ctx.actionable or []:
            try:
                result = send_alert(opp)
                sent.append(result)
                _log.debug(
                    "alert: sent for %s — channels=%s",
                    ctx.ticker,
                    result.get("channels"),
                )
            except Exception:  # noqa: BLE001
                _log.exception("alert: send_alert failed for %s", ctx.ticker)
                errors.append("send_alert failed — check server logs")

        ctx.alerts_sent.extend(sent)
        ctx.errors.extend(errors)

        return SkillResult(
            success=not errors,
            data={"alerts": sent},
            error="; ".join(errors) if errors else None,
        )
