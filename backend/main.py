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

from fastapi import BackgroundTasks, Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

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
    get_paper_orders,
    get_recent_analyses,
    get_recent_signals,
    get_setting,
    get_usage_stats,
    init_db,
    set_setting,
    update_paper_order_status,
)
from .scheduler import scan_ticker_async, scheduler, sync_paper_orders

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


def _sse_frame(payload: dict[str, Any]) -> str:
    """Encode *payload* as a single SSE data frame (``data: ...\\n\\n``)."""
    return f"data: {json.dumps(payload)}\n\n"


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


class BacktestCompareRequest(BaseModel):
    run_ids: list[int] = Field(
        ..., min_length=2, max_length=5, description="2-5 run IDs to compare"
    )


class BacktestRequest(BaseModel):
    tickers: list[str] = Field(..., min_length=1, description="Ticker symbols to replay")
    start_date: str = Field(..., description="Replay window start (YYYY-MM-DD)")
    end_date: str = Field(..., description="Replay window end (YYYY-MM-DD)")
    initial_balance: float = Field(10_000.0, gt=0, description="Virtual wallet starting balance")
    confidence_floor: float | None = Field(
        None,
        ge=0,
        le=100,
        description="Confidence floor override (default: system setting)",
    )
    max_hold_days: int = Field(10, ge=1, le=120, description="Days before timing out a trade")
    use_llm: bool = Field(False, description="Run LLM analysis on each replay day (slower)")
    atr_multiple: float = Field(1.5, gt=0, description="ATR multiple for stop distance")
    reward_risk: float = Field(2.0, gt=0, description="Reward-to-risk ratio for target")
    requests_per_minute: int | None = Field(
        None, ge=1, description="LLM RPM cap (None = no throttle)"
    )
    scan_interval_minutes: int = Field(
        1440,
        ge=5,
        le=1440,
        description=(
            "How often to check for signals within each trading day. "
            "1440 = once at end-of-day (default). "
            "Common values: 15, 30, 60, 120, 240, 480."
        ),
    )
    is_out_of_sample: bool = Field(
        False,
        description="Mark this window as a held-out test set (OOS). Used by AI Review evidence.",
    )
    max_concurrent_tickers: int | None = Field(
        None,
        ge=1,
        le=20,
        description="Max tickers processed in parallel (None = use system default)",
    )
    max_concurrent_llm: int | None = Field(
        None,
        ge=1,
        le=10,
        description="Max simultaneous LLM calls (None = use system default)",
    )
    position_size_pct: float = Field(
        0.10,
        ge=0.01,
        le=0.50,
        description=(
            "Virtual wallet: fraction of initial_balance invested per signal "
            "(0.01 = 1%, 0.10 = 10%, 0.50 = 50%). Stored in metrics_json."
        ),
    )
    cashout_r: float | None = Field(
        None,
        ge=0.1,
        le=10.0,
        description=(
            "Early profit-taking: close a trade as soon as its unrealised R "
            "reaches this level, before the original target. None = disabled."
        ),
    )


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
# Admin token middleware — gates all routes when ADMIN_TOKEN is configured.
# /health and /auth/verify are always open (health probe + login endpoint).
# When ADMIN_TOKEN is not set the middleware is a no-op (local / dev mode).
# --------------------------------------------------------------------------- #
_UNPROTECTED_PATHS = {"/health", "/auth/verify"}


class _AdminTokenMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):  # type: ignore[override]
        if request.method == "OPTIONS" or request.url.path in _UNPROTECTED_PATHS:
            return await call_next(request)
        expected = get_settings().admin_token or get_setting("admin_token", "")
        if not expected:
            return await call_next(request)  # dev mode: no token configured → open
        auth_header = request.headers.get("Authorization", "")
        token = auth_header.removeprefix("Bearer ").strip()
        if token != expected:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)


app.add_middleware(_AdminTokenMiddleware)


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


