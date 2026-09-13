"""Section 7 — AI analysis with mocked LLM (provider-agnostic)."""

from __future__ import annotations

from unittest import mock

from backend import analysis
from backend.analysis import LLMError


def test_ai_analysis(check, synthetic):
    # --------------------------------------------------------------------------- #
    # 7. AI analysis with mocked LLM (provider-agnostic)
    # --------------------------------------------------------------------------- #
    _FAKE_LLM_JSON = (
        '{"trend":"bullish","momentum":"strong","key_levels":{"support":[95],'
        '"resistance":[110]},"signals":["x"],"opportunity":{"type":"long",'
        '"confidence":75,"entry":100,"stop":95,"target":110},"risk_factors":["y"]}'
    )
    # call_llm returns (raw_text, model_used, prompt_tokens, completion_tokens)
    _FAKE_LLM_RETURN = (_FAKE_LLM_JSON, "mock-model", 100, 50)
    with mock.patch("backend.analysis.call_llm", return_value=_FAKE_LLM_RETURN):
        parsed = analysis.analyze(synthetic)
    check(
        "analyze() parses mocked Ollama JSON",
        parsed.get("trend") == "bullish",
        repr(parsed),
    )
    check("analyze() opportunity normalised", parsed["opportunity"]["type"] == "long")

    # LLM unavailable path.
    with mock.patch("backend.analysis.call_llm", side_effect=LLMError("offline")):
        err = analysis.analyze(synthetic)
    check("analyze() handles Ollama offline", "error" in err and err["opportunity"] is None)
