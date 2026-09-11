"""Usage and quota routes: /usage, /provider/quota."""
from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from backend.config import get_settings
from backend.database import get_setting, get_usage_stats

router = APIRouter()


@router.get("/usage")
def usage_stats(
    days: int = Query(30, ge=1, le=365, description="Look-back window in days"),
) -> dict[str, Any]:
    """Aggregate LLM token usage from the analysis log.

    Returns totals and per-provider/per-day breakdowns for the last *days* days.
    Prompt and completion tokens are stored per analysis run — rows created before
    token tracking was added will contribute 0 to the totals (SQL NULL → 0).
    Also returns active_provider / active_model so the header chip can filter
    to the currently selected model's tokens.
    """
    stats = get_usage_stats(days=days)
    active_prov = get_setting("llm_provider") or None
    # DB model may be empty if the provider uses env-var config only; fall back to provider env var.
    _prov_env = f"{(active_prov or '').upper()}_MODEL"
    active_model = (
        get_setting("llm_model") or os.environ.get(_prov_env) or os.environ.get("LLM_MODEL") or None
    )
    stats["active_provider"] = active_prov
    stats["active_model"] = active_model
    return stats


@router.get("/provider/quota")
async def provider_quota() -> dict[str, Any]:
    """Live rate-limit and quota snapshot for the active cloud LLM provider.

    Makes a minimal API call to the configured provider and returns:
    - **groq**: rate-limit headers (``x-ratelimit-remaining-tokens``, etc.)
    - **mistral**: ``GET /v1/usage`` — monthly token consumption
    - **gemini**: no programmatic quota API on free tier — returns model limits
                  and a link to the Google AI Studio dashboard
    - **ollama / custom**: returns ``{"provider": "<name>", "quota": "n/a"}``

    Raises ``HTTP 400`` if no provider is configured, ``HTTP 502`` if the
    provider API call fails.
    """
    from backend.analysis import _effective_provider, _get_db_setting
    from backend.config import get_settings as _cfg

    provider = _effective_provider()
    settings = _cfg()

    if provider == "ollama":
        return {
            "provider": "ollama",
            "quota": "n/a",
            "note": "Ollama runs locally — no quota.",
        }

    if provider == "custom":
        return {
            "provider": "custom",
            "quota": "n/a",
            "note": "Custom provider — quota unknown.",
        }

    # Resolve API key (DB takes precedence over env).
    api_key = _get_db_setting("llm_api_key", "") or settings.llm.api_key_for(provider)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=f"No API key configured for provider '{provider}'. "
            "Set it via Settings → LLM Provider or the environment variable.",
        )

    import httpx

    # ------------------------------------------------------------------ groq
    if provider == "groq":
        # Groq exposes rate-limit state via response headers on any call.
        # We send a minimal 1-token prompt to a cheap model and harvest the headers.
        try:
            base_url = _get_db_setting("llm_base_url", "") or settings.llm.base_url_for(provider)
            resp = await asyncio.to_thread(
                lambda: httpx.post(
                    f"{base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "llama-3.1-8b-instant",
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                    timeout=15,
                )
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Groq quota probe failed: {exc}") from exc

        h = resp.headers
        return {
            "provider": "groq",
            "status_code": resp.status_code,
            "rate_limits": {
                "requests_limit": h.get("x-ratelimit-limit-requests"),
                "requests_remaining": h.get("x-ratelimit-remaining-requests"),
                "requests_reset": h.get("x-ratelimit-reset-requests"),
                "tokens_limit": h.get("x-ratelimit-limit-tokens"),
                "tokens_remaining": h.get("x-ratelimit-remaining-tokens"),
                "tokens_reset": h.get("x-ratelimit-reset-tokens"),
            },
            "note": "Rate-limit headers from a 1-token probe call to llama-3.1-8b-instant.",
        }

    # --------------------------------------------------------------- mistral
    if provider == "mistral":
        # Mistral does not expose a programmatic per-key usage/quota REST
        # endpoint in their v1 API.  Return static free-tier limits so the
        # pre-flight notifier still has something to show.
        return {
            "provider": "mistral",
            "quota": "static",
            "note": (
                "Mistral does not expose a usage API on the v1 path. "
                "Monitor consumption at https://console.mistral.ai/usage."
            ),
            "free_tier_limits": {
                "mistral-small-latest": {"rpm": 30, "tpm": 100_000, "rpd": 500},
                "mistral-large-latest": {"rpm": 30, "tpm": 100_000, "rpd": 500},
            },
        }

    # --------------------------------------------------------------- gemini
    if provider == "gemini":
        # Google AI Studio (free tier) has no programmatic quota REST endpoint.
        # Return the static free-tier limits and a dashboard link.
        return {
            "provider": "gemini",
            "quota": "static",
            "note": (
                "Google AI Studio free tier does not expose a programmatic quota API. "
                "Check your usage at https://aistudio.google.com/app/apikey"
            ),
            "free_tier_limits": {
                # Source: https://ai.google.dev/gemini-api/docs/rate-limits (free tier)
                "gemini-3.5-flash-lite": {"rpm": 15, "tpm": 1_000_000, "rpd": 1_500},
                "gemini-3.5-flash": {"rpm": 15, "tpm": 1_000_000, "rpd": 1_500},
                "gemini-2.0-flash": {"rpm": 15, "tpm": 1_000_000, "rpd": 1_500},
                "gemini-1.5-flash": {"rpm": 15, "tpm": 1_000_000, "rpd": 1_500},
                "gemini-1.5-flash-8b": {"rpm": 15, "tpm": 250_000, "rpd": 1_500},
                "gemini-1.5-pro": {"rpm": 2, "tpm": 32_000, "rpd": 50},
            },
            "dashboard_url": "https://aistudio.google.com/app/apikey",
        }

    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider!r}")
