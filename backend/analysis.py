"""AI analysis layer — routes to a local Ollama model or a cloud LLM provider.

Turns the unified market-data dict from :mod:`backend.data` into a structured
prompt, sends it to the configured LLM (Ollama, Groq, or a custom
OpenAI-compatible endpoint) and parses the JSON response into a normalised
analysis dict.

The active provider is controlled by the ``LLM_PROVIDER`` env var (default
``ollama``) or the ``llm_provider`` DB setting (set via the Settings page).
All failure modes (server unreachable, request timeout, malformed JSON) are
caught and returned as a structured error so callers never crash.

Run standalone::

    python -m backend.analysis AAPL
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path as _Path
from typing import Any

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

_PROMPTS_DIR = _Path(__file__).parent / "prompts"


def _load_prompt(filename: str) -> str:
    """Load a prompt file from the prompts/ directory at the project root."""
    return (_PROMPTS_DIR / filename).read_text(encoding="utf-8").strip()


# v2 signal analysis system prompt (replaces system_prompt.md).
_SYSTEM_PROMPT = _load_prompt("signal_scan_system.md")


# --------------------------------------------------------------------------- #
# JSON Schema validation + one-shot repair
# --------------------------------------------------------------------------- #
def _validate_llm_json(parsed: dict[str, Any], schema_name: str) -> list[str]:
    """Return a list of validation error messages; empty list means valid."""
    try:
        import jsonschema

        schema_path = _PROMPTS_DIR / "schemas" / schema_name
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
        return [e.message for e in validator.iter_errors(parsed)]
    except Exception as exc:  # schema file missing, import error, etc.
        _log.debug("_validate_llm_json skipped (%s): %s", schema_name, exc)
        return []


def _repair_llm_json(
    raw: str,
    errors: list[str],
    call_fn: Any,
    system_prompt: str | None = None,
) -> str:
    """One repair attempt: send the invalid JSON + validator errors back to the LLM.

    Pass ``system_prompt`` so the repair call uses the same task-specific
    instructions as the original call.  Without it the function falls back to
    the module-level signal-scan prompt, which causes the LLM to misinterpret
    backtest-compare or review payloads as signal-scan data.
    """
    error_lines = "\n".join(f"- {e}" for e in errors[:10])
    repair_prompt = (
        f"The following JSON failed schema validation:\n{raw}\n\n"
        f"Validation errors:\n{error_lines}\n\n"
        "Return the corrected JSON object only. Do not change any supported facts."
    )
    try:
        if system_prompt is not None:
            repaired, *_ = call_fn(repair_prompt, system_prompt)
        else:
            repaired, *_ = call_fn(repair_prompt)
        return repaired
    except Exception:
        return raw  # repair failed; caller handles the original raw


# --------------------------------------------------------------------------- #
# Candidate trade plan generation (signal scan v2)
# --------------------------------------------------------------------------- #
def _build_candidate_plans(
    market_data: dict[str, Any],
    atr_multiple: float = 1.5,
    reward_risk: float = 2.0,
) -> list[dict[str, Any]]:
    """Pre-compute long and short candidate trade plans for the LLM to select.

    Uses the 1D Bollinger Band width as an ATR proxy when a direct ATR value
    is not available in the market snapshot.
    """
    # "price" may be a plain float or a nested dict {"current": float, ...}
    _price_raw = market_data.get("price")
    if isinstance(_price_raw, dict):
        price = float(_price_raw.get("current") or 0)
    else:
        price = float(_price_raw or 0)
    if price <= 0:
        return []

    technicals = market_data.get("technicals") or {}
    td_1d = technicals.get("1d") or {}
    # bb_upper/bb_lower may be plain floats or nested dicts
    _bbu = td_1d.get("bb_upper")
    _bbl = td_1d.get("bb_lower")
    bb_upper = float(_bbu.get("upper") if isinstance(_bbu, dict) else _bbu or 0)
    bb_lower = float(_bbl.get("lower") if isinstance(_bbl, dict) else _bbl or 0)
    atr_est = (bb_upper - bb_lower) / 4 if (bb_upper > 0 and bb_lower > 0) else price * 0.02
    risk = atr_multiple * atr_est

    if risk <= 0:
        return []

    return [
        {
            "plan_id": "long_atr",
            "side": "long",
            "entry": round(price, 4),
            "stop": round(price - risk, 4),
            "target": round(price + reward_risk * risk, 4),
            "reward_risk": reward_risk,
        },
        {
            "plan_id": "short_atr",
            "side": "short",
            "entry": round(price, 4),
            "stop": round(price + risk, 4),
            "target": round(price - reward_risk * risk, 4),
            "reward_risk": reward_risk,
        },
    ]


class LLMError(RuntimeError):
    """Raised when any configured LLM provider cannot be reached or errors out."""


class QuotaError(LLMError):
    """Raised when a provider returns HTTP 429 or signals quota exhaustion.

    Subclass of :class:`LLMError` so existing broad ``except LLMError``
    call-sites still catch it; but :func:`call_llm` uses this narrower type
    to decide whether to try the fallback provider.
    """


class OllamaError(LLMError):
    """Raised when the local Ollama server cannot be reached or errors out.

    Subclass of :class:`LLMError` for backward compatibility — existing
    ``except OllamaError`` call-sites continue to work on the Ollama path.
    """


# --------------------------------------------------------------------------- #
# Prompt construction
# --------------------------------------------------------------------------- #
def _fmt(value: Any) -> str:
    return "n/a" if value is None else str(value)


def build_prompt(market_data: dict[str, Any], memory: dict[str, Any] | None = None) -> str:
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
    news: list[dict[str, Any]] = market_data.get("news") or []

    def _v(d: dict[str, Any], key: str) -> Any:
        """Extract .value from a nested {value, date} dict."""
        sub = (d or {}).get(key) or {}
        return sub.get("value") if isinstance(sub, dict) else None

    lines: list[str] = []

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
    lines.append(f"  MA5: {_fmt(price.get('ma5'))} | MA20: {_fmt(price.get('ma20'))}")
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
            f"MACD={_fmt(macd.get('macd'))}/sig={_fmt(macd.get('signal'))}"
            f"/hist={_fmt(macd.get('histogram'))} | "
            f"EMA20={_fmt(tdata.get('EMA20'))} EMA50={_fmt(tdata.get('EMA50'))}"
            f" EMA200={_fmt(tdata.get('EMA200'))} | "
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
        bs.get("total_assets"),
        bs.get("total_liabilities"),
        bs.get("stockholders_equity"),
        bs.get("cash"),
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
        cape = macro.get("shiller_cape") or {}
        inv = " [INVERTED]" if spread.get("inverted") else ""
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
    pe_forward = fundamentals.get("forward_pe")
    if pe_trailing is not None or pe_forward is not None:
        lines.append("")
        lines.append("VALUATION")
        lines.append(f"  P/E (TTM)={_fmt(pe_trailing)} | P/E (Fwd)={_fmt(pe_forward)}")

    if news:
        lines.append("")
        lines.append("RECENT NEWS HEADLINES")
        # Inject aggregate VADER sentiment so the model weighs it in context.
        sentiment = market_data.get("news_sentiment") or {}
        if sentiment.get("score") is not None:
            _score = sentiment["score"]
            _label = sentiment.get("label", "Neutral")
            _n_art = sentiment.get("article_count", 0)
            lines.append(
                f"  Aggregate sentiment: {_label} " f"(score={_score:+.3f}, n={_n_art} articles)"
            )
        for item in news:
            # item is a dict with headline/source/url/datetime
            if isinstance(item, dict):
                headline = item.get("headline", "")
                src = f" ({item['source']})" if item.get("source") else ""
                lines.append(f"  - {headline}{src}")
            else:
                # Backward compat: plain string
                lines.append(f"  - {item}")

    # Candidate trade plans (v2): pre-computed by backend; LLM selects one.
    _atr = float(_get_db_setting("atr_multiple")) if _get_db_setting("atr_multiple") else 1.5
    _rr = float(_get_db_setting("reward_risk")) if _get_db_setting("reward_risk") else 2.0
    candidates = _build_candidate_plans(market_data, atr_multiple=_atr, reward_risk=_rr)
    if candidates:
        lines.append("")
        lines.append("CANDIDATE TRADE PLANS (backend-generated; select one plan_id or null)")
        lines.append(json.dumps(candidates, separators=(",", ":")))

    # Closing instruction — provide request_id hints so the LLM can fill them.
    _ticker = market_data.get("ticker") or "UNKNOWN"
    _as_of = market_data.get("timestamp") or ""
    lines.append("")
    _closing = (
        "Return one JSON object using the REQUIRED OUTPUT SCHEMA in the system prompt. "
        f'Use request_id="{_ticker}-{_as_of}", ticker="{_ticker}", as_of="{_as_of}". '
        "Pick a plan_id from CANDIDATE TRADE PLANS or null."
    )
    lines.append(_closing)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Ollama call
# --------------------------------------------------------------------------- #
def call_ollama(
    user_prompt: str,
    system_prompt: str = _SYSTEM_PROMPT,
    *,
    model: str | None = None,
    ticker: str | None = None,
) -> tuple[str, str, int, int]:
    """Send a chat request to the local Ollama server and return raw content.

    Raises :class:`OllamaError` if the server is unreachable or errors.
    """

    settings = get_settings()

    # DB overrides let the UI change model/timeout without a container restart.
    _db_model = _get_db_setting("ollama_model", "")
    _db_timeout = _get_db_setting("ollama_timeout", "")
    _model = model or _db_model or settings.ollama.model
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
        span.set_attribute("gen_ai.user_prompt_chars", len(user_prompt))
        span.set_attribute("llm.prompt_chars", len(user_prompt))  # backward compat

        # Message sequence — always emit role+size events so the call structure
        # is visible in Aspire even when full text is suppressed.
        span.add_event(
            "gen_ai.system.message",
            {
                "role": "system",
                "chars": len(system_prompt),
            },
        )
        span.add_event(
            "gen_ai.user.message",
            {
                "role": "user",
                "chars": len(user_prompt),
            },
        )
        # Full text as child spans — visible as distinct bars in Aspire waterfall.
        # Gated behind OTEL_INCLUDE_LLM_CONTENT (default true in .env.example;
        # set false in production to prevent prompt storage in trace backends).
        if settings.otel.include_llm_content:
            with _tracer.start_as_current_span("llm.system_prompt") as _s:
                _s.set_attribute("role", "system")
                _s.set_attribute("content", system_prompt)
                _s.set_attribute("chars", len(system_prompt))
            with _tracer.start_as_current_span("llm.user_prompt") as _u:
                _u.set_attribute("role", "user")
                _u.set_attribute("content", user_prompt)
                _u.set_attribute("chars", len(user_prompt))

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
            raise OllamaError(f"Ollama request timed out after {_timeout}s.") from exc
        except requests.exceptions.RequestException as exc:  # pragma: no cover
            span.set_attribute("error", str(exc))
            raise OllamaError(f"Ollama request failed: {exc}") from exc

        latency = time.monotonic() - t0

        if response.status_code == 429:
            span.set_attribute("error", "HTTP 429 rate-limit")
            raise QuotaError(f"Ollama rate-limit (HTTP 429): {response.text[:200]}")
        if response.status_code != 200:
            span.set_attribute("error", f"HTTP {response.status_code}")
            raise OllamaError(
                f"Ollama returned HTTP {response.status_code}: " f"{response.text[:300]}"
            )

        try:
            body = response.json()
        except ValueError as exc:
            span.set_attribute("error", "invalid JSON envelope")
            raise OllamaError("Ollama response was not valid JSON envelope.") from exc

        content = (body.get("message") or {}).get("content", "")
        if not content:
            span.set_attribute("error", "empty content")
            raise OllamaError("Ollama response contained no message content.")

        # Token counts and timing from Ollama response body.
        input_tokens = body.get("prompt_eval_count") or 0
        output_tokens = body.get("eval_count") or 0
        ttft_s = round(
            (body.get("load_duration", 0) + body.get("prompt_eval_duration", 0)) / 1e9,
            3,
        )
        total_latency_s = round(body.get("total_duration", 0) / 1e9, 3) or round(latency, 2)

        span.set_attribute("llm.input_tokens", input_tokens)
        span.set_attribute("llm.output_tokens", output_tokens)
        span.set_attribute("llm.ttft_s", ttft_s)
        span.set_attribute("llm.total_latency_s", total_latency_s)
        span.set_attribute("llm.response_chars", len(content))

        # Always record the completion message structure as a span event.
        span.add_event(
            "gen_ai.assistant.message",
            {
                "role": "assistant",
                "chars": len(content),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        )
        # Full response as a child span for easy inspection in Aspire.
        if settings.otel.include_llm_content:
            with _tracer.start_as_current_span("llm.assistant_response") as _a:
                _a.set_attribute("role", "assistant")
                _a.set_attribute("content", content)
                _a.set_attribute("chars", len(content))
                _a.set_attribute("input_tokens", input_tokens)
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
        return (
            content,
            _model,
            input_tokens,
            output_tokens,
        )  # (raw, model, in_tok, out_tok)


# --------------------------------------------------------------------------- #
# Cloud LLM call (Groq or any OpenAI-compatible endpoint)
# --------------------------------------------------------------------------- #
def call_cloud_llm(
    user_prompt: str,
    system_prompt: str = _SYSTEM_PROMPT,
    *,
    model: str | None = None,
    ticker: str | None = None,
) -> tuple[str, str, int, int]:
    """Send a chat request to a cloud OpenAI-compatible endpoint.

    Reads provider / api_key / base_url from DB settings first, then falls
    back to env-var config (``settings.llm``).

    Returns ``(raw_content, model_used)``.
    Raises :class:`LLMError` on connectivity, auth, or HTTP errors.
    """
    try:
        import openai as _openai  # lazy import — optional dependency
    except ImportError as exc:  # pragma: no cover
        raise LLMError(
            "The 'openai' package is required for cloud LLM providers. "
            "Add it to requirements/backend.txt and rebuild the container."
        ) from exc

    settings = get_settings()

    # DB settings take precedence over env vars (same pattern as ollama_model).
    _db_provider = _get_db_setting("llm_provider", "")
    _db_api_key = _get_db_setting("llm_api_key", "")
    _db_model = _get_db_setting("llm_model", "")
    _db_base_url = _get_db_setting("llm_base_url", "")
    _db_timeout = _get_db_setting("ollama_timeout", "")  # reuse existing UI knob
    _db_reasoning_effort = _get_db_setting("llm_reasoning_effort", "none")

    provider = _db_provider or settings.llm.provider
    api_key = _db_api_key or settings.llm.api_key_for(provider)
    base_url = _db_base_url or settings.llm.base_url_for(provider)
    _model = model or _db_model or settings.llm.default_model_for(provider)
    _timeout = int(_db_timeout) if _db_timeout else settings.llm.cloud_timeout

    if not api_key:
        raise LLMError(
            f"No API key configured for provider '{provider}'. "
            "Set it via the Settings page or the relevant env var "
            "(GROQ_API_KEY / LLM_API_KEY)."
        )
    if not base_url:
        raise LLMError(
            f"No base URL found for provider '{provider}'. "
            "Use LLM_PROVIDER=groq or set LLM_BASE_URL for a custom endpoint."
        )

    _log.info(
        "cloud_llm ▶ provider=%s ticker=%s model=%s prompt_chars=%d",
        provider,
        ticker or "?",
        _model,
        len(user_prompt),
    )

    client = _openai.OpenAI(api_key=api_key, base_url=base_url, timeout=_timeout)

    with _tracer.start_as_current_span("llm.chat") as span:
        span.set_attribute("gen_ai.system", provider)
        span.set_attribute("gen_ai.request.model", _model)
        span.set_attribute("llm.ticker", ticker or "")
        span.set_attribute("gen_ai.system_prompt_chars", len(system_prompt))
        span.set_attribute("gen_ai.user_prompt_chars", len(user_prompt))
        span.set_attribute("llm.prompt_chars", len(user_prompt))

        span.add_event("gen_ai.system.message", {"role": "system", "chars": len(system_prompt)})
        span.add_event("gen_ai.user.message", {"role": "user", "chars": len(user_prompt)})

        if settings.otel.include_llm_content:
            with _tracer.start_as_current_span("llm.system_prompt") as _s:
                _s.set_attribute("role", "system")
                _s.set_attribute("content", system_prompt)
                _s.set_attribute("chars", len(system_prompt))
            with _tracer.start_as_current_span("llm.user_prompt") as _u:
                _u.set_attribute("role", "user")
                _u.set_attribute("content", user_prompt)
                _u.set_attribute("chars", len(user_prompt))

        t0 = time.monotonic()
        try:
            request = {
                "model": _model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2,
            }
            if provider in ("groq", "gemini", "mistral", "custom"):
                request["response_format"] = {"type": "json_object"}
            if provider in ("groq", "mistral"):
                request["reasoning_effort"] = _db_reasoning_effort
            elif provider == "gemini" and _db_reasoning_effort != "none":
                # Gemini only accepts reasoning_effort="none" on 2.5 models; sending
                # it at all is optional, so only include the field when the user has
                # explicitly chosen a non-default value (avoids 400 INVALID_ARGUMENT
                # on Gemini 3.x / other models where reasoning can't be disabled).
                request["reasoning_effort"] = _db_reasoning_effort
            completion = client.chat.completions.create(**request)
        except _openai.APITimeoutError as exc:
            # Must come before APIConnectionError — Timeout is a subclass of Connection.
            span.set_attribute("error", f"timeout after {_timeout}s")
            raise LLMError(f"{provider} request timed out after {_timeout}s.") from exc
        except _openai.APIConnectionError as exc:
            span.set_attribute("error", str(exc))
            raise LLMError(
                f"Cannot reach {provider} API ({base_url}). "
                "Check your internet connection and the provider's status page."
            ) from exc
        except _openai.AuthenticationError as exc:
            span.set_attribute("error", "authentication failed")
            raise LLMError(f"{provider} authentication failed — check your API key.") from exc
        except _openai.RateLimitError as exc:
            # Must come before APIStatusError — RateLimitError is a subclass of it.
            span.set_attribute("error", "HTTP 429 rate-limit / quota")
            raise QuotaError(
                f"{provider} quota/rate-limit (HTTP 429): {exc.message[:300]}"
            ) from exc
        except _openai.APIStatusError as exc:
            span.set_attribute("error", f"HTTP {exc.status_code}")
            raise LLMError(
                f"{provider} returned HTTP {exc.status_code}: {exc.message[:300]}"
            ) from exc
        latency = time.monotonic() - t0

        content = (completion.choices[0].message.content or "").strip()
        if not content:
            span.set_attribute("error", "empty content")
            raise LLMError(f"{provider} response contained no message content.")

        usage = completion.usage
        input_tokens = usage.prompt_tokens if usage else 0
        output_tokens = usage.completion_tokens if usage else 0
        ttft_s = round(latency, 3)  # cloud APIs don't expose TTFT separately
        total_latency_s = round(latency, 2)

        span.set_attribute("llm.input_tokens", input_tokens)
        span.set_attribute("llm.output_tokens", output_tokens)
        span.set_attribute("llm.ttft_s", ttft_s)
        span.set_attribute("llm.total_latency_s", total_latency_s)
        span.set_attribute("llm.response_chars", len(content))

        span.add_event(
            "gen_ai.assistant.message",
            {
                "role": "assistant",
                "chars": len(content),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        )
        if settings.otel.include_llm_content:
            with _tracer.start_as_current_span("llm.assistant_response") as _a:
                _a.set_attribute("role", "assistant")
                _a.set_attribute("content", content)
                _a.set_attribute("chars", len(content))
                _a.set_attribute("input_tokens", input_tokens)
                _a.set_attribute("output_tokens", output_tokens)

        _log.info(
            "cloud_llm ◀ provider=%s ticker=%s model=%s latency=%.1fs "
            "in_tok=%d out_tok=%d chars=%d",
            provider,
            ticker or "?",
            _model,
            latency,
            input_tokens,
            output_tokens,
            len(content),
        )
        return (
            content,
            _model,
            input_tokens,
            output_tokens,
        )  # (raw, model, in_tok, out_tok)


# --------------------------------------------------------------------------- #
# LLM dispatcher — routes to the configured provider
# --------------------------------------------------------------------------- #
def _effective_provider() -> str:
    """Return the active LLM provider, DB setting takes precedence over env."""
    db_val = _get_db_setting("llm_provider", "")
    return db_val or get_settings().llm.provider


def _call_provider(
    provider: str,
    user_prompt: str,
    system_prompt: str,
    model: str | None,
    ticker: str | None,
) -> tuple[str, str, int, int]:
    """Dispatch a single call to *provider*.  Raises :class:`LLMError` on failure."""
    if provider == "ollama":
        return call_ollama(user_prompt, system_prompt, model=model, ticker=ticker)
    if provider in ("groq", "gemini", "mistral", "custom"):
        return call_cloud_llm(user_prompt, system_prompt, model=model, ticker=ticker)
    raise LLMError(
        f"Unknown LLM_PROVIDER={provider!r}. Valid values: ollama, groq, gemini, mistral, custom."
    )


def call_llm(
    user_prompt: str,
    system_prompt: str = _SYSTEM_PROMPT,
    *,
    model: str | None = None,
    ticker: str | None = None,
    use_fallback: bool = True,
) -> tuple[str, str, int, int]:
    """Route to the configured LLM provider.

    Returns ``(raw_content, model_used, prompt_tokens, completion_tokens)``.
    Raises :class:`LLMError` on provider failure.

    When ``use_fallback=True`` (the default) the call tries the primary
    provider first; on a :class:`QuotaError` (HTTP 429 / quota exhausted) it
    automatically retries with the fallback provider resolved from:
      1. DB keys ``llm_fallback_provider`` / ``llm_fallback_model``
      2. Env vars ``LLM_FALLBACK_PROVIDER`` / ``LLM_FALLBACK_MODEL``
    Non-quota :class:`LLMError` values (auth failure, network error, bad JSON)
    are re-raised immediately — only quota errors trigger the chain.
    If all providers in the chain fail, the last :class:`QuotaError` is re-raised.
    """
    primary_provider = _effective_provider()

    # Resolve fallback: DB first, then env-var (via LLMConfig fields).
    fallback_provider = (
        _get_db_setting("llm_fallback_provider", "") or get_settings().llm.fallback_provider
    )
    fallback_model = (
        _get_db_setting("llm_fallback_model", "") or get_settings().llm.fallback_model
    ) or None

    chain: list[tuple[str, str | None]] = [(primary_provider, model)]
    if use_fallback and fallback_provider and fallback_provider != primary_provider:
        chain.append((fallback_provider, fallback_model))

    last_exc: LLMError = LLMError("No providers configured.")
    for prov, mdl in chain:
        try:
            return _call_provider(prov, user_prompt, system_prompt, mdl, ticker)
        except QuotaError as exc:
            # Only quota errors flow to the next provider; all other LLMErrors propagate.
            _log.warning("call_llm: provider %r quota hit (%s), trying next in chain.", prov, exc)
            last_exc = exc
        except LLMError:
            raise  # auth failures, network errors, bad JSON — fail fast
    raise last_exc


# --------------------------------------------------------------------------- #
# Response parsing / normalisation
# --------------------------------------------------------------------------- #
def _coerce_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def parse_ai_response(
    content: str,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Parse and normalise the model's JSON string into our analysis schema.

    Handles both the v2 ``SignalAnalysisV2`` schema (``decision`` + ``selected_plan_id``)
    and the legacy v1 schema (``opportunity.type`` + ``opportunity.entry``).
    When *candidates* is supplied the selected plan is resolved to entry/stop/target.
    """

    text = content.strip()
    # Strip accidental markdown fences if the model added them.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    data = json.loads(text)  # may raise json.JSONDecodeError
    if not isinstance(data, dict):
        raise TypeError("AI response JSON was not an object.")

    # ── Detect v2 schema (has "decision" key) ────────────────────────────── #
    if "decision" in data:
        decision = (data.get("decision") or "none").lower()
        # v2 uses confidence_raw (int 20-90); fall back to confidence for any older output
        confidence_raw = data.get("confidence_raw") or data.get("confidence") or 0
        confidence = float(confidence_raw)
        plan_id = data.get("selected_plan_id")

        # Resolve the selected plan to concrete levels.
        plan: dict[str, Any] = {}
        if plan_id and candidates:
            plan = next((c for c in candidates if c.get("plan_id") == plan_id), {})

        # evidence[].observation → signals list (backward compat)
        evidence = data.get("evidence") or []
        signals = [
            e.get("observation") or e.get("text") or str(e) for e in evidence if isinstance(e, dict)
        ] or [str(e) for e in evidence]

        # risks[].observation → risk_factors list  (schema uses "risks", not "risk_items")
        risks = data.get("risks") or data.get("risk_items") or []
        risk_factors = [
            r.get("observation") or r.get("text") or str(r) for r in risks if isinstance(r, dict)
        ] or [str(r) for r in risks]

        return {
            # Legacy-compatible fields (Explorer still reads these)
            "trend": data.get("trend") or "neutral",
            "momentum": data.get("momentum") or "neutral",
            "key_levels": data.get("key_levels") or {"support": [], "resistance": []},
            "signals": signals,
            "risk_factors": risk_factors,
            "opportunity": {
                "type": decision,
                "confidence": confidence,
                "entry": _coerce_float(plan.get("entry")),
                "stop": _coerce_float(plan.get("stop")),
                "target": _coerce_float(plan.get("target")),
            },
            # v2 extra fields passed through as-is
            "schema_version": data.get("schema_version"),
            "status": data.get("status"),
            "confidence_band": data.get("confidence_band"),
            "confidence_raw": confidence_raw,
            "reason_code": data.get("reason_code"),
            "data_quality": data.get("data_quality"),
            "evidence": evidence,
            "risks": risks,
            "selected_plan_id": plan_id,
            "summary": data.get("summary"),
        }

    # ── Legacy v1 schema ─────────────────────────────────────────────────── #
    normalised: dict[str, Any] = {key: data.get(key) for key in _EXPECTED_KEYS}

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

    for list_key in ("signals", "risk_factors"):
        if not isinstance(normalised.get(list_key), list):
            normalised[list_key] = (
                [] if normalised.get(list_key) is None else [normalised[list_key]]
            )

    if not isinstance(normalised.get("key_levels"), dict):
        normalised["key_levels"] = {"support": [], "resistance": []}

    return normalised


