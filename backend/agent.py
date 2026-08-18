"""TickerAgent — per-ticker pipeline runner with retry and memory.

The agent assembles a sequence of :class:`~backend.skills.Skill` instances
and runs them in order, threading an :class:`~backend.skills.AgentContext`
through each step.  Failed skills that are marked ``can_retry`` are retried
with exponential back-off; critical skills that ultimately fail abort the
rest of the pipeline.  After every run the agent updates the
:class:`~backend.memory.MemoryLayer` so the next scan for that ticker picks
up prior context.

Typical usage (from the orchestrator or SSE endpoint)::

    from backend.agent import TickerAgent
    from backend.memory import MemoryLayer

    _memory = MemoryLayer()
    result  = await TickerAgent("AAPL", memory=_memory).run()
    print(result.to_dict())
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Type

from backend.memory import MemoryLayer
from backend.skills import AgentContext, Skill, SkillResult
from backend.skills.ai_analysis import AIAnalysisSkill
from backend.skills.alert import AlertSkill
from backend.skills.fetch_data import FetchDataSkill
from backend.skills.opportunity_detect import OpportunityDetectSkill
from backend.skills.persist import PersistSkill

_log = logging.getLogger(__name__)

# Default pipeline — order matters.
DEFAULT_SKILL_CLASSES: List[Type[Skill]] = [
    FetchDataSkill,
    AIAnalysisSkill,
    OpportunityDetectSkill,
    PersistSkill,
    AlertSkill,
]


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

@dataclass
class AgentResult:
    """Outcome of a single TickerAgent run."""

    ticker: str
    success: bool
    context: AgentContext
    elapsed_s: float = 0.0
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Return a plain dict compatible with the legacy ``scan_ticker`` shape."""
        ctx = self.context
        return {
            "ticker": self.ticker,
            "analysis": ctx.analysis,
            "market_data": ctx.market_data,
            "opportunities": ctx.opportunities or [],
            "actionable": ctx.actionable or [],
            "saved_signal_ids": ctx.saved_signal_ids,
            "alerts": ctx.alerts_sent,
            "errors": ctx.errors,
            "elapsed_s": round(self.elapsed_s, 2),
        }


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

class TickerAgent:
    """Run the full scan pipeline for a single ticker.

    Args:
        ticker:       Stock ticker symbol (e.g. ``"AAPL"``).
        memory:       :class:`~backend.memory.MemoryLayer` instance shared
                      across the process.
        skill_classes: Override the default skill pipeline.
        send_alerts:  When ``False`` the :class:`~backend.skills.alert.AlertSkill`
                      fires but immediately returns without sending anything.
    """

    def __init__(
        self,
        ticker: str,
        *,
        memory: MemoryLayer,
        skill_classes: Optional[Sequence[Type[Skill]]] = None,
        send_alerts: bool = True,
    ) -> None:
        self.ticker = ticker.upper()
        self._memory = memory
        self._skills: List[Skill] = [
            cls() for cls in (skill_classes or DEFAULT_SKILL_CLASSES)
        ]
        self._send_alerts = send_alerts

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def run(self) -> AgentResult:
        """Execute the skill pipeline asynchronously.

        Each synchronous skill is dispatched to the default thread-pool via
        ``asyncio.to_thread`` so the event loop is never blocked.
        """
        t0 = time.monotonic()
        ctx = AgentContext(
            ticker=self.ticker,
            memory=self._memory.load(self.ticker),
            send_alerts=self._send_alerts,
        )

        # Emit memory event so the SSE generator can surface it.
        if ctx.memory:
            ctx.events.append({"type": "memory", "ticker": self.ticker, "memory": ctx.memory})

        _log.info("agent ▶ %s — %d skills", self.ticker, len(self._skills))

        aborted = False
        for skill in self._skills:
            result = await self._run_skill_with_retry(skill, ctx)
            if not result.success:
                if skill.critical:
                    _log.warning(
                        "agent: critical skill %s failed for %s — aborting pipeline",
                        skill.name,
                        self.ticker,
                    )
                    aborted = True
                    break
                # Non-critical failure — continue to next skill.

        # Always update memory, even on partial runs.
        self._memory.update(self.ticker, ctx)

        elapsed = time.monotonic() - t0
        success = not aborted and not any(
            s.critical for s in self._skills
            if any(e.get("skill") == s.name and e.get("type") == "skill_error"
                   for e in ctx.events)
        )

        _log.info(
            "agent ◀ %s — %d actionable, %.1fs, %d error(s)",
            self.ticker,
            len(ctx.actionable or []),
            elapsed,
            len(ctx.errors),
        )

        return AgentResult(
            ticker=self.ticker,
            success=not aborted,
            context=ctx,
            elapsed_s=elapsed,
            errors=ctx.errors,
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _run_skill_with_retry(self, skill: Skill, ctx: AgentContext) -> SkillResult:
        """Run *skill*, retrying up to ``skill.max_retries`` times on failure."""
        result: SkillResult = SkillResult(success=False, error="not run")

        for attempt in range(skill.max_retries + 1):
            if attempt > 0:
                delay = skill.retry_delay_base * (2 ** (attempt - 1))
                _log.info(
                    "agent: retrying %s for %s (attempt %d/%d, delay=%.0fs)",
                    skill.name,
                    self.ticker,
                    attempt + 1,
                    skill.max_retries + 1,
                    delay,
                )
                ctx.events.append({
                    "type": "retry",
                    "skill": skill.name,
                    "attempt": attempt + 1,
                    "delay_s": delay,
                })
                await asyncio.sleep(delay)

            # Emit a "step running" event before execution.
            ctx.events.append({
                "type": "step",
                "step": skill.name,
                "status": "running",
            })

            t0 = time.monotonic()
            result = await asyncio.to_thread(skill.run, ctx)
            elapsed = time.monotonic() - t0

            if result.success:
                ctx.events.append({
                    "type": "step",
                    "step": skill.name,
                    "status": "done",
                    "elapsed_ms": round(elapsed * 1000),
                })
                return result

            # Skill failed.
            ctx.events.append({
                "type": "step",
                "step": skill.name,
                "status": "error",
                "msg": result.error or "unknown error",
            })

            if not skill.can_retry or attempt >= skill.max_retries:
                if skill.critical:
                    ctx.errors.append(f"{skill.name}: {result.error}")
                    ctx.events.append({
                        "type": "skill_error",
                        "skill": skill.name,
                        "error": result.error,
                    })
                break

        return result
