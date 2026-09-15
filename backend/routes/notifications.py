"""Notification routes: Telegram callback webhook."""
from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Request

from backend.config import get_settings
from backend.database import get_setting

router = APIRouter()
_log = logging.getLogger(__name__)


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
        except Exception:
            pass

        return {"ok": True, "action": "paper_order", "ticker": ticker, "side": side}

    # Unknown action — acknowledge to dismiss the spinner
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(answer_url, json={"callback_query_id": callback_id})
    except Exception:
        pass

    return {"ok": True}
