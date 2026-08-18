"""AI analysis layer backed by a local Ollama model (qwen2.5:14b).

Turns the unified market-data dict from :mod:`backend.data` into a structured
prompt, sends it to the local Ollama ``/api/chat`` endpoint and parses the
JSON response into a normalised analysis dict.

Everything is local and free — no cloud/paid LLM is contacted. All failure
modes (Ollama not running, request timeout, malformed JSON) are caught and
returned as a structured error so callers never crash.

Run standalone (requires a running Ollama)::

    python -m backend.analysis AAPL
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

import requests
from opentelemetry import trace as _otel_trace

from .config import get_settings
from .database import get_setting as _get_db_setting

_tracer = _otel_trace.get_tracer("marketsage.analysis")

_log = logging.getLogger(__name__)

# Keys we expect the model to return. Missing keys are backfilled with None.
_EXPECTED_KEYS = (
    "trend",
    "momentum",
    "key_levels",
    "signals",
    "opportunity",
    "risk_factors",
)

_SYSTEM_PROMPT = (
    "You are a disciplined technical-analysis assistant for equities. "
    "You are given a snapshot of price action and multi-timeframe indicators. "
    "Respond ONLY with a single valid JSON object (no markdown, no prose) using "
    "exactly this schema:\n"
    "{\n"
    '  "trend": "bullish|bearish|neutral",\n'
    '  "momentum": "strong|weak|building|fading|neutral",\n'
    '  "key_levels": {"support": [numbers], "resistance": [numbers]},\n'
    '  "signals": ["short strings describing notable signals"],\n'
    '  "opportunity": {\n'
    '    "type": "long|short|none",\n'
    '    "confidence": 0-100,\n'
    '    "entry": number|null,\n'
    '    "stop": number|null,\n'
    '    "target": number|null\n'
    "  },\n"
    '  "risk_factors": ["short strings"]\n'
    "}\n"
    "Base every conclusion strictly on the supplied data. If the setup is "
    "unclear, use type \"none\" and a low confidence. This is not financial advice."
)


class OllamaError(RuntimeError):
    """Raised when the local Ollama server cannot be reached or errors out."""


# --------------------------------------------------------------------------- #
# Prompt construction
# --------------------------------------------------------------------------- #
def _fmt(value: Any) -> str:
    return "n/a" if value is None else str(value)


def build_prompt(market_data: Dict[str, Any], memory: Optional[Dict[str, Any]] = None) -> str:
    """Render *market_data* into a compact, readable prompt for the model.

    Optional ``news`` key in *market_data* (a list of headline strings from
    Finnhub) is injected before the risk-factor section when non-empty.

    Optional ``memory`` dict (from :class:`~backend.memory.MemoryLayer`) is
    injected as a ``PRIOR CONTEXT`` section at the top of the prompt so the
    model can reference prior signals and RSI streaks.
    """

    price = market_data.get("price", {}) or {}
    fundamentals = market_data.get("fundamentals", {}) or {}
    technicals = market_data.get("technicals", {}) or {}
    news: List[Dict[str, Any]] = market_data.get("news") or []

    def _v(d: Dict[str, Any], key: str) -> Any:
        """Extract .value from a nested {value, date} dict."""
        sub = (d or {}).get(key) or {}
        return sub.get("value") if isinstance(sub, dict) else None

    lines: List[str] = []

    # Inject prior-scan context at the top when memory is available.
    if memory:
        from backend.memory import MemoryLayer as _ML
        prior = _ML().format_prompt_section(memory)
        if prior:
            lines.append(prior)
            lines.append("")

    lines.append(f"Ticker: {market_data.get('ticker')}")
    name = fundamentals.get("name")
    if name:
        lines.append(f"Name: {name}")
    sector = fundamentals.get("sector")
    if sector:
        lines.append(f"Sector: {sector} / {_fmt(fundamentals.get('industry'))}")
    lines.append(f"As of: {market_data.get('timestamp')}")
    lines.append("")

    lines.append("PRICE / VOLUME")
    lines.append(
        f"  Current: {_fmt(price.get('current'))} | "
        f"Change: {_fmt(price.get('change'))} ({_fmt(price.get('change_pct'))}%)"
    )
    lines.append(
        f"  Volume: {_fmt(price.get('volume'))} | "
        f"Avg(20d): {_fmt(price.get('avg_volume'))} | "
        f"Ratio: {_fmt(price.get('volume_ratio'))}x"
    )
    lines.append(
        f"  MA5: {_fmt(price.get('ma5'))} | MA20: {_fmt(price.get('ma20'))}"
    )
    lines.append(
        f"  52w High: {_fmt(price.get('week52_high'))} | "
        f"52w Low: {_fmt(price.get('week52_low'))} | "
        f"Day range: {_fmt(price.get('day_low'))}-{_fmt(price.get('day_high'))}"
    )
    lines.append("")

    lines.append("TECHNICALS (per timeframe)")
    for tf in ("1H", "4H", "1D"):
        tdata = technicals.get(tf)
        if not tdata:
            lines.append(f"  {tf}: unavailable")
            continue
        macd = tdata.get("MACD", {}) or {}
        bb = tdata.get("BollingerBands", {}) or {}
        stoch = tdata.get("Stochastic", {}) or {}
        lines.append(
            f"  {tf}: RSI={_fmt(tdata.get('RSI'))} | "
            f"MACD={_fmt(macd.get('macd'))}/sig={_fmt(macd.get('signal'))}/hist={_fmt(macd.get('histogram'))} | "
            f"EMA20={_fmt(tdata.get('EMA20'))} EMA50={_fmt(tdata.get('EMA50'))} EMA200={_fmt(tdata.get('EMA200'))} | "
            f"BB=[{_fmt(bb.get('lower'))}, {_fmt(bb.get('middle'))}, {_fmt(bb.get('upper'))}] | "
            f"Stoch K/D={_fmt(stoch.get('k'))}/{_fmt(stoch.get('d'))} | "
            f"Rec={_fmt(tdata.get('recommendation'))}"
        )

    if market_data.get("errors"):
        lines.append("")
        lines.append("DATA WARNINGS: " + "; ".join(market_data["errors"]))

    # Balance sheet block (skipped when all values are None)
    bs = market_data.get("balance_sheet") or {}
    bs_vals = [
        bs.get("total_assets"), bs.get("total_liabilities"),
        bs.get("stockholders_equity"), bs.get("cash"),
    ]
    if any(v is not None for v in bs_vals):
        lines.append("")
        lines.append(f"BALANCE SHEET (most recent: {_fmt(bs.get('period'))})")
        lines.append(
            f"  Assets={_fmt(bs.get('total_assets'))} | "
            f"Liab={_fmt(bs.get('total_liabilities'))} | "
            f"Equity={_fmt(bs.get('stockholders_equity'))} | "
            f"Debt/Equity={_fmt(bs.get('debt_to_equity'))} | "
            f"Cash={_fmt(bs.get('cash'))}"
        )

    # Macro context block
    macro = market_data.get("macro") or {}
    if macro:
        spread = macro.get("yield_spread") or {}
        cape  = macro.get("shiller_cape") or {}
        inv   = " [INVERTED]" if spread.get("inverted") else ""
        lines.append("")
        lines.append("MACRO CONTEXT (US)")
        lines.append(
            f"  Fed Funds={_fmt(_v(macro, 'fed_funds_rate'))}% | "
            f"CPI YoY={_fmt(_v(macro, 'cpi_yoy'))}% | "
            f"Unemployment={_fmt(_v(macro, 'unemployment'))}% | "
            f"10y-2y={_fmt(_v(macro, 'yield_spread'))}{inv} | "
            f"Shiller CAPE={_fmt(cape.get('value'))}"
        )

    # Fundamentals P/E in prompt
    pe_trailing = fundamentals.get("trailing_pe") or fundamentals.get("pe_ratio")
    pe_forward  = fundamentals.get("forward_pe")
    if pe_trailing is not None or pe_forward is not None:
        lines.append("")
        lines.append("VALUATION")
        lines.append(
            f"  P/E (TTM)={_fmt(pe_trailing)} | P/E (Fwd)={_fmt(pe_forward)}"
        )

    if news:
        lines.append("")
        lines.append("RECENT NEWS HEADLINES")
        for item in news:
            # item is a dict with headline/source/url/datetime
            if isinstance(item, dict):
                headline = item.get("headline", "")
                src = f" ({item['source']})" if item.get("source") else ""
                lines.append(f"  - {headline}{src}")
            else:
                # Backward compat: plain string
                lines.append(f"  - {item}")

    lines.append("")
    lines.append(
        "Analyse the above and return the JSON object described in the system prompt."
    )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Ollama call
# --------------------------------------------------------------------------- #
def call_ollama(
    user_prompt: str,
    system_prompt: str = _SYSTEM_PROMPT,
    *,
    model: Optional[str] = None,
    ticker: Optional[str] = None,
) -> str:
    """Send a chat request to the local Ollama server and return raw content.

    Raises :class:`OllamaError` if the server is unreachable or errors.
    """

    settings = get_settings()

    # DB overrides let the UI change model/timeout without a container restart.
    _db_model   = _get_db_setting("ollama_model", "")
    _db_timeout = _get_db_setting("ollama_timeout", "")
    _model   = model or _db_model or settings.ollama.model
    _timeout = int(_db_timeout) if _db_timeout else settings.ollama.timeout

    payload = {
        "model": _model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.2},
    }

    _log.info(
        "ollama ▶ ticker=%s model=%s prompt_chars=%d\n%s",
        ticker or "?",
        _model,
        len(user_prompt),
        user_prompt,
    )

    with _tracer.start_as_current_span("llm.chat") as span:
        span.set_attribute("gen_ai.system", "ollama")
        span.set_attribute("gen_ai.request.model", _model)
        span.set_attribute("llm.ticker", ticker or "")
        span.set_attribute("gen_ai.system_prompt_chars", len(system_prompt))
        span.set_attribute("gen_ai.user_prompt_chars",   len(user_prompt))
        span.set_attribute("llm.prompt_chars", len(user_prompt))  # backward compat

        # Message sequence — always emit role+size events so the call structure
        # is visible in Aspire even when full text is suppressed.
        span.add_event("gen_ai.system.message", {
            "role": "system",
            "chars": len(system_prompt),
        })
        span.add_event("gen_ai.user.message", {
            "role": "user",
            "chars": len(user_prompt),
        })
        # Full text as child spans — visible as distinct bars in Aspire waterfall.
        # Gated behind OTEL_INCLUDE_LLM_CONTENT (default true in .env.example;
        # set false in production to prevent prompt storage in trace backends).
        if settings.otel.include_llm_content:
            with _tracer.start_as_current_span("llm.system_prompt") as _s:
                _s.set_attribute("role",    "system")
                _s.set_attribute("content", system_prompt)
                _s.set_attribute("chars",   len(system_prompt))
            with _tracer.start_as_current_span("llm.user_prompt") as _u:
                _u.set_attribute("role",    "user")
                _u.set_attribute("content", user_prompt)
                _u.set_attribute("chars",   len(user_prompt))

        t0 = time.monotonic()
        try:
            response = requests.post(
                settings.ollama.chat_url,
                json=payload,
                timeout=_timeout,
            )
        except requests.exceptions.ConnectionError as exc:
            span.set_attribute("error", str(exc))
            raise OllamaError(
                f"Cannot reach Ollama at {settings.ollama.host}. "
                "Is it running? Start it with `ollama serve` and "
                f"`ollama pull {_model}`."
            ) from exc
        except requests.exceptions.Timeout as exc:
            span.set_attribute("error", f"timeout after {_timeout}s")
            raise OllamaError(
                f"Ollama request timed out after {_timeout}s."
            ) from exc
        except requests.exceptions.RequestException as exc:  # pragma: no cover
            span.set_attribute("error", str(exc))
            raise OllamaError(f"Ollama request failed: {exc}") from exc

        latency = time.monotonic() - t0

        if response.status_code != 200:
            span.set_attribute("error", f"HTTP {response.status_code}")
            raise OllamaError(
                f"Ollama returned HTTP {response.status_code}: "
                f"{response.text[:300]}"
            )

        try:
            body = response.json()
        except ValueError as exc:
            span.set_attribute("error", "invalid JSON envelope")
            raise OllamaError(
                "Ollama response was not valid JSON envelope."
            ) from exc

        content = (body.get("message") or {}).get("content", "")
        if not content:
            span.set_attribute("error", "empty content")
            raise OllamaError("Ollama response contained no message content.")

        # Token counts and timing from Ollama response body.
        input_tokens  = body.get("prompt_eval_count") or 0
        output_tokens = body.get("eval_count") or 0
        ttft_s = round(
            (
                body.get("load_duration", 0)
                + body.get("prompt_eval_duration", 0)
            ) / 1e9,
            3,
        )
        total_latency_s = round(
            body.get("total_duration", 0) / 1e9, 3
        ) or round(latency, 2)

        span.set_attribute("llm.input_tokens",    input_tokens)
        span.set_attribute("llm.output_tokens",   output_tokens)
        span.set_attribute("llm.ttft_s",          ttft_s)
        span.set_attribute("llm.total_latency_s", total_latency_s)
        span.set_attribute("llm.response_chars",  len(content))

        # Always record the completion message structure as a span event.
        span.add_event("gen_ai.assistant.message", {
            "role": "assistant",
            "chars": len(content),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        })
        # Full response as a child span for easy inspection in Aspire.
        if settings.otel.include_llm_content:
            with _tracer.start_as_current_span("llm.assistant_response") as _a:
                _a.set_attribute("role",          "assistant")
                _a.set_attribute("content",       content)
                _a.set_attribute("chars",         len(content))
                _a.set_attribute("input_tokens",  input_tokens)
                _a.set_attribute("output_tokens", output_tokens)

        _log.info(
            "ollama ◀ ticker=%s model=%s latency=%.1fs "
            "in_tok=%d out_tok=%d ttft=%.2fs chars=%d\n%s",
            ticker or "?",
            _model,
            latency,
            input_tokens,
            output_tokens,
            ttft_s,
            len(content),
            content,
        )
        return content


# --------------------------------------------------------------------------- #
# Response parsing / normalisation
# --------------------------------------------------------------------------- #
def _coerce_float(value: Any) -> Optional[float]:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def parse_ai_response(content: str) -> Dict[str, Any]:
    """Parse and normalise the model's JSON string into our analysis schema."""

    text = content.strip()
    # Strip accidental markdown fences if the model added them.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    data = json.loads(text)  # may raise json.JSONDecodeError
    if not isinstance(data, dict):
        raise ValueError("AI response JSON was not an object.")

    normalised: Dict[str, Any] = {key: data.get(key) for key in _EXPECTED_KEYS}

    # Normalise the opportunity sub-object.
    opp = normalised.get("opportunity") or {}
    if not isinstance(opp, dict):
        opp = {}
    normalised["opportunity"] = {
        "type": (opp.get("type") or "none"),
        "confidence": _coerce_float(opp.get("confidence")) or 0.0,
        "entry": _coerce_float(opp.get("entry")),
        "stop": _coerce_float(opp.get("stop")),
        "target": _coerce_float(opp.get("target")),
    }

    # Ensure list-shaped fields are lists.
    for list_key in ("signals", "risk_factors"):
        if not isinstance(normalised.get(list_key), list):
            normalised[list_key] = [] if normalised.get(list_key) is None else [normalised[list_key]]

    if not isinstance(normalised.get("key_levels"), dict):
        normalised["key_levels"] = {"support": [], "resistance": []}

    return normalised


def analyze(
    market_data: Dict[str, Any],
    memory: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Full pipeline: prompt -> Ollama -> parsed analysis.

    Always returns a dict. On failure the dict contains ``error`` (and, when
    available, ``raw`` with the offending model output) instead of raising.

    Args:
        market_data: The full market-data dict from ``get_market_data()``.
        memory:      Optional per-ticker memory from :class:`~backend.memory.MemoryLayer`;
                     injected as a ``PRIOR CONTEXT`` section in the prompt.
    """

    ticker = market_data.get("ticker")
    prompt = build_prompt(market_data, memory=memory)

    try:
        raw = call_ollama(prompt, ticker=ticker)
    except OllamaError as exc:
        return {"ticker": ticker, "error": str(exc), "opportunity": None}

    try:
        parsed = parse_ai_response(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        return {
            "ticker": ticker,
            "error": f"Failed to parse AI JSON response: {exc}",
            "raw": raw,
            "opportunity": None,
        }

    parsed["ticker"] = ticker
    return parsed


if __name__ == "__main__":
    import sys

    from .data import get_market_data

    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    md = get_market_data(symbol)
    print(json.dumps(analyze(md), indent=2, default=str))
