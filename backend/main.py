"""FastAPI application exposing the offgrid-trader backend.

Endpoints
---------
* ``POST /analyze``               — on-demand analysis for any ticker.
* ``POST /analyze/stream``        — same pipeline, streamed via SSE (step events + result).
* ``GET  /market-data/{ticker}``  — raw market data dict (price, fundamentals, indicators).
* ``POST /webhook/tradingview``   — receive a TradingView Pro alert and kick
                                    off a background analysis.
* ``GET  /signals``               — recent stored signals (optional ticker).
* ``GET  /analysis/{ticker}``     — analysis-log history for a ticker.
* ``GET  /watchlist``             — configured watchlist + scheduler status.
* ``GET  /health``                — liveness + config summary.
* ``GET  /usage``                 — aggregate LLM token usage from the analysis log.
* ``GET  /provider/quota``        — live rate-limit / quota check for the active provider.

CORS is enabled for the frontend dev server(s) from config. The background
scheduler is started/stopped via the lifespan handler.

Run::

    uvicorn backend.main:app --reload
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Any

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .config import get_settings
from .data import get_market_data as _get_market_data
from .database import (
    clear_all_data as _clear_all_data,
)
from .database import (
    delete_analysis as _delete_analysis,
)
from .database import (
    delete_signal as _delete_signal_row,
)
from .database import (
    get_analysis_history,
    get_effective_watchlist,
    get_recent_analyses,
    get_recent_signals,
    get_setting,
    get_usage_stats,
    init_db,
    set_setting,
)
from .scheduler import scan_ticker_async, scheduler

_log = logging.getLogger(__name__)

# Tickers are short alphanumeric symbols (optionally with '.' or '-', e.g.
# "BRK.B"). Enforcing this early rejects any control characters (CR/LF etc.)
# before a ticker value is ever interpolated into a log message, closing off
# log-injection via crafted request bodies (CodeQL py/log-injection).
_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,15}$")


def _clean_ticker(raw: str) -> str:
    """Normalise and validate a user-supplied ticker symbol.

    Raises ``HTTPException(400)`` if *raw* doesn't look like a real ticker.
    """
    ticker = raw.strip().upper()
    if not ticker or not _TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="invalid ticker")
    return ticker


def _log_safe(value: str) -> str:
    """Strip CR/LF from *value* so it can't forge extra log lines/entries."""
    return value.replace("\r", "").replace("\n", "")


# --------------------------------------------------------------------------- #
# OpenTelemetry (optional — only active when OTEL_EXPORTER_OTLP_ENDPOINT set)
# --------------------------------------------------------------------------- #
def _setup_otel(app: FastAPI) -> None:
    """Wire OpenTelemetry traces, metrics, and logs to Aspire dashboard."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
    if not endpoint:
        return
    try:
        from opentelemetry import metrics, trace
        from opentelemetry._logs import set_logger_provider
        from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource({SERVICE_NAME: "offgrid-trader"})

        tracer = TracerProvider(resource=resource)
        tracer.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(tracer)

        metrics.set_meter_provider(
            MeterProvider(
                resource=resource,
                metric_readers=[
                    PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=endpoint))
                ],
            )
        )

        log_provider = LoggerProvider(resource=resource)
        log_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint))
        )
        set_logger_provider(log_provider)
        logging.getLogger().addHandler(
            LoggingHandler(level=logging.INFO, logger_provider=log_provider)
        )

        logging.getLogger().setLevel(logging.INFO)

        FastAPIInstrumentor.instrument_app(app, excluded_urls="health")
        RequestsInstrumentor().instrument()
        logging.getLogger(__name__).info("telemetry → %s", endpoint)
    except ImportError:
        print("[otel] opentelemetry packages missing — skipping telemetry")


# --------------------------------------------------------------------------- #
# Request / response models
# --------------------------------------------------------------------------- #
class AnalyzeRequest(BaseModel):
    ticker: str = Field(..., description="Ticker symbol, e.g. AAPL")
    send_alerts: bool = Field(False, description="Also dispatch alerts for actionable signals")


class AddTickerRequest(BaseModel):
    ticker: str = Field(..., description="Ticker to add to the watchlist")


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
        None, description="Reasoning effort for models that support it: none | low | medium | high"
    )


class SchedulerSettingRequest(BaseModel):
    running: bool = Field(..., description="True to start the scheduler, False to stop it")


class ScanIntervalRequest(BaseModel):
    minutes: int = Field(..., ge=1, le=1440, description="Scan interval in minutes (1-1440)")


class TradingViewWebhook(BaseModel):
    """Loose schema for TradingView Pro alert payloads.

    TradingView lets users define arbitrary JSON, so only ``ticker`` (or
    ``symbol``) is required; everything else is captured for logging.
    """

    ticker: str | None = None
    symbol: str | None = None
    action: str | None = None
    price: float | None = None
    message: str | None = None

    def resolved_ticker(self) -> str | None:
        value = self.ticker or self.symbol
        return value.strip().upper() if value else None


# --------------------------------------------------------------------------- #
# App + lifespan
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise the DB and start/stop the background scheduler.

    Auto-scan is OFF by default.  It starts only when the DB setting
    ``scheduler_running`` is explicitly ``"true"`` (set via the Settings page
    or ``POST /settings/scheduler``).  This prevents unexpected background
    scans on fresh installs and after container restarts.
    """
    init_db()
    # Start the scheduler if the DB setting says "true" (user has toggled it
    # at runtime), or if no DB override exists yet and SCHEDULER_AUTO_START=true
    # is set in .env (fresh install default).
    db_sched = get_setting("scheduler_running", "")
    env_auto = get_settings().scheduler_auto_start
    if db_sched == "true" or (db_sched == "" and env_auto):
        scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()


