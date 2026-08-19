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
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from opentelemetry import metrics as _otel_metrics
from opentelemetry import trace as _otel_trace

from backend.memory import MemoryLayer
from backend.skills import AgentContext, Skill, SkillResult
from backend.skills.ai_analysis import AIAnalysisSkill
from backend.skills.alert import AlertSkill
from backend.skills.fetch_data import FetchDataSkill
from backend.skills.opportunity_detect import OpportunityDetectSkill
from backend.skills.persist import PersistSkill

_log = logging.getLogger(__name__)
_tracer = _otel_trace.get_tracer("marketsage.agent")

# Allowlist: tickers are A-Z 0-9 . - only (e.g. "BRK.B", "BF-B").
# Stripping other characters (especially \r\n) prevents log injection.
_TICKER_SAFE_RE = re.compile(r"[^A-Z0-9.\-]")

# ── OTEL metric instruments ────────────────────────────────────────────────────
# All are no-ops when no MeterProvider has been configured (e.g. outside Docker).
_meter = _otel_metrics.get_meter("marketsage.agent", version="1.0")

_agent_runs = _meter.create_counter(
    "marketsage.agent.runs",
    unit="1",
    description="Number of TickerAgent pipeline runs completed",
)
_agent_duration = _meter.create_histogram(
    "marketsage.agent.duration",
    unit="ms",
    description="Total TickerAgent pipeline wall-clock time",
)
_skill_calls = _meter.create_counter(
    "marketsage.skill.calls",
    unit="1",
    description="Individual skill executions (each retry counts separately)",
)
_skill_duration = _meter.create_histogram(
    "marketsage.skill.duration",
    unit="ms",
    description="Per-skill wall-clock time",
)
_skill_retries = _meter.create_counter(
    "marketsage.skill.retries",
    unit="1",
    description="Skill retry attempts triggered by transient failures",
)

