"""Alpaca / paper-trading routes: /settings/alpaca*, /paper/*."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.database import (
    get_paper_orders,
    get_setting,
    set_setting,
    update_paper_order_status,
)
from backend.scheduler import sync_paper_orders

router = APIRouter()


# ── Pydantic models ────────────────────────────────────────────────────────


class AlpacaSettingsRequest(BaseModel):
    paper_url: str | None = None
    key_id: str | None = None
    secret_key: str | None = None
    position_size: float | None = Field(None, ge=1, le=1_000_000)
    min_confidence: float | None = Field(None, ge=0, le=100)
    enabled: bool | None = None
    # When True, clear DB-stored credentials so the client falls back to env vars.
    use_env: bool | None = None


class AlpacaTestRequest(BaseModel):
    key_id: str | None = None
    secret_key: str | None = None
    paper_url: str | None = None


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


# ── Alpaca paper-trading settings ──────────────────────────────────────────


@router.post("/settings/alpaca")
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


@router.post("/settings/alpaca/test")
def test_alpaca_connection(request: AlpacaTestRequest) -> dict[str, Any]:
    """Test Alpaca credentials without saving them to the DB.

    Accepts credentials directly in the request body — uses whatever is currently
    typed in the Settings form, before the user clicks Save.  Falls back to saved
    DB / env values for any field left blank.
    """
    from backend.alpaca import AlpacaClient, AlpacaError  # local import

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


# ── Paper trading data endpoints ───────────────────────────────────────────


@router.get("/paper/account")
def paper_account() -> dict[str, Any]:
    """Return live Alpaca paper account summary (equity, buying_power, etc.).

    Always attempts the Alpaca call regardless of the paper_trading_enabled flag
    so the Settings page can test credentials before the feature is switched on.
    """
    from backend.alpaca import AlpacaError, get_client  # local import

    try:
        client = get_client()
        account = client.get_account()
        return {"enabled": True, "account": account}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/paper/orders")
def paper_orders_list(limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    """Return paper orders from the local DB (most recent first)."""
    rows = get_paper_orders(limit=limit)
    return {"count": len(rows), "orders": rows}


@router.get("/paper/positions")
def paper_positions() -> dict[str, Any]:
    """Return live open positions from Alpaca."""
    from backend.alpaca import AlpacaError, get_client  # local import

    if get_setting("paper_trading_enabled", "true") != "true":
        return {"enabled": False, "positions": []}
    try:
        client = get_client()
        positions = client.get_positions()
        return {"enabled": True, "positions": positions}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/paper/orders/place")
def place_paper_order_manual(req: ManualOrderRequest) -> dict[str, Any]:
    """Place a single paper bracket order manually (from Explorer or signal card).

    De-duplicates by signal_id when provided: returns the existing order if one
    already exists for that signal rather than placing a second one.
    """
    from backend.alpaca import AlpacaError, get_client
    from backend.database import (
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

        # Pre-check: for short (sell) orders, verify the asset is shortable before
        # attempting the bracket order.  Alpaca returns 422 code 42210000 otherwise,
        # which we surface here as a clear 400 rather than a cryptic 502.
        if req.side == "sell":
            try:
                asset = client._get(f"/v2/assets/{req.ticker}")
                if not asset.get("shortable", True):
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"{req.ticker} cannot be sold short via Alpaca — it is not on the "
                            "shortable securities list (no shares available to borrow). "
                            "Consider a LONG order instead, or choose a different ticker."
                        ),
                    )
            except HTTPException:
                raise  # re-raise our own 400 unchanged
            except AlpacaError:
                pass  # asset-check failure is non-fatal; let the order attempt surface the real error

        result = client.place_bracket_order(
            ticker=req.ticker,
            side=req.side,
            notional=notional,
            entry_price=req.entry,
            stop_price=req.stop,
            take_profit_price=req.target,
        )
    except HTTPException:
        raise  # pass our own 400s through unchanged
    except AlpacaError as exc:
        err = str(exc)
        # Fallback: catch the 422 "cannot be sold short" even if the pre-check missed it
        if "cannot be sold short" in err.lower() or "42210000" in err:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{req.ticker} cannot be sold short via Alpaca — it is not on the "
                    "shortable securities list (no shares available to borrow). "
                    "Consider a LONG order instead, or choose a different ticker."
                ),
            ) from exc
        raise HTTPException(status_code=502, detail=err) from exc

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


@router.post("/paper/orders/{order_id}/cancel")
def cancel_paper_order(order_id: int) -> dict[str, Any]:
    """Cancel a pending paper order by its DB id."""
    from backend.alpaca import AlpacaError, get_client  # local import

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


@router.post("/paper/positions/{ticker}/close")
def close_paper_position(ticker: str) -> dict[str, Any]:
    """Liquidate an open position by placing a market-sell order for the full quantity.

    Looks up the current held quantity from Alpaca, then places a market sell order.
    Returns the placed order object so the frontend can confirm and refresh.

    Raises 404 if there is no open position for the ticker, 502 for Alpaca errors.
    """
    from backend.alpaca import AlpacaError, get_client  # local import

    ticker = ticker.strip().upper()
    if get_setting("paper_trading_enabled", "true") != "true":
        raise HTTPException(
            status_code=400,
            detail="Paper trading is disabled — enable it in Settings → Paper Trading.",
        )

    try:
        client = get_client()
        # Fetch the current position to get the held quantity.
        try:
            position = client._get(f"/v2/positions/{ticker}")
        except AlpacaError as exc:
            if "404" in str(exc) or "position does not exist" in str(exc).lower():
                raise HTTPException(
                    status_code=404, detail=f"No open position found for {ticker}"
                ) from exc
            raise

        # Determine available vs total qty.
        # qty     = total position size (negative for shorts, e.g. "-19")
        # qty_available = shares not locked in pending bracket legs (e.g. "16")
        # We MUST send qty_available to Alpaca — sending the full qty when some
        # shares are locked causes 403 "insufficient qty available for order".
        qty_total_raw = position.get("qty") or "0"
        qty_avail_raw = position.get("qty_available")

        qty_total = abs(float(qty_total_raw))
        qty_avail = abs(float(qty_avail_raw)) if qty_avail_raw is not None else qty_total

        # Use available qty; if truly zero (all shares locked), nothing to close
        close_qty = qty_avail if qty_avail > 0 else qty_total
        if close_qty <= 0:
            raise HTTPException(
                status_code=400,
                detail=f"Position for {ticker} has zero shares available to close.",
            )

        # Determine close direction:
        #   long  position → sell to close
        #   short position → buy to cover
        pos_side   = position.get("side", "long")
        close_side = "sell" if pos_side == "long" else "buy"

        # Entry price and current unrealized P&L (used later to record realized P&L).
        entry_price   = float(position.get("avg_entry_price") or 0)
        unrealized_pl = float(position.get("unrealized_pl") or 0)

        # Preserve fractional shares — pass qty exactly as Alpaca reported it.
        # Alpaca paper trading supports fractional market sells with qty as a
        # decimal string (e.g. "1.5").  Converting to int would silently drop
        # fractional shares and can produce qty=0 when < 1 share is held.
        qty_str = str(close_qty)
        # Normalise "2.0" → "2" so Alpaca treats it as a whole-share order;
        # leave "1.5" as-is for fractional positions.
        if qty_str.endswith(".0"):
            qty_str = qty_str[:-2]

        # Determine whether the market is currently open so we pick the right TIF.
        # "day" fills immediately during market hours.
        # "gtc" (good-till-cancelled) queues the order for next open if the
        # market is closed — the position will be liquidated as soon as trading
        # resumes without the user having to retry.
        try:
            clock = client._get("/v2/clock")
            is_open = bool(clock.get("is_open"))
        except Exception:
            is_open = True  # assume open on clock failure; Alpaca will reject if wrong

        tif = "day" if is_open else "gtc"

        order = client._post(
            "/v2/orders",
            {
                "symbol":        ticker,
                "qty":           qty_str,
                "side":          close_side,
                "type":          "market",
                "time_in_force": tif,
            },
        )

        # Save the close order to paper_orders so sync_paper_orders can later
        # fill in the actual filled_avg_price and compute realized P&L.
        # We store entry_price here because the position object will be gone
        # once the order fills and we can no longer look it up.
        # Estimated P&L = unrealized_pl × (close_qty / total_qty) at current price;
        # sync_paper_orders will overwrite this with the actual fill price later.
        from backend.database import save_paper_order  # local import
        partial_ratio = (close_qty / qty_total) if qty_total > 0 else 1.0
        est_pnl = round(unrealized_pl * partial_ratio, 4)
        save_paper_order(
            {
                "ticker":         ticker,
                "side":           close_side,
                "alpaca_order_id": order.get("id"),
                "status":         order.get("status", "pending"),
                "qty":            close_qty,
                "notional":       None,
                "entry_price":    entry_price if entry_price > 0 else None,
                "realized_pnl":   est_pnl if order.get("status") == "filled" else None,
            }
        )

        market_note = None if is_open else "Market is closed — order queued for next open (GTC)."
        is_partial  = qty_total > close_qty
        return {
            "closed":   True,
            "ticker":   ticker,
            "qty":      qty_str,
            "qty_total": str(int(qty_total)) if qty_total == int(qty_total) else str(qty_total),
            "partial":  is_partial,
            "order_id": order.get("id"),
            "status":   order.get("status"),
            "order":    order,
            **({"note": market_note} if market_note else {}),
        }
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/paper/sync")
async def paper_sync() -> dict[str, Any]:
    """Trigger an immediate poll of Alpaca order statuses."""
    await sync_paper_orders()
    return {"synced": True}


@router.get("/paper/clock")
def paper_clock() -> dict[str, Any]:
    """Return Alpaca market clock (is_open, next_open, next_close)."""
    from backend.alpaca import AlpacaError, get_client  # local import

    try:
        return get_client().get_clock()
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/paper/history")
def paper_portfolio_history(
    period: str = Query("1M", pattern=r"^\d+[DWMA]$"),
    timeframe: str = Query("1D", pattern=r"^(1|5|15|30)Min$|^1[HD]$"),
) -> dict[str, Any]:
    """Return Alpaca portfolio equity curve for the given period/timeframe."""
    from backend.alpaca import AlpacaError, get_client  # local import

    try:
        return get_client().get_portfolio_history(period=period, timeframe=timeframe)
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/paper/market/snapshots")
def market_snapshots(
    symbols: str = Query(..., description="Comma-separated tickers")
) -> dict[str, Any]:
    """Live market data snapshots for the given tickers (single Alpaca call).

    Returns per-ticker: latest price, day OHLCV, prev-close, VWAP, volume,
    bid/ask.  Does not require paper_trading_enabled — only valid credentials.
    """
    from backend.alpaca import AlpacaError, get_client  # local import

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
