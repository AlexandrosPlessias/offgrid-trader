"""Section 12 — Agentic architecture: TickerAgent, MemoryLayer, Orchestrator."""

from __future__ import annotations


def test_agentic_architecture(check):
    # --------------------------------------------------------------------------- #
    # 12. Agentic architecture — TickerAgent, MemoryLayer, Orchestrator
    # --------------------------------------------------------------------------- #
    try:
        import asyncio as _asyncio

        from backend.agent import TickerAgent as _TickerAgent
        from backend.memory import MemoryLayer as _MemoryLayer
        from backend.orchestrator import Orchestrator as _Orchestrator
        from backend.skills import AgentContext as _AgentContext
        from backend.skills import Skill as _Skill
        from backend.skills import SkillResult as _SkillResult
        from backend.skills.ai_analysis import AIAnalysisSkill as _AIAnalysisSkill
        from backend.skills.alert import AlertSkill as _AlertSkill
        from backend.skills.fetch_data import FetchDataSkill as _FetchDataSkill
        from backend.skills.persist import PersistSkill as _PersistSkill

        check("import agent/memory/orchestrator/skills", True)

        # ── 12a. MemoryLayer — load returns {} for unknown ticker ───────────────
        _mem = _MemoryLayer()
        _mem_val = _mem.load("SMOKE_UNKNOWN_TICKER_XYZ")
        check(
            "MemoryLayer.load returns {} for unknown ticker",
            _mem_val == {},
            detail=str(_mem_val),
        )

        # ── 12b. MemoryLayer — update and reload ───────────────────────────────
        _ctx_mem = _AgentContext(
            ticker="SMOKE",
            actionable=[{"type": "long", "confidence": 75.0}],
            market_data={"price": {"current": 100.0}, "technicals": {}},
            memory={},
        )
        _mem.update("SMOKE", _ctx_mem)
        _reloaded = _mem.load("SMOKE")
        check(
            "MemoryLayer.update persists last_signal",
            _reloaded.get("last_signal") == "long",
            detail=str(_reloaded),
        )
        check(
            "MemoryLayer.update persists last_confidence",
            _reloaded.get("last_confidence") == 75.0,
            detail=str(_reloaded),
        )

        # ── 12c. MemoryLayer.format_prompt_section ─────────────────────────────
        _section = _mem.format_prompt_section(_reloaded)
        check(
            "MemoryLayer.format_prompt_section returns PRIOR CONTEXT block",
            "PRIOR CONTEXT" in _section,
            detail=repr(_section),
        )

        # ── 12d. MemoryLayer.clear ─────────────────────────────────────────────
        _mem.clear("SMOKE")
        check("MemoryLayer.clear removes row", _mem.load("SMOKE") == {}, detail="expected {}")

        # ── 12e. Skill base — AgentContext and SkillResult shape ───────────────
        _ctx2 = _AgentContext(ticker="TEST")
        check("AgentContext defaults", _ctx2.errors == [] and _ctx2.events == [])
        _sr = _SkillResult(success=True, data={"x": 1})
        check("SkillResult fields", _sr.success is True and _sr.data == {"x": 1})

        # ── 12f. Skills are non-critical where expected ─────────────────────────
        check("PersistSkill critical=False", _PersistSkill.critical is False)
        check("AlertSkill critical=False", _AlertSkill.critical is False)
        check("FetchDataSkill critical=True", _FetchDataSkill.critical is True)
        check("AIAnalysisSkill can_retry=True", _AIAnalysisSkill.can_retry is True)

        # ── 12g. TickerAgent constructs with default skills ────────────────────
        _agent = _TickerAgent("AAPL", memory=_MemoryLayer())
        check("TickerAgent constructs", _agent.ticker == "AAPL")
        check("TickerAgent has 6 default skills", len(_agent._skills) == 6)

        # ── 12h. TickerAgent runs end-to-end with mocked skills ───────────────
        class _OkSkill(_FetchDataSkill):
            """Stub that injects synthetic market_data without hitting yfinance."""

            def run(self, ctx):
                ctx.market_data = {
                    "ticker": ctx.ticker,
                    "price": {"current": 150.0},
                    "technicals": {},
                    "fundamentals": {},
                    "errors": [],
                }
                return _SkillResult(success=True, data=ctx.market_data)

        class _NoopSkill(_Skill):
            name = "noop"
            critical = False
            can_retry = False
            max_retries = 0
            retry_delay_base = 1.0

            def run(self, ctx):
                return _SkillResult(success=True, data=None)

        _agent2 = _TickerAgent(
            "AAPL",
            memory=_MemoryLayer(),
            skill_classes=[
                _OkSkill,
                type("_Noop1", (_NoopSkill,), {"name": "ai_analysis"}),
                type("_Noop2", (_NoopSkill,), {"name": "opportunity_detect"}),
                type("_Noop3", (_NoopSkill,), {"name": "persist"}),
                type("_Noop4", (_NoopSkill,), {"name": "alert"}),
            ],
            send_alerts=False,
        )
        _result2 = _asyncio.run(_agent2.run())
        check("TickerAgent.run() returns AgentResult", hasattr(_result2, "to_dict"))
        _rd = _result2.to_dict()
        check("AgentResult.to_dict() has ticker key", _rd.get("ticker") == "AAPL")
        check("AgentResult.to_dict() has market_data", _rd.get("market_data") is not None)

        # ── 12i. Orchestrator priority — unknown ticker gets max priority ───────
        _orch = _Orchestrator(memory=_MemoryLayer())
        _p = _orch.priority("COMPLETELY_UNKNOWN_TICKER_XYZ_999")
        check(
            "Orchestrator.priority returns inf for unseen ticker",
            _p == float("inf"),
            detail=str(_p),
        )

    except Exception as exc:
        check("agentic architecture smoke", False, repr(exc))