@app.post("/auth/verify")
def auth_verify(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Validate the admin token.  Always open (no auth required — this is the login endpoint).

    Returns ``{"ok": true, "dev_mode": true}`` when no token is configured
    (accepts any input — safe for local / dev deployments only).
    Returns ``{"ok": true, "dev_mode": false}`` on a correct token.
    Returns HTTP 401 on a wrong token.
    """
    token: str = body.get("token", "")
    expected = get_settings().admin_token or get_setting("admin_token", "")
    if not expected:
        return {"ok": True, "dev_mode": True}
    if token == expected:
        return {"ok": True, "dev_mode": False}
    raise HTTPException(status_code=401, detail="Invalid token.")


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


class SignalScanLlmRequest(BaseModel):
    enabled: bool


@app.post("/settings/signal-scan-llm")
def set_signal_scan_llm(request: SignalScanLlmRequest) -> dict[str, Any]:
    """Enable or disable LLM calls for live signal scanning.

    When disabled the AI-analysis skill is skipped and the pipeline runs
    in rules-only mode — no LLM API quota is consumed by the scheduler.
    Takes effect immediately (no restart required).
    """
    set_setting("signal_scan_llm_enabled", "true" if request.enabled else "false")
    return {"signal_scan_llm_enabled": request.enabled}


# ── Alpaca paper-trading settings ──────────────────────────────────────────


class AlpacaSettingsRequest(BaseModel):
    paper_url: str | None = None
    key_id: str | None = None
    secret_key: str | None = None
    position_size: float | None = Field(None, ge=1, le=1_000_000)
    min_confidence: float | None = Field(None, ge=0, le=100)
    enabled: bool | None = None
    # When True, clear DB-stored credentials so the client falls back to env vars.
    use_env: bool | None = None


@app.post("/settings/alpaca")
def set_alpaca_settings(request: AlpacaSettingsRequest) -> dict[str, Any]:
    """Persist Alpaca paper-trading credentials and trade parameters to DB.

    All fields are optional — only non-None values are written.
    When ``use_env=True`` the DB-stored key_id/secret are cleared so the
    Alpaca client falls back to env-var values (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY).
    Takes effect immediately (no restart required).
    """
    if request.use_env:
        # Clear DB overrides — client will read env vars directly.
        set_setting("alpaca_key_id", "")
        set_setting("alpaca_secret_key", "")
    else:
        if request.key_id is not None:
            set_setting("alpaca_key_id", request.key_id.strip())
        if request.secret_key is not None:
            set_setting("alpaca_secret_key", request.secret_key.strip())
    if request.paper_url is not None:
        set_setting("alpaca_paper_url", request.paper_url.strip())
    if request.position_size is not None:
        set_setting("paper_trade_position_size", str(request.position_size))
    if request.min_confidence is not None:
        set_setting("paper_trade_min_confidence", str(request.min_confidence))
    if request.enabled is not None:
        set_setting("paper_trading_enabled", "true" if request.enabled else "false")
    return {"saved": True}


# ── Paper trading data endpoints ───────────────────────────────────────────


@app.get("/paper/account")
def paper_account() -> dict[str, Any]:
    """Return live Alpaca paper account summary (equity, buying_power, etc.).

    Always attempts the Alpaca call regardless of the paper_trading_enabled flag
    so the Settings page can test credentials before the feature is switched on.
    """
    from .alpaca import AlpacaError, get_client  # local import

    try:
        client = get_client()
        account = client.get_account()
        return {"enabled": True, "account": account}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class AlpacaTestRequest(BaseModel):
    key_id: str | None = None
    secret_key: str | None = None
    paper_url: str | None = None


@app.post("/settings/alpaca/test")
def test_alpaca_connection(request: AlpacaTestRequest) -> dict[str, Any]:
    """Test Alpaca credentials without saving them to the DB.

    Accepts credentials directly in the request body — uses whatever is currently
    typed in the Settings form, before the user clicks Save.  Falls back to saved
    DB / env values for any field left blank.
    """
    from .alpaca import AlpacaClient, AlpacaError  # local import

    try:
        client = AlpacaClient(
            key_id=request.key_id or None,
            secret_key=request.secret_key or None,
            base_url=request.paper_url or None,
        )
        account = client.get_account()
        return {"ok": True, "account": account}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/paper/orders")
def paper_orders_list(limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    """Return paper orders from the local DB (most recent first)."""
    rows = get_paper_orders(limit=limit)
    return {"count": len(rows), "orders": rows}


@app.get("/paper/positions")
def paper_positions() -> dict[str, Any]:
    """Return live open positions from Alpaca."""
    from .alpaca import AlpacaError, get_client  # local import

    if get_setting("paper_trading_enabled", "true") != "true":
        return {"enabled": False, "positions": []}
    try:
        client = get_client()
        positions = client.get_positions()
        return {"enabled": True, "positions": positions}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class ManualOrderRequest(BaseModel):
    ticker: str
    side: str  # "buy" | "sell"
    entry: float  # current price — used to compute share qty
    stop: float
    target: float
    notional: float = 500.0
    signal_id: int | None = None
    signal_confidence: float | None = None
    signal_source: str | None = None
    signal_timestamp: str | None = None


@app.post("/paper/orders/place")
def place_paper_order_manual(req: ManualOrderRequest) -> dict[str, Any]:
    """Place a single paper bracket order manually (from Explorer or signal card).

    De-duplicates by signal_id when provided: returns the existing order if one
    already exists for that signal rather than placing a second one.
    """
    from .alpaca import AlpacaError, get_client
    from .database import (
        get_open_order_by_ticker_side,
        get_paper_order_by_signal,
        save_paper_order,
    )

    if get_setting("paper_trading_enabled", "true") != "true":
        raise HTTPException(
            status_code=400,
            detail="Paper trading is disabled — enable it in Settings → Paper Trading.",
        )

    # De-dup guard — by signal_id (exact) or by open ticker+side (prevents duplicates)
    if req.signal_id and get_paper_order_by_signal(req.signal_id):
        return {
            "placed": False,
            "reason": "order_exists",
            "detail": f"Order already exists for signal {req.signal_id}",
        }
    if get_open_order_by_ticker_side(req.ticker, req.side):
        return {
            "placed": False,
            "reason": "ticker_open",
            "detail": f"An open {req.side} order for {req.ticker} already exists",
        }

    notional = float(get_setting("paper_trade_position_size", "") or req.notional)

    try:
        client = get_client()
        result = client.place_bracket_order(
            ticker=req.ticker,
            side=req.side,
            notional=notional,
            entry_price=req.entry,
            stop_price=req.stop,
            take_profit_price=req.target,
        )
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    alpaca_order_id = result.get("id")
    save_paper_order(
        {
            "signal_id": req.signal_id,
            "ticker": req.ticker,
            "side": req.side,
            "alpaca_order_id": alpaca_order_id,
            "status": result.get("status", "pending"),
            "notional": notional,
            "entry_price": req.entry,
            "stop_price": req.stop,
            "take_profit_price": req.target,
            "signal_confidence": req.signal_confidence,
            "signal_source": req.signal_source,
            "signal_timestamp": req.signal_timestamp,
        }
    )
    return {
        "placed": True,
        "alpaca_order_id": alpaca_order_id,
        "status": result.get("status"),
    }


@app.post("/paper/orders/{order_id}/cancel")
def cancel_paper_order(order_id: int) -> dict[str, Any]:
    """Cancel a pending paper order by its DB id."""
    from .alpaca import AlpacaError, get_client  # local import

    orders = get_paper_orders(limit=1000)
    target = next((o for o in orders if o["id"] == order_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Order not found")
    alpaca_id = target.get("alpaca_order_id")
    if not alpaca_id:
        raise HTTPException(status_code=400, detail="Order has no Alpaca order ID")
    try:
        client = get_client()
        client.cancel_order(alpaca_id)
        update_paper_order_status(alpaca_id, {"status": "cancelled"})
        return {"cancelled": True, "alpaca_order_id": alpaca_id}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/paper/sync")
async def paper_sync() -> dict[str, Any]:
    """Trigger an immediate poll of Alpaca order statuses."""
    await sync_paper_orders()
    return {"synced": True}


@app.get("/paper/clock")
def paper_clock() -> dict[str, Any]:
    """Return Alpaca market clock (is_open, next_open, next_close)."""
    from .alpaca import AlpacaError, get_client  # local import

    try:
        return get_client().get_clock()
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/paper/history")
def paper_portfolio_history(
    period: str = Query("1M", pattern=r"^\d+[DWMA]$"),
    timeframe: str = Query("1D", pattern=r"^(1|5|15|30)Min$|^1[HD]$"),
) -> dict[str, Any]:
    """Return Alpaca portfolio equity curve for the given period/timeframe."""
    from .alpaca import AlpacaError, get_client  # local import

    try:
        return get_client().get_portfolio_history(period=period, timeframe=timeframe)
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/paper/market/snapshots")
def market_snapshots(
    symbols: str = Query(..., description="Comma-separated tickers")
) -> dict[str, Any]:
    """Live market data snapshots for the given tickers (single Alpaca call).

    Returns per-ticker: latest price, day OHLCV, prev-close, VWAP, volume,
    bid/ask.  Does not require paper_trading_enabled — only valid credentials.
    """
    from .alpaca import AlpacaError, get_client  # local import

    tickers = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not tickers:
        raise HTTPException(status_code=400, detail="symbols required")
    try:
        raw = get_client().get_snapshots(tickers)
        # Normalise to a friendlier shape so the frontend doesn't have to decode
        # Alpaca's single-letter field names (c=close, h=high, l=low, v=volume…)
        result: dict[str, Any] = {}
        for ticker, snap in raw.items():
            daily = snap.get("dailyBar") or {}
            prev = snap.get("prevDailyBar") or {}
            minute = snap.get("minuteBar") or {}
            trade = snap.get("latestTrade") or {}
            quote = snap.get("latestQuote") or {}
            close = daily.get("c") or minute.get("c")
            prev_close = prev.get("c")
            day_chg = (close - prev_close) if (close and prev_close) else None
            day_chg_pct = (
                (day_chg / prev_close * 100) if (day_chg is not None and prev_close) else None
            )
            result[ticker] = {
                "price": trade.get("p") or minute.get("c"),
                "open": daily.get("o"),
                "high": daily.get("h"),
                "low": daily.get("l"),
                "close": close,
                "vwap": daily.get("vw"),
                "volume": daily.get("v"),
                "trades": daily.get("n"),
                "prev_close": prev_close,
                "day_chg": round(day_chg, 4) if day_chg is not None else None,
                "day_chg_pct": (round(day_chg_pct, 4) if day_chg_pct is not None else None),
                "bid": quote.get("bp"),
                "ask": quote.get("ap"),
                "last_trade_at": trade.get("t"),
                "minute_close": minute.get("c"),
            }
        return {"snapshots": result}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


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
        "rules_checked": result.get("rules_checked"),
        "saved_signal_ids": result["saved_signal_ids"],
        "alerts": result["alerts"],
        "errors": result["errors"],
    }


@app.post("/analyze/stream")
async def analyze_ticker_stream(
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
                "rules_checked": ctx.rules_checked,
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


# --------------------------------------------------------------------------- #
# Data cache management
# --------------------------------------------------------------------------- #
@app.get("/data/cache/stats")
def cache_stats() -> dict[str, Any]:
    """Return current data-cache statistics (entry count, size, age range)."""
    from .database import get_cache_stats

    stats = get_cache_stats()
    stats["total_kb"] = round((stats.get("total_bytes") or 0) / 1024, 1)
    return stats


@app.delete("/data/cache")
def evict_cache(older_than_hours: int = Query(168, ge=1, le=8760)) -> dict[str, Any]:
    """Evict data-cache entries older than *older_than_hours* hours (default 7 days).

    Pass ``older_than_hours=0`` to clear everything (minimum enforced at 1).
    """
    from .database import evict_cache_entries

    deleted = evict_cache_entries(older_than_hours=older_than_hours)
    return {"deleted": deleted, "older_than_hours": older_than_hours}


@app.get("/settings/performance")
def get_performance_settings() -> dict[str, Any]:
    """Return current parallelism settings and provider rate-limit reference."""
    from .config import get_settings as _cfg
    from .database import get_setting

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


@app.post("/settings/performance")
def save_performance_settings(
    concurrent_tickers: int = Query(..., ge=1, le=20),
    concurrent_llm: int = Query(..., ge=1, le=10),
) -> dict[str, Any]:
    """Persist parallelism settings to the DB."""
    from .database import set_setting

    set_setting("concurrent_tickers", str(concurrent_tickers))
    set_setting("concurrent_llm", str(concurrent_llm))
    return {
        "concurrent_tickers": concurrent_tickers,
        "concurrent_llm": concurrent_llm,
        "saved": True,
    }


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


# --------------------------------------------------------------------------- #
# Backtesting endpoints
# --------------------------------------------------------------------------- #
@app.post("/backtest/stream")
async def backtest_stream(request: BacktestRequest) -> StreamingResponse:
    """Run a backtest and stream progress + result as SSE events.

    Event types emitted:
    * ``{"type":"progress", "ticker":..., "day":..., "pct":...}``
    * ``{"type":"fallback", "from":..., "to":..., "reason":...}`` (LLM mode)
    * ``{"type":"quota_stop", "ticker":..., "day":..., "msg":...}`` (LLM quota)
    * ``{"type":"result", "run_id":..., "report":...}``
    * ``{"type":"error", "msg":...}``
    """
    from .backtest import BacktestParams, run_backtest
    from .config import get_settings as _cfg

    # Validate and sanitise each ticker.
    clean_tickers = [_clean_ticker(t) for t in request.tickers]

    # Resolve confidence floor (request overrides system setting).
    floor = (
        request.confidence_floor
        if request.confidence_floor is not None
        else _cfg().thresholds.confidence_floor
    )

    params = BacktestParams(
        tickers=clean_tickers,
        start_date=request.start_date,
        end_date=request.end_date,
        initial_balance=request.initial_balance,
        confidence_floor=floor,
        max_hold_days=request.max_hold_days,
        use_llm=request.use_llm,
        atr_multiple=request.atr_multiple,
        reward_risk=request.reward_risk,
        requests_per_minute=request.requests_per_minute,
        scan_interval_minutes=request.scan_interval_minutes,
        is_out_of_sample=request.is_out_of_sample,
        position_size_pct=request.position_size_pct,
        cashout_r=request.cashout_r,
        max_concurrent_tickers=(
            request.max_concurrent_tickers
            or int(get_setting("concurrent_tickers") or 0)
            or _cfg().concurrent_tickers
        ),
        max_concurrent_llm=(
            request.max_concurrent_llm
            or int(get_setting("concurrent_llm") or 0)
            or _cfg().concurrent_llm
        ),
    )

    event_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def _emit(evt: dict[str, Any]) -> None:
        event_queue.put_nowait(evt)

    async def _stream():
        async def _run():
            try:
                report = await asyncio.to_thread(run_backtest, params, emit=_emit)
                event_queue.put_nowait(
                    {
                        "type": "result",
                        "run_id": report["run_id"],
                        "report": report,
                    }
                )
            except Exception as exc:
                event_queue.put_nowait({"type": "error", "msg": "Backtest failed; check logs."})
                _log.exception("backtest_stream error: %s", _log_safe(str(exc)))
            finally:
                event_queue.put_nowait(None)  # sentinel

        task = asyncio.create_task(_run())
        try:
            while True:
                evt = await event_queue.get()
                if evt is None:
                    break
                yield _sse_frame(evt)
        finally:
            task.cancel()

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/backtest")
def list_backtest_runs() -> dict[str, Any]:
    """List all backtest runs, newest first."""
    from .database import get_backtest_runs

    return {"runs": get_backtest_runs()}


def _compute_comparability(runs: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Compute a comparability grade for a set of backtest runs.

    Returns ``(grade, reasons)`` where grade is ``"full"``, ``"partial"``, or ``"none"``.
    """
    reasons: list[str] = []
    r0 = runs[0]
    same_tickers = all(
        sorted(r.get("tickers") or []) == sorted(r0.get("tickers") or []) for r in runs
    )
    same_window = all(
        r.get("start_date") == r0.get("start_date") and r.get("end_date") == r0.get("end_date")
        for r in runs
    )
    same_params = all(
        r.get("atr_multiple") == r0.get("atr_multiple")
        and r.get("reward_risk") == r0.get("reward_risk")
        for r in runs
    )
    modes = {r.get("signal_mode") for r in runs}
    if same_tickers and same_window and same_params:
        if len(modes) > 1:
            reasons.append("Same universe, window, and execution params; signal_mode is controlled")
        else:
            reasons.append("All run parameters are identical")
        return "full", reasons
    if same_tickers:
        if not same_window:
            reasons.append("Date windows differ between runs")
        if not same_params:
            reasons.append("ATR multiple or reward_risk differ between runs")
        return "partial", reasons
    reasons.append("Different ticker universes — runs are not directly comparable")
    return "none", reasons


@app.post("/backtest/compare")
async def backtest_compare(
    request: BacktestCompareRequest,
) -> dict[str, Any]:
    """Ask the LLM to compare 2-5 backtest runs using the v2 comparability-gated methodology.

    Returns ``comparability``, ``summary``, ``winner_run_id``, ``winner_confidence``,
    ``llm_value_add``, per-run ``strengths``/``weaknesses``, and ``recommendation``.
    Persisted to ``backtest_compares`` for full historicity.
    """
    from .analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from .database import get_backtest_run, save_backtest_compare

    # Load every requested run; 404 on any missing.
    runs: list[dict[str, Any]] = []
    for rid in request.run_ids:
        r = get_backtest_run(rid)
        if r is None:
            raise HTTPException(status_code=404, detail=f"Backtest run {rid} not found.")
        runs.append(r)

    # Compute comparability grade before calling LLM.
    comparability, comp_reasons = _compute_comparability(runs)

    # Build matched mode pairs (rules vs LLM on same universe+window).
    rules_runs = [r for r in runs if r.get("signal_mode") == "rules"]
    llm_runs = [r for r in runs if r.get("signal_mode") == "llm"]
    matched_pairs = [
        {
            "rules_run_id": str(rr["id"]),
            "llm_or_hybrid_run_id": str(lr["id"]),
            "paired_delta_expectancy_r": round(
                (lr.get("metrics", {}).get("avg_r_multiple") or 0)
                - (rr.get("metrics", {}).get("avg_r_multiple") or 0),
                3,
            ),
        }
        for rr in rules_runs
        for lr in llm_runs
        if sorted(rr.get("tickers") or []) == sorted(lr.get("tickers") or [])
        and rr.get("start_date") == lr.get("start_date")
    ]

    # Build the v2 comparison payload.
    run_summaries = []
    for r in runs:
        m = r.get("metrics") or {}
        run_summaries.append(
            {
                "run_id": str(r["id"]),
                "mode": r.get("signal_mode", "rules"),
                "model_id": r.get("llm_model"),
                "is_out_of_sample": bool(r.get("is_out_of_sample")),
                "total_trades": m.get("total_trades", 0),
                "effective_trades": m.get("effective_trades", m.get("total_trades", 0)),
                "win_rate": m.get("win_rate"),
                "avg_r_multiple": m.get("avg_r_multiple"),
                "expectancy_ci95": m.get("expectancy_ci95"),
                "sharpe": m.get("sharpe"),
                "max_drawdown_r": m.get("max_drawdown"),
                "after_cost_avg_r": m.get("after_cost_avg_r"),
                "fee_stress_pass": m.get("fee_stress_pass"),
                "ticker_concentration": m.get("ticker_concentration"),
                "confidence_floor": r.get("confidence_floor"),
            }
        )

    comparison_payload = {
        "comparison_id": f"cmp_{'_'.join(str(i) for i in request.run_ids)}",
        "comparability": {
            "backend_grade": comparability,
            "matched_fields": [],
            "different_fields": [],
            "normalization_notes": comp_reasons,
        },
        "runs": run_summaries,
        "matched_mode_pairs": matched_pairs,
    }

    _subs = {"backtest_comparison_json": json.dumps(comparison_payload, default=str)}
    user_prompt = _load_prompt("backtest_compare_user.md")
    for _k, _v in _subs.items():
        user_prompt = user_prompt.replace(f"{{{_k}}}", _v)
    system_prompt = _load_prompt("backtest_compare_system.md")

    try:
        raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {exc}") from exc
    except Exception as exc:
        _log.exception("backtest_compare error: %s", _log_safe(str(exc)))
        raise HTTPException(status_code=503, detail=f"Compare failed: {exc}") from exc

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        result: dict[str, Any] = json.loads(cleaned)
    except Exception:
        result = {
            "summary": raw,
            "comparability": comparability,
            "winner_run_id": None,
            "winner_confidence": "none",
            "per_run": [],
            "recommendation": "",
        }

    # Schema validation + one-shot repair (pass system_prompt so repair uses the
    # compare instructions, not the default signal-scan prompt).
    errs = _validate_llm_json(result, "backtest_comparison.schema.json")
    if errs:
        _log.warning(
            "backtest_compare v2 schema errors: %s",
            str(errs).replace("\r", "").replace("\n", ""),
        )
        try:
            repaired = _repair_llm_json(raw, errs, call_llm, system_prompt)
            result = json.loads(repaired)
        except Exception:  # noqa: S110
            pass

    # Inject backend-computed comparability so frontend always has it.
    result.setdefault("comparability", comparability)
    result.setdefault("comparability_reasons", comp_reasons)
    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct

    try:
        save_backtest_compare(
            run_ids=request.run_ids,
            result_json=json.dumps(result, default=str),
            llm_provider=get_setting("llm_provider") or get_settings().llm.provider,
            llm_model=model_used,
            prompt_tokens=pt or 0,
            completion_tokens=ct or 0,
        )
    except Exception:  # noqa: S110
        pass  # non-fatal

    return result


@app.post("/backtest/{run_id}/experiment-advisor")
async def backtest_experiment_advisor(run_id: int) -> dict[str, Any]:
    """Experiment Selector v2: backend generates candidates; LLM selects one.

    Returns the ``selected_candidate`` (full dict with hypothesis, changes,
    success/failure criteria, overfitting_risk) plus ``reasoning``,
    ``model_used``, ``prompt_tokens``, ``completion_tokens``.
    Persisted to ``backtest_floor_suggests`` for full historicity.
    """
    from .analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from .backtest import generate_experiment_candidates
    from .database import get_backtest_run, save_backtest_floor_suggest

    run = get_backtest_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")

    metrics = run.get("metrics") or {}
    floor_sweep: list[dict] = metrics.get("floor_sweep") or []

    # Backend generates candidates; LLM only selects.
    # ATR and hold-day candidates are always available; floor candidates require floor_sweep.
    candidates = generate_experiment_candidates(run)
    if not candidates:
        raise HTTPException(
            status_code=422,
            detail=(
                "Could not generate experiment candidates. "
                "Run a backtest first — floor sweep candidates require at least one completed run."
            ),
        )

    current_floor = run.get("confidence_floor") or 65

    selection_payload = {
        "current_run": {
            "run_id": str(run_id),
            "is_out_of_sample": bool(run.get("is_out_of_sample")),
            "metrics": {
                "total_trades": metrics.get("total_trades", 0),
                "win_rate": metrics.get("win_rate"),
                "avg_r_multiple": metrics.get("avg_r_multiple"),
                "expectancy_ci95": metrics.get("expectancy_ci95"),
                "sharpe": metrics.get("sharpe"),
                "max_drawdown_r": metrics.get("max_drawdown"),
                "after_cost_avg_r": metrics.get("after_cost_avg_r"),
                "fee_stress_pass": metrics.get("fee_stress_pass"),
            },
            "diagnostics": {
                "performance_by_floor_train": floor_sweep,
                "performance_by_ticker": metrics.get("per_ticker") or [],
            },
        },
        "research_constraints": {
            "minimum_effective_trades": 10,
            "unchanged_fields": ["tickers", "start_date", "end_date"],
            "objective": "Improve after-cost expectancy (avg_r) while maintaining ≥10 trades",
        },
        "candidate_experiments": candidates,
    }

    _subs = {"experiment_selection_json": json.dumps(selection_payload, default=str)}
    user_prompt = _load_prompt("experiment_selector_user.md")
    for _k, _v in _subs.items():
        user_prompt = user_prompt.replace(f"{{{_k}}}", _v)
    system_prompt = _load_prompt("experiment_selector_system.md")

    try:
        raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {exc}") from exc
    except Exception as exc:
        _log.error("backtest_experiment_advisor error for run %d", run_id)
        raise HTTPException(status_code=503, detail=f"Experiment Advisor failed: {exc}") from exc

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        result: dict[str, Any] = json.loads(cleaned)
    except Exception:
        result = {"selected_candidate_id": None, "reasoning": raw}

    # Schema validation + one-shot repair (pass system_prompt so repair uses the
    # experiment-selector instructions, not the default signal-scan prompt).
    errs = _validate_llm_json(result, "experiment_selection.schema.json")
    if errs:
        _log.warning(
            "experiment_advisor v2 schema errors run=%d: %s",
            run_id,
            str(errs).replace("\r", "").replace("\n", ""),
        )
        try:
            repaired = _repair_llm_json(raw, errs, call_llm, system_prompt)
            result = json.loads(repaired)
        except Exception:  # noqa: S110
            pass

    # Resolve the selected candidate from the backend-generated list.
    sel_id = result.get("selected_candidate_id")
    selected_candidate = next((c for c in candidates if c.get("candidate_id") == sel_id), None)

    # LLM returned null or an unrecognised ID — auto-pick the safest (lowest
    # overfitting_risk) candidate so the card is never empty.  Mark it so the
    # frontend can show an "auto-selected" note.
    if selected_candidate is None and candidates:
        low_risk = [c for c in candidates if c.get("overfitting_risk") == "low"]
        selected_candidate = dict(low_risk[0] if low_risk else candidates[0])
        selected_candidate["_auto_selected"] = True
        _log.info(
            "experiment_advisor run=%d: LLM returned unknown id %s; auto-selected %s",
            run_id,
            str(sel_id).replace("\r", "").replace("\n", ""),
            str(selected_candidate["candidate_id"]).replace("\r", "").replace("\n", ""),
        )

    result["selected_candidate"] = selected_candidate
    result["candidates"] = candidates  # send all so frontend can show alternatives
    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct
    # Normalise v2 schema field names → what frontend reads.
    # schema: "why" → reasoning, "diagnosis" + "next_step" kept as-is.
    if "reasoning" not in result:
        result["reasoning"] = result.get("why") or result.get("diagnosis") or ""

    # Persist using the floor from the selected candidate (if any).
    selected_floor = int(
        (selected_candidate or {}).get("changes", {}).get("confidence_floor") or current_floor
    )
    try:
        save_backtest_floor_suggest(
            run_id=run_id,
            recommended_floor=selected_floor,
            reasoning=result.get("reasoning"),
            trade_off=result.get("next_action"),
            result_json=json.dumps(result, default=str),
            llm_provider=get_setting("llm_provider") or get_settings().llm.provider,
            llm_model=model_used,
            prompt_tokens=pt or 0,
            completion_tokens=ct or 0,
        )
    except Exception:  # noqa: S110
        pass  # non-fatal

    return result


@app.get("/backtest/profiles")
def list_backtest_profiles() -> dict[str, Any]:
    """Return all saved backtest parameter profiles, newest first."""
    from .database import get_backtest_profiles

    return {"profiles": get_backtest_profiles()}


@app.post("/backtest/profiles")
def save_backtest_profile_endpoint(
    body: dict[str, Any] = Body(...),
) -> dict[str, Any]:
    """Upsert a named backtest profile.  Body: ``{name, params}``."""
    from .database import save_backtest_profile

    name: str = (body.get("name") or "").strip()
    params: dict[str, Any] = body.get("params") or {}
    if not name:
        raise HTTPException(status_code=400, detail="name is required.")
    return save_backtest_profile(name, params)


@app.delete("/backtest/profiles/{profile_id}")
def delete_backtest_profile_endpoint(profile_id: int) -> dict[str, Any]:
    """Delete a saved backtest profile by id."""
    from .database import delete_backtest_profile

    deleted = delete_backtest_profile(profile_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Profile {profile_id} not found.")
    return {"deleted": True, "id": profile_id}


@app.get("/backtest/{run_id}")
def get_backtest_run_detail(run_id: int) -> dict[str, Any]:
    """Return a single backtest run with all its trades."""
    from .database import get_backtest_run

    run = get_backtest_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")
    return run


@app.delete("/backtest/{run_id}")
def delete_backtest_run_endpoint(run_id: int) -> dict[str, Any]:
    """Delete a backtest run and its trades."""
    from .database import delete_backtest_run

    deleted = delete_backtest_run(run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")
    return {"deleted": True, "run_id": run_id}


_PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "prompts")


def _load_prompt(filename: str) -> str:
    """Load a prompt template from ``backend/prompts/``."""
    path = os.path.normpath(os.path.join(_PROMPTS_DIR, filename))
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


@app.post("/backtest/{run_id}/review")
async def backtest_review(run_id: int) -> dict[str, Any]:
    """Ask the LLM to evaluate a backtest run using the v2 methodology.

    Returns: ``verdict``, ``deployment_stage``, ``edge_assessment``, ``evidence_quality``,
    ``strengths``, ``weaknesses``, ``blocking_issues``, ``next_action``,
    ``model_used``, ``prompt_tokens``, ``completion_tokens``.
    """
    from .analysis import LLMError, _repair_llm_json, _validate_llm_json, call_llm
    from .database import (
        get_backtest_run,
        save_backtest_review_tokens,
        update_backtest_run,
    )

    run = get_backtest_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Backtest run {run_id} not found.")

    metrics = run.get("metrics") or {}

    # Build enriched v2 payload for the LLM.
    review_payload = {
        "run": {
            "run_id": str(run_id),
            "mode": run.get("signal_mode", "rules"),
            "universe": run.get("tickers") or [],
            "start": run.get("start_date", ""),
            "end": run.get("end_date", ""),
            "is_out_of_sample": bool(run.get("is_out_of_sample")),
        },
        "metric_definitions": {
            "return_frequency": "per_trade",
            "sharpe_method": "mean_R / std_R",
            "max_drawdown_unit": "R",
            "false_positive_definition": "losing trade",
        },
        "metrics": {
            "total_trades": metrics.get("total_trades", 0),
            "effective_trades": metrics.get("effective_trades", metrics.get("total_trades", 0)),
            "win_rate": metrics.get("win_rate"),
            "avg_r_multiple": metrics.get("avg_r_multiple"),
            "expectancy_ci95": metrics.get("expectancy_ci95"),
            "sharpe": metrics.get("sharpe"),
            "max_drawdown_r": metrics.get("max_drawdown"),
            "false_positive_rate": metrics.get("false_positive_rate"),
            "after_cost_avg_r": metrics.get("after_cost_avg_r"),
        },
        "robustness": {
            "fee_stress_pass": metrics.get("fee_stress_pass"),
            "ticker_concentration": metrics.get("ticker_concentration"),
            "number_of_trials": 1,
            "untouched_holdout": bool(run.get("is_out_of_sample")),
        },
        "per_ticker": metrics.get("per_ticker") or [],
        "backend_flags": [],
    }

    _subs = {"backtest_run_json": json.dumps(review_payload, default=str)}
    user_prompt = _load_prompt("backtest_review_user.md")
    for _k, _v in _subs.items():
        user_prompt = user_prompt.replace(f"{{{_k}}}", _v)
    system_prompt = _load_prompt("backtest_review_system.md")

    try:
        raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)
    except LLMError as exc:
        raise HTTPException(status_code=503, detail=f"LLM unavailable: {exc}") from exc
    except Exception as exc:
        _log.error("backtest_review error for run %d", run_id)
        raise HTTPException(status_code=503, detail=f"Review failed: {exc}") from exc

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        result: dict[str, Any] = json.loads(cleaned)
    except Exception:
        result = {
            "verdict": raw,
            "deployment_stage": "research_only",
            "edge_assessment": "inconclusive",
            "evidence_quality": "weak",
            "strengths": [],
            "weaknesses": [],
            "blocking_issues": [],
            "next_action": "Inspect raw LLM output",
        }

    # Schema validation + one-shot repair (pass system_prompt so repair uses the
    # review instructions, not the default signal-scan prompt).
    errs = _validate_llm_json(result, "backtest_review.schema.json")
    if errs:
        _log.warning(
            "backtest_review v2 schema errors run=%d: %s",
            run_id,
            str(errs).replace("\r", "").replace("\n", ""),
        )
        try:
            repaired = _repair_llm_json(raw, errs, call_llm, system_prompt)
            result = json.loads(repaired)
        except Exception:  # noqa: S110
            pass

    result["model_used"] = model_used
    result["prompt_tokens"] = pt
    result["completion_tokens"] = ct

    # Persist token usage + deployment_stage.
    try:
        save_backtest_review_tokens(run_id, pt or 0, ct or 0)
        stage = result.get("deployment_stage")
        if stage:
            update_backtest_run(run_id, status="done", deployment_stage=stage)
    except Exception:  # noqa: S110
        pass  # non-fatal

    return result