app = FastAPI(
    title="offgrid-trader",
    version=__version__,
    description="Local, zero-cost AI stock monitor. Not financial advice.",
    lifespan=lifespan,
)
_setup_otel(app)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Background helper
# --------------------------------------------------------------------------- #
def _background_analyze(ticker: str, send_alerts: bool = True) -> None:
    """Run a full scan for one ticker (used by the webhook)."""
    from .scheduler import scan_ticker  # local import — avoids import cycle

    scan_ticker(ticker, send_alerts=send_alerts)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
def health() -> dict[str, Any]:
    settings = get_settings()
    db_model = get_setting("ollama_model", "")
    db_provider = get_setting("llm_provider", "")
    provider = db_provider or settings.llm.provider
    active_model = (
        db_model or settings.ollama.model
        if provider == "ollama"
        else (get_setting("llm_model", "") or settings.llm.default_model_for(provider))
    )
    result: dict[str, Any] = {
        "status": "ok",
        "version": __version__,
        "llm_provider": provider,
        "llm_model": active_model,
        "watchlist_size": len(settings.watchlist),
        "scheduler": scheduler.status(),
        "disclaimer": "Not financial advice.",
    }
    # Keep ollama_host for backward compatibility with existing clients/tooling.
    if provider == "ollama":
        result["ollama_host"] = settings.ollama.host
        result["ollama_model"] = active_model  # backward compat alias
    return result


def _alerts_enabled() -> bool:
    db_val = get_setting("alerts_enabled", "")
    if db_val:
        return db_val.lower() == "true"
    return get_settings().alerts_send_enabled


@app.get("/watchlist")
def watchlist() -> dict[str, Any]:
    settings = get_settings()
    return {
        "watchlist": get_effective_watchlist(),
        "scan_interval_minutes": settings.scan_interval_minutes,
        "scheduler": scheduler.status(),
        "alerts_enabled": _alerts_enabled(),
    }


@app.post("/watchlist")
def add_ticker(request: AddTickerRequest) -> dict[str, Any]:
    ticker = request.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker required")

    added: list = json.loads(get_setting("watchlist_added", "[]"))
    removed: list = json.loads(get_setting("watchlist_removed", "[]"))

    if ticker in removed:
        removed.remove(ticker)
        set_setting("watchlist_removed", json.dumps(removed))

    base = get_settings().watchlist
    if ticker not in base and ticker not in added:
        added.append(ticker)
        set_setting("watchlist_added", json.dumps(added))

    return {"watchlist": get_effective_watchlist()}


@app.delete("/watchlist/{ticker}")
def remove_ticker(ticker: str) -> dict[str, Any]:
    ticker = ticker.strip().upper()

    added: list = json.loads(get_setting("watchlist_added", "[]"))
    removed: list = json.loads(get_setting("watchlist_removed", "[]"))

    if ticker in added:
        added.remove(ticker)
        set_setting("watchlist_added", json.dumps(added))

    if ticker not in removed:
        removed.append(ticker)
        set_setting("watchlist_removed", json.dumps(removed))

    return {"watchlist": get_effective_watchlist()}


