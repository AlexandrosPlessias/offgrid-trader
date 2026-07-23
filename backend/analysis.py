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
from typing import Any, Dict, List, Optional

import requests

from .config import get_settings

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


def build_prompt(market_data: Dict[str, Any]) -> str:
    """Render *market_data* into a compact, readable prompt for the model."""

    price = market_data.get("price", {}) or {}
    fundamentals = market_data.get("fundamentals", {}) or {}
    technicals = market_data.get("technicals", {}) or {}

    lines: List[str] = []
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
) -> str:
    """Send a chat request to the local Ollama server and return raw content.

    Raises :class:`OllamaError` if the server is unreachable or errors.
    """

    settings = get_settings()
    payload = {
        "model": model or settings.ollama.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.2},
    }

    try:
        response = requests.post(
            settings.ollama.chat_url,
            json=payload,
            timeout=settings.ollama.timeout,
        )
    except requests.exceptions.ConnectionError as exc:
        raise OllamaError(
            f"Cannot reach Ollama at {settings.ollama.host}. "
            "Is it running? Start it with `ollama serve` and "
            f"`ollama pull {settings.ollama.model}`."
        ) from exc
    except requests.exceptions.Timeout as exc:
        raise OllamaError(f"Ollama request timed out after {settings.ollama.timeout}s.") from exc
    except requests.exceptions.RequestException as exc:  # pragma: no cover
        raise OllamaError(f"Ollama request failed: {exc}") from exc

    if response.status_code != 200:
        raise OllamaError(
            f"Ollama returned HTTP {response.status_code}: {response.text[:300]}"
        )

    try:
        body = response.json()
    except ValueError as exc:
        raise OllamaError("Ollama response was not valid JSON envelope.") from exc

    content = (body.get("message") or {}).get("content", "")
    if not content:
        raise OllamaError("Ollama response contained no message content.")
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


def analyze(market_data: Dict[str, Any]) -> Dict[str, Any]:
    """Full pipeline: prompt -> Ollama -> parsed analysis.

    Always returns a dict. On failure the dict contains ``error`` (and, when
    available, ``raw`` with the offending model output) instead of raising.
    """

    ticker = market_data.get("ticker")
    prompt = build_prompt(market_data)

    try:
        raw = call_ollama(prompt)
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
