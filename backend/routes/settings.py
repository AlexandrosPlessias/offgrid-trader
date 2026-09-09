"""Settings routes: /settings* (non-alpaca, non-discovery)."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import get_setting, set_setting
from backend.scheduler import scheduler
from backend.routes._models import _alerts_enabled

router = APIRouter()
_log = logging.getLogger(__name__)


class AlertsSettingRequest(BaseModel):
    enabled: bool = Field(..., description="Enable or disable alert dispatch")


class OllamaSettingRequest(BaseModel):
    model: str | None = Field(None, description="Ollama model tag, e.g. qwen2.5:7b")
    timeout: int | None = Field(
        None, ge=10, le=3600, description="Request timeout in seconds (10-3600)"
    )


class LLMSettingRequest(BaseModel):
    provider: str | None = Field(
        None, description="LLM provider: ollama | groq | gemini | mistral | custom"
    )
    api_key: str | None = Field(None, description="API key for cloud providers")
    model: str | None = Field(None, description="Model override (empty = provider default)")
    base_url: str | None = Field(None, description="Custom base URL (used when provider=custom)")
    reasoning_effort: str | None = Field(
        None,
        description="Reasoning effort for models that support it: none | low | medium | high",
    )
    fallback_provider: str | None = Field(
        None,
        description="Fallback provider used automatically on HTTP 429 / quota errors",
    )
    fallback_model: str | None = Field(
        None, description="Fallback model override (empty = fallback provider default)"
    )


class SchedulerSettingRequest(BaseModel):
    running: bool = Field(..., description="True to start the scheduler, False to stop it")


class ScanIntervalRequest(BaseModel):
    minutes: int = Field(..., ge=1, le=1440, description="Scan interval in minutes (1-1440)")


class SignalScanLlmRequest(BaseModel):
    enabled: bool


@router.post("/settings/alerts")
def set_alerts(request: AlertsSettingRequest) -> dict[str, Any]:
    set_setting("alerts_enabled", "true" if request.enabled else "false")
    return {"alerts_enabled": request.enabled}


@router.post("/settings/scheduler")
async def set_scheduler(request: SchedulerSettingRequest) -> dict[str, Any]:
    """Start or stop the background scheduler at runtime.

    State is persisted to the DB so it survives container restarts.
    """
    set_setting("scheduler_running", "true" if request.running else "false")
    if request.running:
        scheduler.start()
    else:
        await scheduler.stop()
    return scheduler.status()


@router.post("/settings/scan-interval")
def set_scan_interval(request: ScanIntervalRequest) -> dict[str, Any]:
    """Update the scan interval (persisted to DB; takes effect on next loop cycle)."""
    set_setting("scan_interval_minutes", str(request.minutes))
    return scheduler.status()


@router.post("/settings/signal-scan-llm")
def set_signal_scan_llm(request: SignalScanLlmRequest) -> dict[str, Any]:
    """Enable or disable LLM calls for live signal scanning.

    When disabled the AI-analysis skill is skipped and the pipeline runs
    in rules-only mode — no LLM API quota is consumed by the scheduler.
    Takes effect immediately (no restart required).
    """
    set_setting("signal_scan_llm_enabled", "true" if request.enabled else "false")
    return {"signal_scan_llm_enabled": request.enabled}


@router.get("/settings")
def get_all_settings(provider: str | None = Query(None)) -> dict[str, Any]:
    """Return current effective settings (env defaults overridden by DB values)."""
    cfg = get_settings()
    db_model = get_setting("ollama_model", "")
    db_timeout = get_setting("ollama_timeout", "")
    db_provider = get_setting("llm_provider", "")
    db_llm_api_key = get_setting("llm_api_key", "")
    db_llm_model = get_setting("llm_model", "")
    db_llm_base_url = get_setting("llm_base_url", "")
    db_reasoning_effort = get_setting("llm_reasoning_effort", "")
    provider = provider or db_provider or cfg.llm.provider
    return {
        # LLM provider settings (new)
        "llm_provider": provider,
        "llm_model": db_llm_model or cfg.llm.default_model_for(provider),
        "llm_base_url": db_llm_base_url or cfg.llm.base_url_for(provider),
        "llm_api_key_set": bool(db_llm_api_key or cfg.llm.api_key_for(provider)),
        "llm_reasoning_effort": db_reasoning_effort or "none",
        # Fallback provider — resolved from DB, then env var.
        "llm_fallback_provider": (
            get_setting("llm_fallback_provider", "") or cfg.llm.fallback_provider
        ),
        "llm_fallback_model": (get_setting("llm_fallback_model", "") or cfg.llm.fallback_model),
        # Env-only defaults (ignore DB overrides) — used by the Settings page to
        # show what ".env defaults" actually resolve to for the *selected* provider.
        "llm_model_env_default": cfg.llm.default_model_for(provider),
        "llm_base_url_env_default": cfg.llm.base_url_for(provider),
        "llm_api_key_env_set": bool(cfg.llm.api_key_for(provider)),
        # Ollama-specific (kept for backward compat)
        "ollama_model": db_model or cfg.ollama.model,
        "ollama_timeout": int(db_timeout) if db_timeout else cfg.ollama.timeout,
        "env_model": cfg.ollama.model,
        "env_timeout": cfg.ollama.timeout,
        # Other settings (unchanged)
        "alerts_enabled": _alerts_enabled(),
        "scan_interval_minutes": scheduler.status()["scan_interval_minutes"],
        "scheduler_running": scheduler.status()["running"],
        # Signal-scan LLM switch — default True (enabled) if never explicitly set.
        "signal_scan_llm_enabled": get_setting("signal_scan_llm_enabled", "true") != "false",
        # Alpaca paper trading
        "alpaca_paper_url": (get_setting("alpaca_paper_url", "") or cfg.alpaca.paper_url),
        # Key ID is not secret (analogous to a username) — safe to return in plain text
        # so the Settings page can pre-fill the input field on load.
        "alpaca_key_id": (get_setting("alpaca_key_id", "") or cfg.alpaca.key_id),
        "alpaca_key_id_set": bool(get_setting("alpaca_key_id", "") or cfg.alpaca.key_id),
        "alpaca_secret_set": bool(get_setting("alpaca_secret_key", "") or cfg.alpaca.secret_key),
        # Env-only flags: True when the .env variable is non-empty (DB not considered).
        # Used by the Settings UI to offer "Load Environment Default Values".
        "alpaca_key_id_env_set": bool(cfg.alpaca.key_id),
        "alpaca_secret_env_set": bool(cfg.alpaca.secret_key),
        "paper_trading_enabled": get_setting("paper_trading_enabled", "true") == "true",
        "paper_trade_position_size": float(get_setting("paper_trade_position_size", "") or 500),
        "paper_trade_min_confidence": (
            float(get_setting("paper_trade_min_confidence", ""))
            if get_setting("paper_trade_min_confidence", "")
            else None
        ),
    }


@router.post("/settings/ollama")
def set_ollama_settings(request: OllamaSettingRequest) -> dict[str, Any]:
    """Persist Ollama model and/or timeout to the DB (no restart required).

    Returns HTTP 404 when LLM_PROVIDER is not 'ollama' — use POST /settings/llm
    to configure cloud providers.
    """
    cfg = get_settings()
    provider = get_setting("llm_provider", "") or cfg.llm.provider
    if provider != "ollama":
        raise HTTPException(
            status_code=404,
            detail=(
                f"Ollama settings are not applicable when LLM_PROVIDER='{provider}'. "
                "Use POST /settings/llm to configure cloud LLM providers, "
                "or set LLM_PROVIDER=ollama to switch back to local Ollama."
            ),
        )
    if request.model is not None:
        set_setting("ollama_model", request.model)
    if request.timeout is not None:
        set_setting("ollama_timeout", str(request.timeout))
    db_model = get_setting("ollama_model", "")
    db_timeout = get_setting("ollama_timeout", "")
    return {
        "ollama_model": db_model or cfg.ollama.model,
        "ollama_timeout": int(db_timeout) if db_timeout else cfg.ollama.timeout,
    }


@router.post("/settings/llm")
def set_llm_settings(request: LLMSettingRequest) -> dict[str, Any]:
    """Persist LLM provider settings to the DB (no restart required).

    All fields are optional; only the supplied fields are updated.
    The API key is stored in the DB and never returned in GET /settings
    (only ``llm_api_key_set: true/false`` is exposed).
    """
    valid_providers = {"ollama", "groq", "gemini", "mistral", "custom"}
    if request.provider is not None:
        if request.provider not in valid_providers:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid provider '{request.provider}'. Valid: {sorted(valid_providers)}",
            )
        set_setting("llm_provider", request.provider)
    if request.api_key is not None:
        set_setting("llm_api_key", request.api_key)
    if request.model is not None:
        set_setting("llm_model", request.model)
    if request.base_url is not None:
        set_setting("llm_base_url", request.base_url)
    if request.reasoning_effort is not None:
        valid_reasoning = {"none", "low", "medium", "high"}
        if request.reasoning_effort not in valid_reasoning:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid reasoning_effort '{request.reasoning_effort}'. "
                    f"Valid: {sorted(valid_reasoning)}"
                ),
            )
        set_setting("llm_reasoning_effort", request.reasoning_effort)
    if request.fallback_provider is not None:
        valid_fallback = {"", "ollama", "groq", "gemini", "mistral", "custom"}
        if request.fallback_provider not in valid_fallback:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid fallback_provider '{request.fallback_provider}'. "
                    f"Valid: {sorted(valid_fallback - {''})}"
                ),
            )
        set_setting("llm_fallback_provider", request.fallback_provider)
    if request.fallback_model is not None:
        set_setting("llm_fallback_model", request.fallback_model)
    return {
        "ok": True,
        "provider": get_setting("llm_provider", "") or get_settings().llm.provider,
    }


@router.get("/settings/models")
def list_llm_models(provider: str | None = Query(None)) -> dict[str, Any]:
    """Return available models for the active LLM provider.

    For Ollama: queries the local /api/tags endpoint.
    For cloud providers: returns a static list of known free-tier models.
    """
    import requests as _req

    cfg = get_settings()
    provider = provider or get_setting("llm_provider", "") or cfg.llm.provider

    if provider != "ollama":
        # Static list of known free-tier models per provider.
        cloud_models: dict[str, list[str]] = {
            "groq": [
                "qwen/qwen3.6-27b",
            ],
            "gemini": [
                "gemini-3.5-flash-lite",
                "gemini-3.5-flash",
            ],
            "mistral": [
                "mistral-small-latest",
                "mistral-large-latest",
            ],
            "custom": [],
        }
        active = get_setting("llm_model", "") or cfg.llm.default_model_for(provider)
        return {
            "provider": provider,
            "models": cloud_models.get(provider, []),
            "active": active,
        }

    # Ollama — query local /api/tags
    try:
        resp = _req.get(f"{cfg.ollama.host}/api/tags", timeout=5)
        resp.raise_for_status()
        models = [
            m["name"]
            for m in resp.json().get("models", [])
            if not any(
                marker in m["name"].lower()
                for marker in ("embed", "embedding", "bge-", "nomic-embed")
            )
        ]
    except Exception as exc:
        models = []
        _log.warning("ollama /api/tags failed: %s", exc)
    return {"provider": "ollama", "models": models}


@router.get("/settings/performance")
def get_performance_settings() -> dict[str, Any]:
    """Return current parallelism settings and provider rate-limit reference."""
    from backend.config import get_settings as _cfg
    from backend.database import get_setting

    cfg = _cfg()
    concurrent_tickers = int(get_setting("concurrent_tickers") or 0) or cfg.concurrent_tickers
    concurrent_llm = int(get_setting("concurrent_llm") or 0) or cfg.concurrent_llm

    return {
        "concurrent_tickers": concurrent_tickers,
        "concurrent_llm": concurrent_llm,
        "rate_limits": {
            "yfinance": {
                "note": "No official rate limit. 3-4 concurrent requests are safe. "
                "Permanent cache means most calls are instant after first run.",
                "recommended_concurrent": 4,
            },
            "finnhub": {
                "free_tier_rpm": 60,
                "note": "Date-keyed cache means 1 network call per ticker per day max.",
            },
            "llm_providers": {
                "gemini_free": {"rpm": 15, "rpd": 1500, "tpm": 1_000_000},
                "groq": {"rpm": 30, "note": "Varies by model; check Groq console."},
                "openai": {"note": "Tier-dependent; check platform.openai.com/usage."},
                "mistral": {"rpm": 30, "rpd": 500},
                "ollama": {"note": "Local inference — no external rate limits."},
            },
        },
    }


@router.post("/settings/performance")
def save_performance_settings(
    concurrent_tickers: int = Query(..., ge=1, le=20),
    concurrent_llm: int = Query(..., ge=1, le=10),
) -> dict[str, Any]:
    """Persist parallelism settings to the DB."""
    from backend.database import set_setting

    set_setting("concurrent_tickers", str(concurrent_tickers))
    set_setting("concurrent_llm", str(concurrent_llm))
    return {
        "concurrent_tickers": concurrent_tickers,
        "concurrent_llm": concurrent_llm,
        "saved": True,
    }