@app.post("/settings/alerts")
def set_alerts(request: AlertsSettingRequest) -> dict[str, Any]:
    set_setting("alerts_enabled", "true" if request.enabled else "false")
    return {"alerts_enabled": request.enabled}


@app.post("/settings/scheduler")
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


@app.post("/settings/scan-interval")
def set_scan_interval(request: ScanIntervalRequest) -> dict[str, Any]:
    """Update the scan interval (persisted to DB; takes effect on next loop cycle)."""
    set_setting("scan_interval_minutes", str(request.minutes))
    return scheduler.status()


@app.get("/settings")
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
        # Admin token — sent back to the UI so the Settings page can include
        # it as X-Admin-Token when the user clicks "Show" on the API key field.
        # Env var (ADMIN_TOKEN) takes priority; falls back to DB-generated UUID.
        "admin_token": cfg.admin_token or get_setting("admin_token", ""),
    }


@app.post("/settings/ollama")
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


@app.post("/settings/llm")
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
    return {
        "ok": True,
        "provider": get_setting("llm_provider", "") or get_settings().llm.provider,
    }


@app.get("/settings/llm/key")
def reveal_llm_key(x_admin_token: str | None = Header(None)) -> dict[str, str]:
    """Return the active API key in plaintext (DB value, or env fallback).

    Requires the ``X-Admin-Token`` header to equal the installation's admin
    token (auto-generated at first startup, stored in ``app_settings``, and
    included in ``GET /settings`` so the UI can send it back here).

    This stops single-shot automated key harvesting: an attacker must first
    discover the token from ``GET /settings``, then make a second targeted
    request — rather than recovering the key with one unauthenticated GET.
    """
    # Resolve admin token: ADMIN_TOKEN env var takes priority over DB-stored value.
    cfg = get_settings()
    expected = cfg.admin_token or get_setting("admin_token", "")
    if not expected or x_admin_token != expected:
        raise HTTPException(status_code=401, detail="Missing or invalid X-Admin-Token header.")
    provider = get_setting("llm_provider", "") or cfg.llm.provider
    db_key = get_setting("llm_api_key", "")
    env_key = cfg.llm.api_key_for(provider)
    return {"key": db_key or env_key}


@app.get("/settings/models")
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


@app.post("/analyze")
async def analyze_ticker(request: AnalyzeRequest) -> dict[str, Any]:
    """On-demand analysis for a single ticker."""
    ticker = _clean_ticker(request.ticker)

    result = await scan_ticker_async(ticker, send_alerts=request.send_alerts)
    return {
        "ticker": ticker,
        "analysis": result.get("analysis"),
        "opportunities": result["opportunities"],
        "actionable": result["actionable"],
        "saved_signal_ids": result["saved_signal_ids"],
        "alerts": result["alerts"],
        "errors": result["errors"],
    }