# Default pipeline — order matters.
DEFAULT_SKILL_CLASSES: list[type[Skill]] = [
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
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
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
        ticker:        Stock ticker symbol (e.g. ``"AAPL"``).
        memory:        :class:`~backend.memory.MemoryLayer` instance shared
                       across the process.
        skill_classes: Override the default skill pipeline.
        send_alerts:   When ``False`` the AlertSkill fires but immediately
                       returns without sending anything.
    """

    def __init__(
        self,
        ticker: str,
        *,
        memory: MemoryLayer,
        skill_classes: Sequence[type[Skill]] | None = None,
        send_alerts: bool = True,
    ) -> None:
        # Strip non-ticker characters to prevent log injection.
        # .replace() is applied first so CodeQL recognises the newline sanitiser;
        # the allowlist regex then strips any remaining non-ticker characters.
        _stripped = ticker.upper().replace("\n", "").replace("\r", "")
        self.ticker = _TICKER_SAFE_RE.sub("", _stripped)
        self._memory = memory
        self._skills: list[Skill] = [cls() for cls in (skill_classes or DEFAULT_SKILL_CLASSES)]
        self._send_alerts = send_alerts

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def run(self, event_queue: asyncio.Queue | None = None) -> AgentResult:
        """Execute the skill pipeline asynchronously.

        Each synchronous skill is dispatched to the default thread-pool via
        ``asyncio.to_thread`` so the event loop is never blocked.

        When *event_queue* is supplied, every SSE event is put on the queue
        as it is produced (real-time streaming).  A ``None`` sentinel is
        placed on the queue when the agent finishes.  Without a queue,
        events are only accumulated in ``ctx.events`` (batch mode for the
        orchestrator / scheduler).
        """
        t0 = time.monotonic()
        ctx = AgentContext(
            ticker=self.ticker,
            memory=self._memory.load(self.ticker),
            send_alerts=self._send_alerts,
        )

        with _tracer.start_as_current_span("agent.run") as span:
            span.set_attribute("ticker", self.ticker)
            span.set_attribute("skills.count", len(self._skills))

            # Emit memory event so the SSE generator can surface prior context.
            if ctx.memory:
                await self._emit(
                    {"type": "memory", "ticker": self.ticker, "memory": ctx.memory},
                    ctx,
                    event_queue,
                )

            _log.info("agent ▶ %s — %d skills", self.ticker, len(self._skills))

            aborted = False
            for skill in self._skills:
                result = await self._run_skill_with_retry(skill, ctx, event_queue)
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

            span.set_attribute("agent.success", not aborted)
            span.set_attribute("agent.actionable", len(ctx.actionable or []))
            span.set_attribute("agent.elapsed_ms", round(elapsed * 1000))
            span.set_attribute("agent.errors", len(ctx.errors))

            # Record agent-level metrics.
            _run_attrs = {"ticker": self.ticker, "success": not aborted}
            _agent_runs.add(1, _run_attrs)
            _agent_duration.record(round(elapsed * 1000), _run_attrs)

            _log.info(
                "agent ◀ %s — %d actionable, %.1fs, %d error(s)",
                self.ticker,
                len(ctx.actionable or []),
                elapsed,
                len(ctx.errors),
            )

            # Signal completion to the SSE generator.
            if event_queue is not None:
                await event_queue.put(None)

        return AgentResult(
            ticker=self.ticker,
            success=not aborted,
            context=ctx,
            elapsed_s=elapsed,
            errors=ctx.errors,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _emit(
        event: dict[str, Any],
        ctx: AgentContext,
        event_queue: asyncio.Queue | None,
    ) -> None:
        """Append *event* to ctx.events and optionally put it on the queue."""
        ctx.events.append(event)
        if event_queue is not None:
            await event_queue.put(event)

    async def _run_skill_with_retry(
        self,
        skill: Skill,
        ctx: AgentContext,
        event_queue: asyncio.Queue | None = None,
    ) -> SkillResult:
        """Run *skill*, retrying up to ``skill.max_retries`` times on failure.

        Emits ``step``, ``retry``, and ``skill_error`` events to both
        ``ctx.events`` and *event_queue* (when supplied) so the SSE generator
        receives them in real-time — one at a time as each skill finishes,
        not all in a burst at the end.
        """
        result: SkillResult = SkillResult(success=False, error="not run")

        with _tracer.start_as_current_span(f"skill.{skill.name}") as span:
            span.set_attribute("skill.name", skill.name)
            span.set_attribute("skill.critical", skill.critical)
            span.set_attribute("skill.can_retry", skill.can_retry)
            span.set_attribute("ticker", ctx.ticker)

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
                    await self._emit(
                        {
                            "type": "retry",
                            "skill": skill.name,
                            "attempt": attempt + 1,
                            "delay_s": delay,
                        },
                        ctx,
                        event_queue,
                    )
                    await asyncio.sleep(delay)
                    span.set_attribute("skill.retries", attempt)
                    _skill_retries.add(1, {"skill": skill.name, "ticker": ctx.ticker})

                # Emit "running" BEFORE dispatching to thread — the client
                # sees the step start immediately, not after the I/O completes.
                await self._emit(
                    {"type": "step", "step": skill.name, "status": "running"},
                    ctx,
                    event_queue,
                )

                t0 = time.monotonic()
                result = await asyncio.to_thread(skill.run, ctx)
                elapsed = time.monotonic() - t0

                span.set_attribute("skill.attempt", attempt + 1)
                span.set_attribute("skill.elapsed_ms", round(elapsed * 1000))

                # Record per-skill metrics for this attempt.
                _skill_attrs = {
                    "skill": skill.name,
                    "success": result.success,
                    "attempt": attempt + 1,
                }
                _skill_calls.add(1, _skill_attrs)
                _skill_duration.record(
                    round(elapsed * 1000),
                    {"skill": skill.name, "success": result.success},
                )

                if result.success:
                    await self._emit(
                        {
                            "type": "step",
                            "step": skill.name,
                            "status": "done",
                            "elapsed_ms": round(elapsed * 1000),
                        },
                        ctx,
                        event_queue,
                    )
                    span.set_attribute("skill.success", True)
                    return result

                # Skill failed.
                await self._emit(
                    {
                        "type": "step",
                        "step": skill.name,
                        "status": "error",
                        "msg": result.error or "unknown error",
                    },
                    ctx,
                    event_queue,
                )

                if not skill.can_retry or attempt >= skill.max_retries:
                    if skill.critical:
                        ctx.errors.append(f"{skill.name}: {result.error}")
                        await self._emit(
                            {
                                "type": "skill_error",
                                "skill": skill.name,
                                "error": result.error,
                            },
                            ctx,
                            event_queue,
                        )
                    span.set_attribute("skill.success", False)
                    span.set_attribute("skill.error", result.error or "")
                    span.set_status(_otel_trace.StatusCode.ERROR)
                    break

        return result
