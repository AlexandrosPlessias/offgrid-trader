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

from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .analysis import analyze
from .config import get_settings
from .data import get_market_data
from .database import get_analysis_history, get_recent_signals, init_db, save_analysis, save_signal
from .opportunities import detect_opportunities, filter_by_confidence
from .scheduler import scan_ticker_async, scheduler


# --------------------------------------------------------------------------- #
# Request/response models
# --------------------------------------------------------------------------- #
class AnalyzeRequest(BaseModel):
    ticker: str = Field(..., description="Ticker symbol, e.g. AAPL")
    send_alerts: bool = Field(False, description="Also dispatch alerts for actionable signals")


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

    from .scheduler import scan_ticker  # local import to avoid cycles at import time

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


@app.get("/watchlist")
def watchlist() -> Dict[str, Any]:
    settings = get_settings()
    return {
        "watchlist": settings.watchlist,
        "scan_interval_minutes": settings.scan_interval_minutes,
        "scheduler": scheduler.status(),
    }


@app.post("/analyze")
async def analyze_ticker(request: AnalyzeRequest) -> Dict[str, Any]:
    """On-demand analysis for a single ticker."""

    ticker = request.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker is required")

    result = await scan_ticker_async(ticker, send_alerts=request.send_alerts)
    return {
        "ticker": ticker,
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
        raise HTTPException(status_code=400, detail="payload must include 'ticker' or 'symbol'")

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