@app.post("/analyze/stream")
async def analyze_ticker_stream(  # noqa: C901
    request: AnalyzeRequest,
) -> StreamingResponse:
    """On-demand analysis streamed as Server-Sent Events.

    Yields ``data: <json>`` lines for each pipeline step, then a final
    ``type:"result"`` event with the full analysis + market data.
    Results are persisted to the database (analysis_log + signals tables).
    """
    ticker = _clean_ticker(request.ticker)

    # Capture before entering generator (request not in scope inside async gen)
    send_alerts = request.send_alerts

    async def _event(payload: dict[str, Any]) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def _stream_body() -> AsyncGenerator[str, None]:
        from backend.agent import TickerAgent
        from backend.scheduler import _memory

        _SKILL_TO_STEP = {
            "fetch_data": "fetch",
            "ai_analysis": "analyze",
            "opportunity_detect": "detect",
            "persist": "persist",
            "alert": "alert",
        }

        queue: asyncio.Queue = asyncio.Queue()
        agent = TickerAgent(ticker, memory=_memory, send_alerts=send_alerts)

        # Run the agent as a background task that pushes events to the queue
        # as each skill starts and finishes — true real-time streaming.
        task = asyncio.create_task(agent.run(event_queue=queue))

        try:
            while True:
                ev = await queue.get()
                if ev is None:  # sentinel — agent finished
                    break
                ev_type = ev.get("type")
                if ev_type == "step":
                    out = dict(ev)
                    out["step"] = _SKILL_TO_STEP.get(ev.get("step", ""), ev.get("step", ""))
                    yield await _event(out)
                elif ev_type in ("retry", "memory", "skill_error"):
                    yield await _event(ev)
        except Exception:
            task.cancel()
            raise

        # Await the completed task and emit the final result.
        result = await task
        ctx = result.context
        yield await _event(
            {
                "type": "result",
                "ticker": ticker,
                "analysis": ctx.analysis,
                "market_data": ctx.market_data,
                "opportunities": ctx.opportunities or [],
                "actionable": ctx.actionable or [],
                "saved_signal_ids": ctx.saved_signal_ids,
                "alerts": ctx.alerts_sent,
                "errors": ctx.errors,
            }
        )

    async def _stream() -> AsyncGenerator[str, None]:
        """Outer wrapper — catches any unhandled exception so no stack trace
        is ever written to the SSE stream (py/stack-trace-exposure)."""
        try:
            async for chunk in _stream_body():
                yield chunk
        except Exception:
            _log.exception("unhandled error in SSE stream for %s", _log_safe(ticker))
            yield await _event(
                {
                    "type": "error",
                    "msg": "An internal error occurred. Check server logs.",
                }
            )

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering if missed in conf
        },
    )


@app.get("/market-data/{ticker}")
async def market_data(ticker: str) -> dict[str, Any]:
    """Return the raw market data dict for *ticker* (price, fundamentals, indicators)."""
    ticker = _clean_ticker(ticker)
    data = await asyncio.to_thread(_get_market_data, ticker)
    return data


@app.get("/market-data/{ticker}/history")
async def market_data_history(
    ticker: str,
    period: str = Query("3mo", description="yfinance period, e.g. 1mo 3mo 6mo 1y"),
    interval: str = Query("1d", description="yfinance interval, e.g. 1d 1wk"),
) -> dict[str, Any]:
    """Return OHLCV history for *ticker* from yfinance.

    Each entry: ``{date, open, high, low, close, volume}``.
    Used by the price history chart in the Analysis Explorer.
    """
    ticker = _clean_ticker(ticker)

    def _fetch() -> list:
        import yfinance as yf  # local import — not needed at startup

        yf_ticker = yf.Ticker(ticker)
        hist = yf_ticker.history(period=period, interval=interval)
        if hist.empty:
            return []
        rows = []
        prev_close = None
        for ts, row in hist.iterrows():
            if isinstance(ts, (datetime, date)):
                date_str = ts.strftime("%Y-%m-%d")
            else:
                date_str = str(ts)
            close = float(row["Close"]) if row["Close"] == row["Close"] else None
            rows.append(
                {
                    "date": date_str,
                    "open": float(row["Open"]) if row["Open"] == row["Open"] else None,
                    "high": float(row["High"]) if row["High"] == row["High"] else None,
                    "low": float(row["Low"]) if row["Low"] == row["Low"] else None,
                    "close": close,
                    "volume": (int(row["Volume"]) if row["Volume"] == row["Volume"] else None),
                    "up": close is not None and prev_close is not None and close >= prev_close,
                }
            )
            prev_close = close
        return rows

    try:
        rows = await asyncio.to_thread(_fetch)
    except Exception as exc:
        _log.exception("candles fetch failed for %s", _log_safe(ticker))
        raise HTTPException(
            status_code=502, detail="Failed to fetch candle data — check server logs"
        ) from exc

    return {"ticker": ticker, "period": period, "interval": interval, "candles": rows}


