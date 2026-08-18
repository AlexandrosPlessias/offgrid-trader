"""Skills — standardised, independently testable pipeline steps.

Each skill wraps one stage of the scan pipeline.  The ``TickerAgent``
assembles a list of skills and runs them in sequence, passing an
``AgentContext`` through each step.

Usage::

    from backend.skills import AgentContext, SkillResult
    from backend.skills.fetch_data import FetchDataSkill

    ctx = AgentContext(ticker="AAPL")
    skill = FetchDataSkill()
    result = skill.run(ctx)
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data structures shared across all skills
# ---------------------------------------------------------------------------

@dataclass
class SkillResult:
    """Outcome of a single skill execution."""

    success: bool
    data: Any = None
    error: Optional[str] = None
    attempts: int = 1


@dataclass
class AgentContext:
    """Mutable state threaded through every skill in a pipeline run.

    Skills read from context fields populated by earlier skills and write
    their results to the relevant fields.  ``events`` accumulates structured
    log entries that the SSE generator drains after each skill completes.
    """

    ticker: str
    market_data: Optional[Dict[str, Any]] = None
    analysis: Optional[Dict[str, Any]] = None
    opportunities: Optional[List[Dict[str, Any]]] = None
    actionable: Optional[List[Dict[str, Any]]] = None
    saved_signal_ids: List[int] = field(default_factory=list)
    alerts_sent: List[Dict[str, Any]] = field(default_factory=list)
    memory: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    # Structured events emitted during the run; drained by the SSE generator.
    events: List[Dict[str, Any]] = field(default_factory=list)
    # Controls whether the alert skill fires.
    send_alerts: bool = True


# ---------------------------------------------------------------------------
# Skill base class
# ---------------------------------------------------------------------------

class Skill(ABC):
    """Abstract base for a single pipeline step.

    Subclasses set class-level attributes to declare retry behaviour and
    whether a failure should abort the rest of the pipeline.

    Attributes:
        name:             Human-readable identifier used in logs and events.
        critical:         If ``True`` and the skill fails after all retries,
                          the agent stops the pipeline immediately.
        can_retry:        Whether the agent should retry on failure.
        max_retries:      Maximum number of extra attempts (0 = try once).
        retry_delay_base: Base delay in seconds; each retry doubles it
                          (1st retry waits ``retry_delay_base`` s,
                          2nd waits ``retry_delay_base * 2`` s, …).
    """

    name: str = "skill"
    critical: bool = True
    can_retry: bool = False
    max_retries: int = 0
    retry_delay_base: float = 2.0

    @abstractmethod
    def run(self, ctx: AgentContext) -> SkillResult:
        """Execute the skill and return a result.

        Must never raise — surface errors through ``SkillResult(success=False,
        error=...)``.
        """
        ...

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} critical={self.critical} retries={self.max_retries}>"
