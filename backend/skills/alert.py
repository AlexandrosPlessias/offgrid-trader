"""AlertSkill — sends configured alerts for each actionable opportunity."""

from __future__ import annotations

import logging

from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class AlertSkill(Skill):
    """Fire alerts (email / Telegram / Slack) for each actionable signal.

    Non-critical: alert delivery failures must never abort the pipeline.
    Respects the ``ctx.send_alerts`` flag — when False the skill is a no-op.

    Must run after PersistSkill, which populates ``ctx.new_signal_keys`` with the
    ticker+type pairs seen for the first time today; only those are alerted.
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
            # Only the first sighting of a ticker+type today alerts. Without this
            # a ticker that stays actionable notifies on every scan cycle.
            if (opp["ticker"], opp.get("type")) not in ctx.new_signal_keys:
                _log.debug(
                    "alert: skipping %s %s — already alerted today",
                    opp.get("type"),
                    opp["ticker"],
                )
                continue
            try:
                result = send_alert(opp)
                sent.append(result)
                _log.debug(
                    "alert: sent for %s — channels=%s",
                    ctx.ticker,
                    result.get("channels"),
                )
            except Exception:
                _log.exception("alert: send_alert failed for %s", ctx.ticker)
                errors.append("send_alert failed — check server logs")

        ctx.alerts_sent.extend(sent)
        ctx.errors.extend(errors)

        return SkillResult(
            success=not errors,
            data={"alerts": sent},
            error="; ".join(errors) if errors else None,
        )