@app.post("/webhook/tradingview")
async def tradingview_webhook(
    payload: TradingViewWebhook,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Receive a TradingView Pro alert and trigger background analysis."""
    ticker = payload.resolved_ticker()
    if not ticker:
        raise HTTPException(
            status_code=400,
            detail="payload must include 'ticker' or 'symbol'",
        )

    background_tasks.add_task(_background_analyze, ticker, True)
    return {
        "status": "accepted",
        "ticker": ticker,
        "message": "analysis scheduled in background",
    }


@app.get("/signals")
def signals(
    limit: int = Query(50, ge=1, le=500),
    ticker: str | None = Query(None),
) -> dict[str, Any]:
    """Return recent stored signals, optionally filtered by ticker."""
    rows = get_recent_signals(limit=limit, ticker=ticker)
    return {"count": len(rows), "signals": rows}


@app.delete("/signals/{signal_id}")
def delete_signal(signal_id: int) -> dict[str, Any]:
    """Delete a stored signal by id."""
    deleted = _delete_signal_row(signal_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"signal {signal_id} not found")
    return {"deleted": True, "id": signal_id}


@app.get("/analysis")
def all_analysis_history(
    limit: int = Query(25, ge=1, le=100),
) -> dict[str, Any]:
    """Return recent analysis-log entries across all tickers, newest first."""
    rows = get_recent_analyses(limit=limit)
    return {"count": len(rows), "history": rows}


@app.delete("/analysis/{entry_id}")
def delete_analysis_entry(entry_id: int) -> dict[str, Any]:
    """Delete an analysis-log entry by id."""
    deleted = _delete_analysis(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"analysis entry {entry_id} not found")
    return {"deleted": True, "id": entry_id}


@app.post("/data/reset")
def reset_data() -> dict[str, Any]:
    """Clear all signals and analysis history.

    app_settings (watchlist, model, etc.) is preserved.
    """
    counts = _clear_all_data()
    return {"cleared": ["signals", "analysis_log"], **counts}


@app.get("/analysis/{ticker}")
def analysis_history(
    ticker: str,
    limit: int = Query(20, ge=1, le=200),
) -> dict[str, Any]:
    """Return the analysis-log history for *ticker*."""
    rows = get_analysis_history(ticker=ticker, limit=limit)
    return {"ticker": ticker.upper(), "count": len(rows), "history": rows}


# --------------------------------------------------------------------------- #
# Token usage monitoring
# --------------------------------------------------------------------------- #
@app.get("/usage")
def usage_stats(
    days: int = Query(30, ge=1, le=365, description="Look-back window in days"),
) -> dict[str, Any]:
    """Aggregate LLM token usage from the analysis log.

    Returns totals and per-provider/per-day breakdowns for the last *days* days.
    Prompt and completion tokens are stored per analysis run — rows created before
    token tracking was added will contribute 0 to the totals (SQL NULL → 0).
    """
    return get_usage_stats(days=days)


@app.get("/provider/quota")
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
    from .analysis import _effective_provider, _get_db_setting
    from .config import get_settings as _cfg

    provider = _effective_provider()
    settings = _cfg()

    if provider == "ollama":
        return {"provider": "ollama", "quota": "n/a", "note": "Ollama runs locally — no quota."}

    if provider == "custom":
        return {"provider": "custom", "quota": "n/a", "note": "Custom provider — quota unknown."}

    # Resolve API key (DB takes precedence over env).
    api_key = _get_db_setting("llm_api_key", "") or settings.llm.api_key_for(provider)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=f"No API key configured for provider '{provider}'. "
            "Set it via Settings → LLM Provider or the environment variable.",
        )

    # ------------------------------------------------------------------ groq
    if provider == "groq":
        # Groq exposes rate-limit state via response headers on any call.
        # We send a minimal 1-token prompt to a cheap model and harvest the headers.
        try:
            import httpx

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
        try:
            import httpx

            base_url = (
                _get_db_setting("llm_base_url", "")
                or settings.llm.base_url_for(provider)
                or "https://api.mistral.ai/v1"
            )
            resp = await asyncio.to_thread(
                lambda: httpx.get(
                    f"{base_url}/usage",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=15,
                )
            )
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail=f"Mistral usage call failed: {exc}"
            ) from exc

        if resp.status_code == 200:
            return {"provider": "mistral", **resp.json()}
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Mistral /v1/usage returned {resp.status_code}: {resp.text[:300]}",
        )

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
                "gemini-2.0-flash": {"rpm": 15, "tpm": 1_000_000, "rpd": 1_500},
                "gemini-1.5-flash": {"rpm": 15, "tpm": 1_000_000, "rpd": 1_500},
                "gemini-1.5-pro": {"rpm": 2, "tpm": 32_000, "rpd": 50},
            },
            "dashboard_url": "https://aistudio.google.com/app/apikey",
        }

    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider!r}")
