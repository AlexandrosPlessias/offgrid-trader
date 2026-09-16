"""Fractional-trading routes: /frac/* — a second Alpaca profile.

The fractional engine runs on its own named Alpaca profile (paper during the
monitoring period, live once the host is swapped).  These endpoints manage the
profile credentials/params, expose positions + readiness stats, and let the
Discovery/Explorer/Signals "🪙 Frac" buttons place fractional buys.

``frac_trading_enabled`` gates only the *automated* FracTradeSkill; the manual
``POST /frac/order`` works whenever the profile is configured (with a
``confirm_live`` guard when the profile host is live — real money).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import (
    get_frac_positions,
    get_frac_readiness_stats,
    get_open_frac_notional,
    get_open_frac_position_by_ticker,
    get_setting,
    save_frac_position,
    set_setting,
    update_frac_position,
)
from backend.routes._models import _clean_ticker

router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Pydantic models ────────────────────────────────────────────────────────


class FracSettingsRequest(BaseModel):
    url: str | None = None
    key_id: str | None = None
    secret_key: str | None = None
    profile_name: str | None = Field(None, max_length=80)
    position_size: float | None = Field(None, ge=1, le=1_000_000)
    budget: float | None = Field(None, ge=1, le=1_000_000)
    min_confidence: float | None = Field(None, ge=0, le=100)
    poll_seconds: int | None = Field(None, ge=30, le=3600)
    eod_close: bool | None = None
    enabled: bool | None = None
    # When True, clear DB-stored key/secret so the client falls back to the
    # FRAC_ALPACA_KEY_ID / FRAC_ALPACA_SECRET_KEY env vars.
    use_env: bool | None = None


class FracOrderRequest(BaseModel):
    ticker: str
    notional: float | None = Field(None, ge=1, le=1_000_000)
    entry: float | None = None
    stop: float | None = None
    target: float | None = None
    side: str = "buy"
    signal_id: int | None = None
    signal_confidence: float | None = None
    signal_source: str | None = None
    signal_timestamp: str | None = None
    confirm_live: bool = False


class FracTestRequest(BaseModel):
    key_id: str | None = None
    secret_key: str | None = None
    url: str | None = None


# ── Settings ────────────────────────────────────────────────────────────────


@router.post("/frac/settings")
def set_frac_settings(request: FracSettingsRequest) -> dict[str, Any]:
    """Persist the fractional profile credentials + engine params to the DB."""
    if request.use_env:
        # Clear DB overrides — the frac client reads FRAC_ALPACA_* env vars.
        set_setting("frac_alpaca_key_id", "")
        set_setting("frac_alpaca_secret_key", "")
    else:
        if request.key_id is not None:
            set_setting("frac_alpaca_key_id", request.key_id.strip())
        if request.secret_key is not None:
            set_setting("frac_alpaca_secret_key", request.secret_key.strip())
    if request.url is not None:
        set_setting("frac_alpaca_url", request.url.strip())
    if request.profile_name is not None:
        set_setting("frac_profile_name", request.profile_name.strip())
    if request.position_size is not None:
        set_setting("frac_position_size", str(request.position_size))
    if request.budget is not None:
        set_setting("frac_budget", str(request.budget))
    if request.min_confidence is not None:
        set_setting("frac_min_confidence", str(request.min_confidence))
    if request.poll_seconds is not None:
        set_setting("frac_poll_seconds", str(request.poll_seconds))
    if request.eod_close is not None:
        set_setting("frac_eod_close", "true" if request.eod_close else "false")
    if request.enabled is not None:
        if request.enabled:
            cfg = get_settings().frac
            key = get_setting("frac_alpaca_key_id", "") or cfg.key_id
            sec = get_setting("frac_alpaca_secret_key", "") or cfg.secret_key
            if not key or not sec:
                raise HTTPException(
                    status_code=400,
                    detail="Set the fractional profile's API key and secret before enabling.",
                )
        set_setting("frac_trading_enabled", "true" if request.enabled else "false")
    return {"saved": True}


# ── Data ────────────────────────────────────────────────────────────────────


@router.get("/frac/positions")
def frac_positions(limit: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
    """Return fractional positions (open + closed), open rows enriched live."""
    from backend.alpaca import frac_mode

    profile_name = get_setting("frac_profile_name", "") or get_settings().frac.profile_name
    rows = get_frac_positions(limit=limit)
    live: dict[str, Any] = {}
    client = None
    try:
        from backend.alpaca import get_frac_client

        client = get_frac_client()
        for p in client.get_positions():
            live[p.get("symbol")] = p
    except Exception:  # best-effort — tolerate any Alpaca/credential error
        live = {}

    for r in rows:
        if r.get("status") != "open":
            continue
        if r["ticker"] in live:
            p = live[r["ticker"]]
            # Live held fraction from Alpaca (authoritative until the poller backfills the DB).
            if p.get("qty") is not None:
                r["qty"] = float(p.get("qty"))
            if p.get("avg_entry_price") and not r.get("entry_price"):
                r["entry_price"] = float(p.get("avg_entry_price"))
            r["current_price"] = float(p.get("current_price") or 0)
            r["market_value"] = float(p.get("market_value") or 0)
            r["unrealized_pl"] = float(p.get("unrealized_pl") or 0)
            r["unrealized_plpc"] = float(p.get("unrealized_plpc") or 0)

    # For open positions not yet appearing in Alpaca (order pending fill), fetch
    # a snapshot so QTY / CURRENT / MARKET VALUE are estimated rather than blank.
    pending = [r for r in rows if r.get("status") == "open" and r["ticker"] not in live]
    if pending and client is not None:
        tickers = list({r["ticker"] for r in pending})
        try:
            snaps = client.get_snapshots(tickers)
        except Exception:
            snaps = {}
        for r in pending:
            snap = snaps.get(r["ticker"], {})
            price = float((snap.get("latestTrade") or {}).get("p") or 0)
            if price <= 0:
                # Fall back to mid-quote if trade price is unavailable.
                q = snap.get("latestQuote") or {}
                ask, bid = float(q.get("ap") or 0), float(q.get("bp") or 0)
                price = (ask + bid) / 2 if ask > 0 and bid > 0 else ask or bid
            if price > 0:
                notional = float(r.get("notional") or 0)
                r["current_price"] = price
                r["pending_fill"] = True  # hint for the UI (order not confirmed)
                if notional > 0:
                    r["qty"] = round(notional / price, 6)
                    r["market_value"] = notional

    return {"positions": rows, "mode": frac_mode(), "profile_name": profile_name}


@router.get("/frac/readiness")
def frac_readiness() -> dict[str, Any]:
    """Return the paper track record + current mode for the go-live readout."""
    from backend.alpaca import frac_mode

    mode = frac_mode()
    stats = get_frac_readiness_stats(mode="paper")
    enabled = get_setting("frac_trading_enabled", "false") == "true"
    return {
        **stats,
        "current_mode": mode,
        "trading_enabled": enabled,
        "live_enabled": enabled and mode == "live",
    }


@router.get("/frac/account")
def frac_account() -> dict[str, Any]:
    """Return the fractional profile's Alpaca account summary (for stat tiles)."""
    from backend.alpaca import AlpacaError, frac_mode, get_frac_client

    try:
        account = get_frac_client().get_account()
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"account": account, "mode": frac_mode()}


