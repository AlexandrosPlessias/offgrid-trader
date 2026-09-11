"""Analysis routes: /analyze*, /market-data*, /webhook*, /signals*, /analysis*."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.data import get_market_data as _get_market_data
from backend.database import (
    delete_analysis as _delete_analysis,
    delete_signal as _delete_signal_row,
    get_analysis_history,
    get_recent_analyses,
    get_recent_signals,
)
from backend.scheduler import scan_ticker_async
from backend.routes._models import _clean_ticker, _log_safe

router = APIRouter()
_log = logging.getLogger(__name__)


class AnalyzeRequest(BaseModel):
    ticker: str = Field(..., description="Ticker symbol, e.g. AAPL")
    send_alerts: bool = Field(False, description="Also dispatch alerts for actionable signals")


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


def _background_analyze(ticker: str, send_alerts: bool = True) -> None:
    """Run a full scan for one ticker (used by the webhook)."""
    from backend.scheduler import scan_ticker  # local import — avoids import cycle

    scan_ticker(ticker, send_alerts=send_alerts)


@router.post("/analyze")
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


@router.post("/analyze/stream")
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


@router.get("/market-data/{ticker}")
async def market_data(ticker: str) -> dict[str, Any]:
    """Return the raw market data dict for *ticker* (price, fundamentals, indicators)."""
    ticker = _clean_ticker(ticker)
    data = await asyncio.to_thread(_get_market_data, ticker)
    return data


@router.get("/market-data/{ticker}/history")
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


@router.post("/webhook/tradingview")
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


@router.get("/signals")
def signals(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    ticker: str | None = Query(None),
) -> dict[str, Any]:
    """Return recent stored signals, optionally filtered by ticker.

    Supports pagination via ``limit`` + ``offset``.  Always includes ``total``
    (un-paged count) so the client can compute the page count.
    """
    rows, total = get_recent_signals(limit=limit, offset=offset, ticker=ticker)
    return {"count": len(rows), "total": total, "signals": rows}


@router.delete("/signals/{signal_id}")
def delete_signal(signal_id: int) -> dict[str, Any]:
    """Delete a stored signal by id."""
    deleted = _delete_signal_row(signal_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"signal {signal_id} not found")
    return {"deleted": True, "id": signal_id}


@router.get("/analysis")
def all_analysis_history(
    limit: int = Query(25, ge=1, le=100),
) -> dict[str, Any]:
    """Return recent analysis-log entries across all tickers, newest first."""
    rows = get_recent_analyses(limit=limit)
    return {"count": len(rows), "history": rows}


@router.delete("/analysis/{entry_id}")
def delete_analysis_entry(entry_id: int) -> dict[str, Any]:
    """Delete an analysis-log entry by id."""
    deleted = _delete_analysis(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"analysis entry {entry_id} not found")
    return {"deleted": True, "id": entry_id}


@router.get("/analysis/{ticker}")
def analysis_history(
    ticker: str,
    limit: int = Query(20, ge=1, le=200),
) -> dict[str, Any]:
    """Return the analysis-log history for *ticker*."""
    rows = get_analysis_history(ticker=ticker, limit=limit)
    return {"ticker": ticker.upper(), "count": len(rows), "history": rows}
