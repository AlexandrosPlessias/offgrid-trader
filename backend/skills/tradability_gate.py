"""TradabilityGateSkill — drop signals that can't result in any order.

Runs after OpportunityDetect and before Persist.  For each actionable
opportunity it fetches the Alpaca asset metadata once and annotates two
flags used by the downstream trade skills:

    can_bracket = tradable and (long or (short and shortable))
    can_frac    = tradable and fractionable and long

Behaviour is governed by the ``signal_drop_mode`` setting:
    "untradable" — drop only permanently-unactionable signals (default)
    "strict"     — same drop set (transient blocks are handled by the trade
                   skills, which still notify); reserved for future widening
    "never"      — annotate only, never drop (full audit trail)

A signal that can neither place a bracket order nor a fractional buy is
useless, so in the dropping modes it is removed from ``ctx.actionable`` and
never persisted.  An unknown/failed asset lookup is treated permissively
(can_bracket=True) so a flaky Alpaca call never discards valid signals — the
trade skill handles any real rejection at placement time.
"""

from __future__ import annotations

import logging

from backend.alpaca import AlpacaError, get_client
from backend.database import get_setting, save_event
from backend.routes._models import _clean_ticker
from backend.skills import AgentContext, Skill, SkillResult

_log = logging.getLogger(__name__)


class TradabilityGateSkill(Skill):
    """Annotate opps with can_bracket/can_frac and drop the useless ones."""

    name = "tradability_gate"
    critical = False  # failure never aborts the pipeline
    can_retry = False

    def run(self, ctx: AgentContext) -> SkillResult:
        if not ctx.actionable:
            return SkillResult(success=True, data={"kept": 0, "dropped": 0})

        drop_mode = (get_setting("signal_drop_mode", "") or "untradable").lower()

        try:
            client = get_client()
        except Exception as exc:  # pragma: no cover - defensive
            _log.warning("tradability_gate: could not init Alpaca client: %s", exc)
            # Can't check — leave actionable untouched, permissive annotations.
            for opp in ctx.actionable:
                opp.setdefault("can_bracket", True)
                opp.setdefault("can_frac", opp.get("type") == "long")
            return SkillResult(success=False, error=str(exc))

        kept: list[dict] = []
        dropped: list[str] = []

        for opp in ctx.actionable:
            is_long = opp.get("type") == "long"
            asset = self._lookup(client, opp["ticker"])

            if asset is None:
                # Unknown/failed lookup — permissive so we don't lose signals.
                opp["can_bracket"] = True
                opp["can_frac"] = is_long
                kept.append(opp)
                continue

            tradable = asset["tradable"]
            can_bracket = tradable and (is_long or (not is_long and asset["shortable"]))
            can_frac = tradable and asset["fractionable"] and is_long
            opp["can_bracket"] = can_bracket
            opp["can_frac"] = can_frac

            if drop_mode != "never" and not (can_bracket or can_frac):
                dropped.append(opp["ticker"])
                reason = "not tradable" if not tradable else "no shortable/fractionable path"
                save_event(
                    "scan",
                    f"Dropped {opp['ticker']} {opp.get('type', '?')} signal — {reason}",
                    level="warning",
                    meta={"ticker": opp["ticker"], "type": opp.get("type"), "reason": reason},
                )
                continue

            kept.append(opp)

        ctx.actionable = kept
        return SkillResult(success=True, data={"kept": len(kept), "dropped": dropped})

    @staticmethod
    def _lookup(client, ticker: str) -> dict | None:
        """Return {tradable, shortable, fractionable} or None if unknown."""
        try:
            asset = client._get(f"/v2/assets/{_clean_ticker(ticker)}")
        except AlpacaError:
            return None
        return {
            "tradable": bool(asset.get("tradable", False)),
            "shortable": bool(asset.get("shortable", False)),
            "fractionable": bool(asset.get("fractionable", False)),
        }
