"""Section 5 — Opportunity detection on synthetic data (no network)."""

from __future__ import annotations


def test_opportunity_detection(check, synthetic, ai_result, opps):
    # --------------------------------------------------------------------------- #
    # 5. Opportunity detection on synthetic data (no network)
    # --------------------------------------------------------------------------- #
    check("detect_opportunities returns results", len(opps) > 0)
    check("top opportunity is long", bool(opps) and opps[0]["type"] == "long")
    check(
        "multiple sources merged",
        bool(opps) and len(opps[0]["sources"]) >= 2,
        detail=str(opps[0]["sources"]) if opps else "",
    )
