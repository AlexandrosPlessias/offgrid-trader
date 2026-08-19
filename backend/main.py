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
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
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
    init_db,
    set_setting,
)
from .scheduler import scan_ticker_async, scheduler

_log = logging.getLogger(__name__)


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
        None, ge=10, le=3600, description="Request timeout in seconds (10–3600)"  # noqa: RUF001
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
    return {
        "status": "ok",
        "version": __version__,
        "ollama_model": db_model or settings.ollama.model,
        "ollama_host": settings.ollama.host,
        "watchlist_size": len(settings.watchlist),
        "scheduler": scheduler.status(),
        "disclaimer": "Not financial advice.",
    }


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
def get_all_settings() -> dict[str, Any]:
    """Return current effective settings (env defaults overridden by DB values)."""
    cfg = get_settings()
    db_model = get_setting("ollama_model", "")
    db_timeout = get_setting("ollama_timeout", "")
    return {
        "ollama_model": db_model or cfg.ollama.model,
        "ollama_timeout": int(db_timeout) if db_timeout else cfg.ollama.timeout,
        "alerts_enabled": _alerts_enabled(),
        "env_model": cfg.ollama.model,
        "env_timeout": cfg.ollama.timeout,
        "scan_interval_minutes": scheduler.status()["scan_interval_minutes"],
        "scheduler_running": scheduler.status()["running"],
    }


@app.post("/settings/ollama")
def set_ollama_settings(request: OllamaSettingRequest) -> dict[str, Any]:
    """Persist Ollama model and/or timeout to the DB (no restart required)."""
    cfg = get_settings()
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


@app.get("/settings/models")
def list_ollama_models() -> dict[str, Any]:
    """Return models currently pulled in the local Ollama instance."""
    import requests as _req

    cfg = get_settings()
    try:
        resp = _req.get(f"{cfg.ollama.host}/api/tags", timeout=5)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
    except Exception as exc:
        models = []
        _log.warning("ollama /api/tags failed: %s", exc)
    return {"models": models}


@app.post("/analyze")
async def analyze_ticker(request: AnalyzeRequest) -> dict[str, Any]:
    """On-demand analysis for a single ticker."""
    ticker = request.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker is required")

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
async def analyze_ticker_stream(request: AnalyzeRequest) -> StreamingResponse:  # noqa: C901
    """On-demand analysis streamed as Server-Sent Events.

    Yields ``data: <json>`` lines for each pipeline step, then a final
    ``type:"result"`` event with the full analysis + market data.
    Results are persisted to the database (analysis_log + signals tables).
    """
    ticker = request.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker is required")

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
            _log.exception("unhandled error in SSE stream for %s", ticker)
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
    ticker = ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker is required")
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
    ticker = ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker is required")

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
                    "volume": int(row["Volume"]) if row["Volume"] == row["Volume"] else None,
                    "up": close is not None and prev_close is not None and close >= prev_close,
                }
            )
            prev_close = close
        return rows

    try:
        rows = await asyncio.to_thread(_fetch)
    except Exception as exc:
        _log.exception("candles fetch failed for %s", ticker)
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