def analyze(
    market_data: dict[str, Any],
    memory: dict[str, Any] | None = None,
    *,
    use_fallback: bool = False,
) -> dict[str, Any]:
    """Full pipeline: prompt -> LLM (local or cloud) -> parsed analysis.

    Always returns a dict. On failure the dict contains ``error`` (and, when
    available, ``raw`` with the offending model output) instead of raising.

    The returned dict always includes ``llm_provider`` and ``llm_model`` keys
    so callers can display which model produced the analysis.

    Args:
        market_data:  The full market-data dict from ``get_market_data()``.
        memory:       Optional per-ticker memory from :class:`~backend.memory.MemoryLayer`;
                      injected as a ``PRIOR CONTEXT`` section in the prompt.
        use_fallback: When ``True``, automatically retries with the configured
                      fallback provider on any :class:`LLMError`.  Pass
                      ``True`` inside the backtesting engine to recover from
                      quota exhaustion mid-run.
    """

    ticker = market_data.get("ticker")
    provider = _effective_provider()

    # Pre-compute candidate plans before building the prompt (v2 architecture).
    _atr_mult = float(_get_db_setting("atr_multiple")) if _get_db_setting("atr_multiple") else 1.5
    _rr = float(_get_db_setting("reward_risk")) if _get_db_setting("reward_risk") else 2.0
    candidates = _build_candidate_plans(market_data, atr_multiple=_atr_mult, reward_risk=_rr)

    prompt = build_prompt(market_data, memory=memory)

    try:
        raw, model_used, prompt_tokens, completion_tokens = call_llm(
            prompt, ticker=ticker, use_fallback=use_fallback
        )
    except LLMError as exc:
        return {
            "ticker": ticker,
            "error": str(exc),
            "opportunity": None,
            "llm_provider": provider,
            "llm_model": "",
            "prompt_tokens": 0,
            "completion_tokens": 0,
        }

    try:
        parsed = parse_ai_response(raw, candidates=candidates)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        return {
            "ticker": ticker,
            "error": f"Failed to parse AI JSON response: {exc}",
            "raw": raw,
            "opportunity": None,
            "llm_provider": provider,
            "llm_model": model_used,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        }

    # Schema validation + one-shot repair for v2 responses.
    # Validate the raw LLM JSON (not the normalized dict, which has extra compat keys).
    if parsed.get("schema_version"):
        try:
            _r = raw.strip()
            _r = _r.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            raw_parsed = json.loads(_r)
        except Exception:
            raw_parsed = None
        if raw_parsed is not None:
            errs = _validate_llm_json(raw_parsed, "signal_analysis.schema.json")
            if errs:
                _log.warning("signal v2 schema errors for %s: %s", ticker, errs)
                try:
                    repaired_raw = _repair_llm_json(raw, errs, call_llm)
                    parsed = parse_ai_response(repaired_raw, candidates=candidates)
                except Exception:  # noqa: S110
                    pass  # use original parsed on repair failure

    parsed["ticker"] = ticker
    parsed["llm_provider"] = provider
    parsed["llm_model"] = model_used
    parsed["prompt_tokens"] = prompt_tokens
    parsed["completion_tokens"] = completion_tokens
    return parsed


if __name__ == "__main__":
    import sys

    from .data import get_market_data

    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    md = get_market_data(symbol)
    print(json.dumps(analyze(md), indent=2, default=str))
