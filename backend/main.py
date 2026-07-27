"""FastAPI application exposing the offgrid-trader backend.

Endpoints
---------
* ``POST /analyze``               — on-demand analysis for any ticker.
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

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .config import get_settings
from .database import (
    get_analysis_history,
    get_effective_watchlist,
    get_recent_signals,
    get_setting,
    init_db,
    set_setting,
)
from .scheduler import scan_ticker_async, scheduler


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
        tracer.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint))
        )
        trace.set_tracer_provider(tracer)

        metrics.set_meter_provider(
            MeterProvider(
                resource=resource,
                metric_readers=[
                    PeriodicExportingMetricReader(
                        OTLPMetricExporter(endpoint=endpoint)
                    )
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

        FastAPIInstrumentor.instrument_app(
            app, excluded_urls="health"
        )
        RequestsInstrumentor().instrument()
        logging.getLogger(__name__).info("telemetry → %s", endpoint)
    except ImportError:
        print("[otel] opentelemetry packages missing — skipping telemetry")


# --------------------------------------------------------------------------- #
# Request / response models
# --------------------------------------------------------------------------- #
class AnalyzeRequest(BaseModel):
    ticker: str = Field(..., description="Ticker symbol, e.g. AAPL")
    send_alerts: bool = Field(
        False, description="Also dispatch alerts for actionable signals"
    )


class AddTickerRequest(BaseModel):
    ticker: str = Field(..., description="Ticker to add to the watchlist")


class AlertsSettingRequest(BaseModel):
    enabled: bool = Field(..., description="Enable or disable alert dispatch")


class TradingViewWebhook(BaseModel):
    """Loose schema for TradingView Pro alert payloads.

    TradingView lets users define arbitrary JSON, so only ``ticker`` (or
    ``symbol``) is required; everything else is captured for logging.
    """

    ticker: Optional[str] = None
    symbol: Optional[str] = None
    action: Optional[str] = None
    price: Optional[float] = None
    message: Optional[str] = None

    def resolved_ticker(self) -> Optional[str]:
        value = self.ticker or self.symbol
        return value.strip().upper() if value else None


# --------------------------------------------------------------------------- #
# App + lifespan
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise the DB and start/stop the background scheduler."""
    init_db()
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
def health() -> Dict[str, Any]:
    settings = get_settings()
    return {
        "status": "ok",
        "version": __version__,
        "ollama_model": settings.ollama.model,
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
def watchlist() -> Dict[str, Any]:
    settings = get_settings()
    return {
        "watchlist": get_effective_watchlist(),
        "scan_interval_minutes": settings.scan_interval_minutes,
        "scheduler": scheduler.status(),
        "alerts_enabled": _alerts_enabled(),
    }


@app.post("/watchlist")
def add_ticker(request: AddTickerRequest) -> Dict[str, Any]:
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
def remove_ticker(ticker: str) -> Dict[str, Any]:
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
def set_alerts(request: AlertsSettingRequest) -> Dict[str, Any]:
    set_setting("alerts_enabled", "true" if request.enabled else "false")
    return {"alerts_enabled": request.enabled}


@app.post("/analyze")
async def analyze_ticker(request: AnalyzeRequest) -> Dict[str, Any]:
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


@app.post("/webhook/tradingview")
async def tradingview_webhook(
    payload: TradingViewWebhook,
    background_tasks: BackgroundTasks,
) -> Dict[str, Any]:
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
    ticker: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Return recent stored signals, optionally filtered by ticker."""
    rows = get_recent_signals(limit=limit, ticker=ticker)
    return {"count": len(rows), "signals": rows}


@app.get("/analysis/{ticker}")
def analysis_history(
    ticker: str,
    limit: int = Query(20, ge=1, le=200),
) -> Dict[str, Any]:
    """Return the analysis-log history for *ticker*."""
    rows = get_analysis_history(ticker=ticker, limit=limit)
    return {"ticker": ticker.upper(), "count": len(rows), "history": rows}