@router.get("/frac/history")
def frac_portfolio_history(
    period: str = Query("1M", pattern=r"^\d+[DWMA]$"),
    timeframe: str = Query("1D", pattern=r"^(1|5|15|30)Min$|^1[HD]$"),
) -> dict[str, Any]:
    """Return the fractional profile's Alpaca equity curve (for the equity chart)."""
    from backend.alpaca import AlpacaError, get_frac_client

    try:
        return get_frac_client().get_portfolio_history(period=period, timeframe=timeframe)
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ── Orders ──────────────────────────────────────────────────────────────────


@router.post("/frac/order")
def place_frac_order(request: FracOrderRequest) -> dict[str, Any]:
    """Place a manual fractional buy (Discovery/Explorer/Signals 🪙 Frac button)."""
    from backend.alpaca import AlpacaError, frac_mode, get_frac_client

    ticker = _clean_ticker(request.ticker)
    if request.side != "buy":
        raise HTTPException(status_code=400, detail="Fractional engine is long-only (buy).")

    cfg = get_settings().frac
    key = get_setting("frac_alpaca_key_id", "") or cfg.key_id
    sec = get_setting("frac_alpaca_secret_key", "") or cfg.secret_key
    if not key or not sec:
        raise HTTPException(
            status_code=400,
            detail="Configure the fractional profile (key + secret) in Settings first.",
        )

    mode = frac_mode()
    if mode == "live" and not request.confirm_live:
        raise HTTPException(
            status_code=428,
            detail="Live fractional order needs confirm_live=true (real money).",
        )

    # Repeat buys of the same ticker accumulate into one position, because Alpaca
    # merges holdings by symbol (a 2nd buy just increases one averaged position).
    existing = get_open_frac_position_by_ticker(ticker)

    size = request.notional or float(get_setting("frac_position_size", "15") or 15)
    budget = float(get_setting("frac_budget", "100") or 100)
    deployed = get_open_frac_notional()
    if deployed + size > budget:
        raise HTTPException(
            status_code=400,
            detail=f"Budget cap reached: ${deployed:.2f} + ${size:.2f} > ${budget:.2f}.",
        )

    # Derive stop/target if absent — mirror TrendingPage.handleTrade (-5% / +10%)
    # so the exit poller has levels to manage the cashout.
    entry = request.entry
    stop = request.stop
    target = request.target
    if entry:
        if stop is None:
            stop = round(entry * 0.95, 4)
        if target is None:
            target = round(entry * 1.10, 4)

    try:
        result = get_frac_client().place_notional_order(ticker=ticker, side="buy", notional=size)
    except AlpacaError as exc:
        msg = str(exc)
        if "fractionable" in msg.lower():
            raise HTTPException(
                status_code=422,
                detail=f"{ticker} is not fractionable on Alpaca — use a whole-share order.",
            ) from exc
        raise HTTPException(status_code=502, detail=msg) from exc

    if existing:
        # Accumulate into the existing (Alpaca-merged) position: bump the tracked
        # notional and refresh stop/target to the latest signal. The exit poller
        # re-syncs qty/avg-entry from the merged Alpaca position each cycle.
        updates: dict[str, Any] = {"notional": (existing.get("notional") or 0) + size}
        if stop is not None:
            updates["stop_price"] = stop
        if target is not None:
            updates["take_profit_price"] = target
        update_frac_position(existing["id"], updates)
        pos_id = existing["id"]
    else:
        pos_id = save_frac_position(
            {
                "signal_id": request.signal_id,
                "ticker": ticker,
                "side": "buy",
                "notional": size,
                "entry_price": entry,
                "stop_price": stop,
                "take_profit_price": target,
                "status": "open",  # our lifecycle status, not the Alpaca order ack
                "alpaca_buy_order_id": result.get("id"),
                "mode": mode,
                "signal_confidence": request.signal_confidence,
                "signal_source": request.signal_source,
                "signal_timestamp": request.signal_timestamp,
            }
        )

    from backend.alerts import send_order_notification

    send_order_notification(
        kind="fractional",
        ticker=ticker,
        side="buy",
        amount=size,
        mode=mode,
        detail=("added to position" if existing else f"stop {stop} / target {target}"),
    )
    return {
        "placed": True,
        "id": pos_id,
        "accumulated": bool(existing),
        "ticker": ticker,
        "notional": size,
        "mode": mode,
        "order_id": result.get("id"),
        "status": result.get("status"),
    }


