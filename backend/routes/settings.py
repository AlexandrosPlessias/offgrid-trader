"""Settings routes: /settings* (non-alpaca, non-discovery)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import get_setting, set_setting
from backend.routes._models import _alerts_enabled
from backend.scheduler import scheduler

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


class AutoTradeSettingRequest(BaseModel):
    """Autonomous-trading knobs — all optional; only provided fields are written."""

    confidence_floor: float | None = Field(None, ge=0, le=100)
    paper_max_positions: int | None = Field(None, ge=0, le=100)
    signal_drop_mode: str | None = Field(None, description="untradable | strict | never")
    frac_min_confidence: float | None = Field(None, ge=0, le=100)
    paper_trade_min_confidence: float | None = Field(None, ge=0, le=100)
    frac_autotrade_allow_live: bool | None = None
    discovery_autoadd_enabled: bool | None = None


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


@router.post("/settings/autotrade")
def set_autotrade(request: AutoTradeSettingRequest) -> dict[str, Any]:
    """Persist autonomous-trading knobs. Only provided fields are written.

    Every value is a live DB override read by the scan pipeline at call time;
    env vars still provide the boot defaults.
    """
    if request.signal_drop_mode is not None and request.signal_drop_mode not in (
        "untradable",
        "strict",
        "never",
    ):
        raise HTTPException(
            status_code=422, detail="signal_drop_mode must be untradable|strict|never"
        )

    if request.confidence_floor is not None:
        set_setting("confidence_floor", str(request.confidence_floor))
    if request.paper_max_positions is not None:
        set_setting("paper_max_positions", str(request.paper_max_positions))
    if request.signal_drop_mode is not None:
        set_setting("signal_drop_mode", request.signal_drop_mode)
    if request.frac_min_confidence is not None:
        set_setting("frac_min_confidence", str(request.frac_min_confidence))
    if request.paper_trade_min_confidence is not None:
        set_setting("paper_trade_min_confidence", str(request.paper_trade_min_confidence))
    if request.frac_autotrade_allow_live is not None:
        set_setting(
            "frac_autotrade_allow_live",
            "true" if request.frac_autotrade_allow_live else "false",
        )
    if request.discovery_autoadd_enabled is not None:
        set_setting(
            "discovery_autoadd_enabled",
            "true" if request.discovery_autoadd_enabled else "false",
        )
    return {"saved": True}


@router.post("/settings/signal-scan-llm")
def set_signal_scan_llm(request: SignalScanLlmRequest) -> dict[str, Any]:
    """Enable or disable LLM calls for live signal scanning.

    When disabled the AI-analysis skill is skipped and the pipeline runs
    in rules-only mode — no LLM API quota is consumed by the scheduler.
    Takes effect immediately (no restart required).
    """
    set_setting("signal_scan_llm_enabled", "true" if request.enabled else "false")
    return {"signal_scan_llm_enabled": request.enabled}


@router.post("/settings/order-notifications")
def set_order_notifications(request: SignalScanLlmRequest) -> dict[str, Any]:
    """Enable/disable the notification sent when an order or fractional buy is placed."""
    set_setting("order_notifications_enabled", "true" if request.enabled else "false")
    return {"order_notifications_enabled": request.enabled}


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
        # Notify configured channels whenever an order / fractional position is placed.
        "order_notifications_enabled": get_setting("order_notifications_enabled", "true") == "true",
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
        "alpaca_profile_name_env": cfg.alpaca.profile_name,  # raw env value for "Load defaults"
        "paper_trading_enabled": get_setting("paper_trading_enabled", "true") == "true",
        "paper_trade_position_size": float(get_setting("paper_trade_position_size", "") or 500),
        "paper_trade_min_confidence": (
            float(get_setting("paper_trade_min_confidence", ""))
            if get_setting("paper_trade_min_confidence", "")
            else None
        ),
        "paper_profile_name": get_setting("paper_profile_name", ""),
        # Fractional trading — second Alpaca profile (paper during monitoring, live later).
        "frac_alpaca_url": (get_setting("frac_alpaca_url", "") or cfg.frac.url),
        "frac_alpaca_key_id": (get_setting("frac_alpaca_key_id", "") or cfg.frac.key_id),
        "frac_alpaca_key_id_set": bool(get_setting("frac_alpaca_key_id", "") or cfg.frac.key_id),
        "frac_alpaca_secret_set": bool(
            get_setting("frac_alpaca_secret_key", "") or cfg.frac.secret_key
        ),
        "frac_profile_name": (get_setting("frac_profile_name", "") or cfg.frac.profile_name),
        "frac_trading_enabled": get_setting("frac_trading_enabled", "false") == "true",
        "frac_position_size": float(
            get_setting("frac_position_size", "") or cfg.frac.position_size
        ),
        "frac_budget": float(get_setting("frac_budget", "") or cfg.frac.budget),
        "frac_min_confidence": (
            float(get_setting("frac_min_confidence", ""))
            if get_setting("frac_min_confidence", "")
            else None
        ),
        "frac_poll_seconds": int(get_setting("frac_poll_seconds", "") or cfg.frac.poll_seconds),
        "frac_eod_close": get_setting("frac_eod_close", "false") == "true",
        "frac_mode": (
            "live"
            if "://api.alpaca.markets" in (get_setting("frac_alpaca_url", "") or cfg.frac.url)
            else "paper"
        ),
        # Env-only flags/values — True/raw when the .env var is set (DB ignored).
        # Powers the "Load Environment Default Values" button in the frac UI.
        "frac_alpaca_key_id_env_set": bool(cfg.frac.key_id),
        "frac_alpaca_secret_env_set": bool(cfg.frac.secret_key),
        # Key ID is non-secret (username-like) — return the raw env value so the
        # UI can show the actual key when "Load Environment Default Values" is on.
        "frac_alpaca_key_id_env": cfg.frac.key_id,
        "frac_profile_name_env": cfg.frac.profile_name,
        "frac_alpaca_url_env": cfg.frac.url,
        "frac_position_size_env": cfg.frac.position_size,
        "frac_budget_env": cfg.frac.budget,
        "frac_poll_seconds_env": cfg.frac.poll_seconds,
        # Autonomous trading loop
        "confidence_floor": float(
            get_setting("confidence_floor", "") or cfg.thresholds.confidence_floor
        ),
        "confidence_floor_env": cfg.thresholds.confidence_floor,
        "paper_max_positions": int(
            get_setting("paper_max_positions", "") or cfg.autotrade.paper_max_positions
        ),
        "paper_max_positions_env": cfg.autotrade.paper_max_positions,
        "signal_drop_mode": (
            get_setting("signal_drop_mode", "") or cfg.autotrade.signal_drop_mode
        ),
        "signal_drop_mode_env": cfg.autotrade.signal_drop_mode,
        "frac_autotrade_allow_live": (
            get_setting("frac_autotrade_allow_live", "")
            or ("true" if cfg.autotrade.frac_autotrade_allow_live else "false")
        )
        == "true",
        "frac_autotrade_allow_live_env": cfg.autotrade.frac_autotrade_allow_live,
        "discovery_autoadd_enabled": (
            get_setting("discovery_autoadd_enabled", "")
            or ("true" if cfg.discovery.autoadd_enabled else "false")
        )
        == "true",
        "discovery_autoadd_enabled_env": cfg.discovery.autoadd_enabled,
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


class ClearDataRequest(BaseModel):
    categories: list[str] = Field(..., min_length=1, description="Data categories to erase")


@router.post("/settings/clear-data")
def clear_selected_data(req: ClearDataRequest) -> dict[str, Any]:
    """Selectively delete one or more data categories.

    Valid categories: signals, analysis_log, paper_orders, discovery_runs,
    watchlist_overrides, ticker_memory, data_cache, backtest_runs.
    """
    import logging as _logging

    from backend.database import CLEAR_CATEGORIES
    from backend.database import clear_selected_data as _clear

    unknown = set(req.categories) - CLEAR_CATEGORIES
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown categories: {sorted(unknown)}")

    # Sanitize before logging — categories are validated against CLEAR_CATEGORIES allowlist
    # above, so newline-strip is belt-and-suspenders against log injection.
    safe_cats = [c.replace("\n", "").replace("\r", "") for c in sorted(req.categories)]
    _logging.getLogger(__name__).warning("clear_selected_data called — categories: %s", safe_cats)
    result = _clear(req.categories)
    return {"cleared": True, **result}


# --------------------------------------------------------------------------- #
# Notifications — all channels (global alerts toggle + ntfy + Telegram + Email)
# --------------------------------------------------------------------------- #
class NtfySettingRequest(BaseModel):
    enabled: bool | None = Field(None, description="Enable or disable ntfy notifications")
    topic: str | None = Field(None, description="ntfy topic (acts as shared secret)")
    server: str | None = Field(None, description="ntfy server URL (e.g. http://ntfy:80)")


class TelegramSettingRequest(BaseModel):
    enabled: bool | None = Field(None, description="Enable or disable Telegram alerts")
    bot_token: str | None = Field(None, description="Bot token from BotFather")
    chat_id: str | None = Field(None, description="Target chat or group ID")


class EmailSettingRequest(BaseModel):
    enabled: bool | None = Field(None, description="Enable or disable email alerts")
    smtp_host: str | None = Field(None, description="SMTP host, e.g. smtp.gmail.com")
    smtp_port: int | None = Field(None, ge=1, le=65535, description="SMTP port, e.g. 587")
    username: str | None = Field(None, description="SMTP username / from address")
    password: str | None = Field(None, description="SMTP App Password")
    email_from: str | None = Field(None, description="From address")
    email_to: str | None = Field(None, description="Recipient address")


class NtfyTestRequest(BaseModel):
    topic: str | None = Field(None, description="Override ntfy topic for the test")
    server: str | None = Field(None, description="Override ntfy server for the test")


@router.get("/settings/notifications")
def get_notification_settings() -> dict[str, Any]:
    """Return effective settings for every notification channel.

    Secrets (ntfy topic, bot token, SMTP password) are never returned in plain
    text — only ``*_set`` booleans. ``*_env`` fields expose what the .env values
    resolve to (DB ignored) for the "Load environment defaults" buttons.
    """
    from backend.alerts import resolve_email, resolve_telegram

    cfg = get_settings()
    # ntfy
    topic = get_setting("ntfy_topic", "") or cfg.ntfy.topic
    ntfy_enabled_raw = get_setting("ntfy_enabled", "")
    ntfy_enabled = (ntfy_enabled_raw.lower() == "true") if ntfy_enabled_raw else cfg.ntfy.enabled
    ntfy_server = get_setting("ntfy_server", "") or cfg.ntfy.server
    # telegram / email (effective, DB-over-env)
    tg = resolve_telegram()
    em = resolve_email()
    return {
        # global dispatch switch (suppresses email; telegram/ntfy have own flags)
        "alerts_enabled": _alerts_enabled(),
        # ntfy
        "ntfy_enabled": ntfy_enabled,
        "ntfy_topic": topic,
        "ntfy_topic_set": bool(topic),
        "ntfy_server": ntfy_server,
        "ntfy_configured": bool(topic),
        "ntfy_enabled_env": cfg.ntfy.enabled,
        "ntfy_topic_env": cfg.ntfy.topic,
        "ntfy_topic_env_set": bool(cfg.ntfy.topic),
        "ntfy_server_env": cfg.ntfy.server,
        # telegram (bot token returned so the form can show it — admin-gated, own config)
        "telegram_enabled": tg["enabled"],
        "telegram_bot_token": tg["bot_token"],
        "telegram_bot_token_set": bool(tg["bot_token"]),
        "telegram_chat_id": tg["chat_id"],
        "telegram_configured": bool(tg["bot_token"] and tg["chat_id"]),
        "telegram_enabled_env": cfg.telegram.enabled,
        "telegram_bot_token_env": cfg.telegram.bot_token,
        "telegram_bot_token_env_set": bool(cfg.telegram.bot_token),
        "telegram_chat_id_env": cfg.telegram.chat_id,
        # email
        "email_enabled": em["enabled"],
        "email_smtp_host": em["smtp_host"],
        "email_smtp_port": em["smtp_port"],
        "email_username": em["username"],
        "email_password": em["password"],
        "email_password_set": bool(em["password"]),
        "email_from": em["sender"],
        "email_to": em["recipient"],
        "email_configured": bool(em["username"] and em["password"] and em["recipient"]),
        "email_enabled_env": cfg.email.enabled,
        "email_password_env": cfg.email.password,
        "email_password_env_set": bool(cfg.email.password),
    }


@router.post("/settings/notifications/ntfy")
def set_ntfy_settings(request: NtfySettingRequest) -> dict[str, Any]:
    """Persist ntfy settings to the DB (no restart). Re-registers channels."""
    from backend.notifications import register_channels

    if request.enabled is not None:
        set_setting("ntfy_enabled", "true" if request.enabled else "false")
    if request.topic is not None:
        set_setting("ntfy_topic", request.topic)
    if request.server is not None:
        set_setting("ntfy_server", request.server)
    register_channels()
    return get_notification_settings()


@router.post("/settings/notifications/telegram")
def set_telegram_settings(request: TelegramSettingRequest) -> dict[str, Any]:
    """Persist Telegram settings to the DB (no restart)."""
    if request.enabled is not None:
        set_setting("telegram_enabled", "true" if request.enabled else "false")
    if request.bot_token is not None:
        set_setting("telegram_bot_token", request.bot_token)
    if request.chat_id is not None:
        set_setting("telegram_chat_id", request.chat_id)
    return get_notification_settings()


@router.post("/settings/notifications/email")
def set_email_settings(request: EmailSettingRequest) -> dict[str, Any]:
    """Persist email settings to the DB (no restart)."""
    if request.enabled is not None:
        set_setting("email_enabled", "true" if request.enabled else "false")
    if request.smtp_host is not None:
        set_setting("email_smtp_host", request.smtp_host)
    if request.smtp_port is not None:
        set_setting("email_smtp_port", str(request.smtp_port))
    if request.username is not None:
        set_setting("email_username", request.username)
    if request.password is not None:
        set_setting("email_password", request.password)
    if request.email_from is not None:
        set_setting("email_from", request.email_from)
    if request.email_to is not None:
        set_setting("email_to", request.email_to)
    return get_notification_settings()


@router.post("/notifications/test")
def test_notifications(request: NtfyTestRequest) -> dict[str, Any]:
    """Fire a test notification through every enabled channel; report per-channel.

    ntfy accepts optional topic/server overrides so the user can test what's typed
    in the form before saving; Telegram and Email use their saved/effective config.
    """
    from backend.alerts import send_telegram
    from backend.notifications.ntfy import post_ntfy, resolve_server, resolve_topic
    from backend.routes.notifications import new_roundtrip_token

    # Round-trip token: the confirm action tapped in the channel proves the full
    # loop (credentials → delivery → action routing → frontend feedback) works.
    token = new_roundtrip_token()
    base = get_settings().backend_public_url.rstrip("/")
    confirm_url = f"{base}/notifications/test/confirm?token={token}"

    subject = "MarketSage — test notification"
    body = (
        "If you can read this, your notification channel is wired up correctly. ✅\n"
        'Tap "Confirm receipt" below to finish the round-trip test.'
    )
    actions = [{"label": "✅ Confirm receipt", "url": confirm_url, "method": "POST"}]
    tg_markup = {"inline_keyboard": [[{"text": "✅ Confirm receipt", "url": confirm_url}]]}
    results: dict[str, str] = {}

    # ntfy (with optional unsaved overrides)
    topic = (request.topic or "").strip() or resolve_topic()
    server = (request.server or "").strip() or resolve_server()
    if topic:
        results["ntfy"] = (
            "sent"
            if post_ntfy(
                server, topic, subject, body, tags="bell", priority="default", actions=actions
            )
            else "failed"
        )
    else:
        results["ntfy"] = "skipped (not configured)"

    results["telegram"] = (
        "sent" if send_telegram(subject, body, reply_markup=tg_markup) else "skipped or failed"
    )

    any_sent = any(v == "sent" for v in results.values())
    if not any_sent:
        raise HTTPException(
            status_code=502,
            detail="No channel accepted the test. Enable and configure at least one channel.",
        )
    return {"ok": True, "results": results, "token": token, "ttl": 60}


@router.get("/settings/export")
def export_settings() -> dict[str, Any]:
    """Download a portable JSON snapshot of CONFIG (settings + watchlist groups).

    Secret values (API keys, bot tokens, ntfy topic, admin token) are redacted. Data
    (signals/orders/etc.) is NOT here — export that via ``GET /data/export``. Manual only.
    """
    from datetime import datetime, timezone

    from backend.database import export_app_settings, get_watchlist_groups

    return {
        "format": "marketsage-config",
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "settings": export_app_settings(redact_secrets=True),
        "watchlist_groups": get_watchlist_groups(),
    }
