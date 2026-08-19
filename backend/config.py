"""Central configuration for the offgrid-trader backend.

All secrets (SMTP credentials, Slack webhook) are read from environment
variables and never hardcoded. A ``.env`` file is loaded automatically if
present (see ``.env.example``). Non-secret tuning knobs (watchlist,
thresholds, market hours) also accept environment overrides so the monitor
can be reconfigured without editing code.

Run ``python -m backend.config`` to print the resolved configuration.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

try:  # optional: load a local .env file if python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is optional at runtime  # noqa: S110
    pass  # python-dotenv not installed in production container; silently skip


# --------------------------------------------------------------------------- #
# Small env-parsing helpers
# --------------------------------------------------------------------------- #
def _env_str(key: str, default: str) -> str:
    value = os.getenv(key)
    return value if value not in (None, "") else default


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, str(default)))
    except (TypeError, ValueError):
        return default


def _env_list(key: str, default: list[str]) -> list[str]:
    raw = os.getenv(key)
    if not raw:
        return list(default)
    return [item.strip().upper() for item in raw.split(",") if item.strip()]


# --------------------------------------------------------------------------- #
# Configuration sections
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class OllamaConfig:
    """Local Ollama server connection settings."""

    host: str = field(default_factory=lambda: _env_str("OLLAMA_HOST", "http://localhost:11434"))
    model: str = field(default_factory=lambda: _env_str("OLLAMA_MODEL", "qwen2.5:14b"))
    timeout: int = field(default_factory=lambda: _env_int("OLLAMA_TIMEOUT", 120))

    @property
    def chat_url(self) -> str:
        return f"{self.host.rstrip('/')}/api/chat"


@dataclass(frozen=True)
class MarketHours:
    """US equity regular trading session, expressed in America/New_York."""

    timezone: str = field(default_factory=lambda: _env_str("MARKET_TIMEZONE", "America/New_York"))
    open_hour: int = field(default_factory=lambda: _env_int("MARKET_OPEN_HOUR", 9))
    open_minute: int = field(default_factory=lambda: _env_int("MARKET_OPEN_MINUTE", 30))
    close_hour: int = field(default_factory=lambda: _env_int("MARKET_CLOSE_HOUR", 16))
    close_minute: int = field(default_factory=lambda: _env_int("MARKET_CLOSE_MINUTE", 0))
    # 0 = Monday ... 6 = Sunday. Default: Monday-Friday.
    trading_days: tuple = (0, 1, 2, 3, 4)

    @property
    def tzinfo(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


@dataclass(frozen=True)
class Thresholds:
    """Rule-based signal thresholds and the AI confidence floor."""

    rsi_oversold: float = field(default_factory=lambda: _env_float("RSI_OVERSOLD", 30.0))
    rsi_overbought: float = field(default_factory=lambda: _env_float("RSI_OVERBOUGHT", 70.0))
    volume_spike_multiplier: float = field(
        default_factory=lambda: _env_float("VOLUME_SPIKE_MULTIPLIER", 2.0)
    )
    significant_move_pct: float = field(
        default_factory=lambda: _env_float("SIGNIFICANT_MOVE_PCT", 2.0)
    )
    # Minimum AI/opportunity confidence (0-100) required to store/alert.
    confidence_floor: float = field(default_factory=lambda: _env_float("CONFIDENCE_FLOOR", 65.0))


@dataclass(frozen=True)
class EmailConfig:
    """Gmail SMTP settings. Use a Gmail *App Password*, not the account password."""

    enabled: bool = field(
        default_factory=lambda: _env_str("EMAIL_ENABLED", "false").lower() == "true"
    )
    smtp_host: str = field(default_factory=lambda: _env_str("SMTP_HOST", "smtp.gmail.com"))
    smtp_port: int = field(default_factory=lambda: _env_int("SMTP_PORT", 587))
    username: str = field(default_factory=lambda: _env_str("SMTP_USERNAME", ""))
    # App Password (16 chars). Loaded from env only.
    password: str = field(default_factory=lambda: _env_str("SMTP_APP_PASSWORD", ""))
    sender: str = field(default_factory=lambda: _env_str("EMAIL_FROM", ""))
    recipient: str = field(default_factory=lambda: _env_str("EMAIL_TO", ""))

    @property
    def is_configured(self) -> bool:
        return bool(self.enabled and self.username and self.password and self.recipient)


@dataclass(frozen=True)
class SlackConfig:
    """Slack Incoming Webhook settings."""

    enabled: bool = field(
        default_factory=lambda: _env_str("SLACK_ENABLED", "false").lower() == "true"
    )
    webhook_url: str = field(default_factory=lambda: _env_str("SLACK_WEBHOOK_URL", ""))

    @property
    def is_configured(self) -> bool:
        return bool(self.enabled and self.webhook_url)


@dataclass(frozen=True)
class TelegramConfig:
    """Telegram Bot API settings for alert delivery."""

    enabled: bool = field(
        default_factory=lambda: (_env_str("TELEGRAM_ENABLED", "false").lower() == "true")
    )
    bot_token: str = field(default_factory=lambda: _env_str("TELEGRAM_BOT_TOKEN", ""))
    chat_id: str = field(default_factory=lambda: _env_str("TELEGRAM_CHAT_ID", ""))

    @property
    def is_configured(self) -> bool:
        return bool(self.enabled and self.bot_token and self.chat_id)


@dataclass(frozen=True)
class OtelConfig:
    """OpenTelemetry / Aspire observability settings."""

    # When true, full prompt + response text are added as span events.
    # Default false — prompts may contain sensitive ticker context.
    include_llm_content: bool = field(
        default_factory=lambda: (_env_str("OTEL_INCLUDE_LLM_CONTENT", "false").lower() == "true")
    )


@dataclass(frozen=True)
class Settings:
    """Top-level settings aggregate."""

    # Set false to suppress email + Slack sends while keeping Telegram active.
    alerts_send_enabled: bool = field(
        default_factory=lambda: (_env_str("ALERTS_SEND_ENABLED", "true").lower() == "true")
    )

    watchlist: list[str] = field(
        default_factory=lambda: _env_list(
            "WATCHLIST", ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "SPY"]
        )
    )
    scan_interval_minutes: int = field(
        default_factory=lambda: _env_int("SCAN_INTERVAL_MINUTES", 15)
    )
    database_path: str = field(
        default_factory=lambda: _env_str("DATABASE_PATH", "offgrid_trader.db")
    )
    # Comma-separated list of origins allowed by CORS (frontend dev server).
    cors_origins: list[str] = field(
        default_factory=lambda: [
            o.strip()
            for o in _env_str(
                "CORS_ORIGINS", "http://localhost:5174,http://localhost:5173,http://localhost:3000"
            ).split(",")
            if o.strip()
        ]
    )

    # Optional Finnhub API key — enables recent news headlines in AI prompt.
    # Get a free key at https://finnhub.io/  (60 req/min on the free tier).
    # When true, the background scheduler starts automatically on container
    # boot.  Can also be toggled at runtime via the Settings page or the API
    # (POST /settings/scheduler); the DB value takes precedence over this env
    # var once it has been explicitly set.
    scheduler_auto_start: bool = field(
        default_factory=lambda: _env_str("SCHEDULER_AUTO_START", "false").lower() == "true"
    )

    finnhub_api_key: str = field(default_factory=lambda: _env_str("FINNHUB_API_KEY", ""))

    # Optional FRED API key — enables the FRED REST API (api.stlouisfed.org)
    # which is more reliable from Docker containers than the key-free CSV
    # endpoint (fred.stlouisfed.org) that is often blocked behind corporate VPNs.
    # Get a free key (instant) at https://fred.stlouisfed.org/docs/api/api_key.html
    # Rate limit: 120 req/min on the free tier — more than sufficient.
    fred_api_key: str = field(default_factory=lambda: _env_str("FRED_API_KEY", ""))

    ollama: OllamaConfig = field(default_factory=OllamaConfig)
    market_hours: MarketHours = field(default_factory=MarketHours)
    thresholds: Thresholds = field(default_factory=Thresholds)
    email: EmailConfig = field(default_factory=EmailConfig)
    slack: SlackConfig = field(default_factory=SlackConfig)
    telegram: TelegramConfig = field(default_factory=TelegramConfig)
    otel: OtelConfig = field(default_factory=OtelConfig)


# Singleton-style accessor -------------------------------------------------- #
_settings: Settings | None = None


def get_settings() -> Settings:
    """Return a cached :class:`Settings` instance."""

    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


# Convenience module-level handle.
settings = get_settings()


def _redacted_summary(cfg: Settings) -> dict:
    """Return a dict of the config with secrets masked, for safe printing."""

    def mask(value: str) -> str:
        return "***set***" if value else "(unset)"

    return {
        "watchlist": cfg.watchlist,
        "scan_interval_minutes": cfg.scan_interval_minutes,
        "database_path": cfg.database_path,
        "cors_origins": cfg.cors_origins,
        "ollama": {
            "host": cfg.ollama.host,
            "model": cfg.ollama.model,
            "timeout": cfg.ollama.timeout,
        },
        "market_hours": {
            "timezone": cfg.market_hours.timezone,
            "open": f"{cfg.market_hours.open_hour:02d}:{cfg.market_hours.open_minute:02d}",
            "close": f"{cfg.market_hours.close_hour:02d}:{cfg.market_hours.close_minute:02d}",
            "trading_days": cfg.market_hours.trading_days,
        },
        "thresholds": {
            "rsi_oversold": cfg.thresholds.rsi_oversold,
            "rsi_overbought": cfg.thresholds.rsi_overbought,
            "volume_spike_multiplier": cfg.thresholds.volume_spike_multiplier,
            "significant_move_pct": cfg.thresholds.significant_move_pct,
            "confidence_floor": cfg.thresholds.confidence_floor,
        },
        "email": {
            "enabled": cfg.email.enabled,
            "username": mask(cfg.email.username),
            "password": mask(cfg.email.password),
            "recipient": cfg.email.recipient or "(unset)",
            "configured": cfg.email.is_configured,
        },
        "slack": {
            "enabled": cfg.slack.enabled,
            "webhook_url": mask(cfg.slack.webhook_url),
            "configured": cfg.slack.is_configured,
        },
        "telegram": {
            "enabled": cfg.telegram.enabled,
            "bot_token": mask(cfg.telegram.bot_token),
            "chat_id": cfg.telegram.chat_id or "(unset)",
            "configured": cfg.telegram.is_configured,
        },
        "alerts_send_enabled": cfg.alerts_send_enabled,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(_redacted_summary(get_settings()), indent=2, default=str))