@router.post("/frac/positions/{ticker}/close")
def close_frac_position(ticker: str) -> dict[str, Any]:
    """Manually market-sell the full held fraction of a fractional position."""
    from backend.alpaca import AlpacaError, get_frac_client

    ticker = _clean_ticker(ticker)
    row = get_open_frac_position_by_ticker(ticker)
    if not row:
        raise HTTPException(status_code=404, detail=f"No open fractional position for {ticker}")

    try:
        client = get_frac_client()
        try:
            position = client._get(f"/v2/positions/{ticker}")
        except AlpacaError as exc:
            if "404" in str(exc) or "position does not exist" in str(exc).lower():
                update_frac_position(
                    row["id"],
                    {"status": "closed", "exit_reason": "manual", "closed_at": _now_iso()},
                )
                raise HTTPException(
                    status_code=404, detail=f"No open position on Alpaca for {ticker}"
                ) from exc
            raise

        qty_avail_raw = position.get("qty_available")
        qty_total = abs(float(position.get("qty") or 0))
        qty_avail = abs(float(qty_avail_raw)) if qty_avail_raw is not None else qty_total
        close_qty = qty_avail
        if close_qty <= 0:
            raise HTTPException(
                status_code=400, detail=f"Position for {ticker} has zero shares available to close."
            )

        current = float(position.get("current_price") or 0)
        entry = float(position.get("avg_entry_price") or row.get("entry_price") or 0)
        order = client.place_notional_order(ticker=ticker, side="sell", qty=close_qty)
        realized = round((current - entry) * close_qty, 4) if current and entry else None
        update_frac_position(
            row["id"],
            {
                "status": "closed",
                "exit_price": current or None,
                "exit_reason": "manual",
                "realized_pnl": realized,
                "alpaca_sell_order_id": order.get("id"),
                "closed_at": _now_iso(),
            },
        )
        return {
            "closed": True,
            "ticker": ticker,
            "qty": str(close_qty),
            "order_id": order.get("id"),
            "status": order.get("status"),
        }
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/frac/connection-test")
def test_frac_connection(request: FracTestRequest) -> dict[str, Any]:
    """Validate fractional-profile credentials against its host without saving."""
    from backend.alpaca import AlpacaClient, AlpacaError

    cfg = get_settings().frac
    try:
        client = AlpacaClient(
            key_id=(request.key_id or get_setting("frac_alpaca_key_id", "") or cfg.key_id),
            secret_key=(
                request.secret_key or get_setting("frac_alpaca_secret_key", "") or cfg.secret_key
            ),
            base_url=(request.url or get_setting("frac_alpaca_url", "") or cfg.url),
        )
        account = client.get_account()
        return {"ok": True, "account": account}
    except AlpacaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
