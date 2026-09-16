"""Notification routes: Telegram callback webhook."""

from __future__ import annotations

import hmac
import logging
import threading
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse

from backend.config import get_settings
from backend.database import get_setting

router = APIRouter()
_log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Round-trip test tokens — single-use, short-lived, in-memory.
# Used by the "Send test" flow to prove delivery + action routing end-to-end.
# --------------------------------------------------------------------------- #
_ROUNDTRIP_TTL = 60  # seconds
_roundtrip_lock = threading.Lock()
_roundtrip: dict[str, dict[str, Any]] = {}  # token -> {"expires": epoch, "confirmed": bool}


def _prune_roundtrip() -> None:
    now = time.time()
    for tok in [t for t, v in _roundtrip.items() if v["expires"] < now]:
        _roundtrip.pop(tok, None)


def new_roundtrip_token() -> str:
    """Create a single-use token valid for ``_ROUNDTRIP_TTL`` seconds."""
    token = uuid.uuid4().hex
    with _roundtrip_lock:
        _prune_roundtrip()
        _roundtrip[token] = {"expires": time.time() + _ROUNDTRIP_TTL, "confirmed": False}
    return token


def _confirm_roundtrip(token: str) -> bool:
    with _roundtrip_lock:
        _prune_roundtrip()
        entry = _roundtrip.get(token)
        if not entry:
            return False
        entry["confirmed"] = True
        return True


def _roundtrip_status(token: str) -> str:
    with _roundtrip_lock:
        _prune_roundtrip()
        entry = _roundtrip.get(token)
        if not entry:
            return "expired"
        return "confirmed" if entry["confirmed"] else "pending"


@router.api_route(
    "/notifications/test/confirm", methods=["GET", "POST"], include_in_schema=False
)
async def confirm_roundtrip(token: str = Query(..., min_length=8, max_length=64)) -> Any:
    """Confirm a round-trip test token (tapped from the channel action button).

    No auth — the single-use, short-lived token is the proof. Accepts GET (a
    Telegram URL button opens it in a browser) and POST (an ntfy http action).
    Returns a small HTML page either way (ntfy ignores the body).
    """
    if _confirm_roundtrip(token):
        return HTMLResponse(
            "<html><body style='font-family:sans-serif;text-align:center;padding:48px'>"
            "<h2>✅ Round-trip confirmed</h2>"
            "<p>You can close this tab and return to MarketSage.</p></body></html>"
        )
    return HTMLResponse(
        "<html><body style='font-family:sans-serif;text-align:center;padding:48px'>"
        "<h2>⚠ Link expired</h2><p>The confirmation link has expired (60&nbsp;s). "
        "Send a new test from Settings.</p></body></html>",
        status_code=410,
    )


@router.get("/notifications/test/status")
async def roundtrip_status(token: str = Query(..., min_length=8, max_length=64)) -> dict[str, str]:
    """Return the round-trip token status: ``pending`` | ``confirmed`` | ``expired``."""
    return {"status": _roundtrip_status(token)}


def _verify_telegram_secret(body: bytes, token: str | None, secret: str) -> bool:
    """Verify the X-Telegram-Bot-Api-Secret-Token header (optional but recommended)."""
    if not secret:
        return True  # no secret configured → accept all (safe on local/trusted networks)
    if not token:
        return False
    return hmac.compare_digest(token, secret)


@router.post("/notifications/telegram/callback")
async def telegram_callback(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(None),
) -> dict[str, Any]:
    """Receive Telegram inline-keyboard callback queries.

    Register this URL as your bot's webhook via:
      curl https://api.telegram.org/bot<TOKEN>/setWebhook \
           -d url=https://<your-backend>/notifications/telegram/callback \
           -d secret_token=<TELEGRAM_WEBHOOK_SECRET>

    When the user taps a Paper trade button, this handler calls POST /paper/orders
    through the same path as the UI — no validation bypass.
    """
    cfg = get_settings()
    secret = get_setting("telegram_webhook_secret", "") or cfg.telegram.webhook_secret

    body = await request.body()
    if not _verify_telegram_secret(body, x_telegram_bot_api_secret_token, secret):
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    update: dict = await request.json()
    callback_query = update.get("callback_query")
    if not callback_query:
        return {"ok": True}  # not a button tap — ignore

    callback_id = callback_query.get("id", "")
    data: str = callback_query.get("data", "")

    tg = cfg.telegram
    answer_url = f"https://api.telegram.org/bot{tg.bot_token}/answerCallbackQuery"

    # Parse callback_data: "paper:AAPL:buy" | "view:AAPL"
    parts = data.split(":")
    action = parts[0] if parts else ""

    if action == "paper" and len(parts) >= 3:
        ticker, side = parts[1], parts[2]
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                order_resp = await client.post(
                    "http://localhost:8000/paper/orders",
                    json={
                        "ticker": ticker,
                        "side": side,
                        "qty": 1,
                        "order_type": "market",
                        "time_in_force": "day",
                    },
                )
            if order_resp.status_code in (200, 201):
                text = f"Paper {side.upper()} order placed for {ticker}."
            else:
                text = f"Order failed ({order_resp.status_code})."
        except Exception as exc:
            _log.warning("telegram callback order failed: %s", exc)
            text = "Order placement failed. Check the app."

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(answer_url, json={"callback_query_id": callback_id, "text": text})
        except Exception:  # noqa: BLE001 - answerCallbackQuery is best-effort; failure is silent
            _log.debug("answerCallbackQuery failed after order placement", exc_info=True)

        return {"ok": True, "action": "paper_order", "ticker": ticker, "side": side}

    # Unknown action — acknowledge to dismiss the spinner
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(answer_url, json={"callback_query_id": callback_id})
    except Exception:  # noqa: BLE001 - best-effort acknowledgement; Telegram retries handle failure
        _log.debug("answerCallbackQuery failed for unknown action", exc_info=True)

    return {"ok": True}
