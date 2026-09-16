"""Alerting: format opportunities and deliver via Gmail SMTP, Telegram, and/or ntfy.

Alerts only fire for opportunities whose confidence meets the configured
floor. All channels are optional and independently gated by their
``*_ENABLED`` env flags and by having complete credentials.

Email can be suspended globally with ``ALERTS_SEND_ENABLED=false``
(e.g. during local testing) while keeping Telegram/ntfy active.

Run standalone to send a test alert through whatever channels are configured::

    python -m backend.alerts
"""

from __future__ import annotations

import logging
from typing import Any

# Email/SMTP descoped in favor of ntfy — untested; uncomment to re-enable send_email().
# import smtplib
# import ssl
# from email.mime.multipart import MIMEMultipart
# from email.mime.text import MIMEText
from .config import get_settings
from .database import get_setting

_log = logging.getLogger(__name__)


def _is_alerts_enabled() -> bool:
    db_val = get_setting("alerts_enabled", "")
    if db_val:
        return db_val.lower() == "true"
    return get_settings().alerts_send_enabled


def _fmt_level(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def format_alert(opportunity: dict[str, Any]) -> dict[str, str]:
    """Build a ``{"subject", "text"}`` message from an opportunity dict."""

    ticker = opportunity.get("ticker", "?")
    side = str(opportunity.get("type", "none")).upper()
    confidence = float(opportunity.get("confidence") or 0.0)
    price = opportunity.get("price")
    source = opportunity.get("source") or "+".join(opportunity.get("sources", []) or [])
    reasons = opportunity.get("reasons") or []

    subject = f"[offgrid-trader] {side} {ticker} ({confidence:.0f}% confidence)"

    lines: list[str] = [
        f"Ticker:     {ticker}",
        f"Direction:  {side}",
        f"Confidence: {confidence:.0f}%",
        f"Price:      {_fmt_level(price)}",
        f"Entry:      {_fmt_level(opportunity.get('entry'))}",
        f"Stop:       {_fmt_level(opportunity.get('stop'))}",
        f"Target:     {_fmt_level(opportunity.get('target'))}",
        f"Source:     {source}",
    ]
    if reasons:
        lines.append("")
        lines.append("Reasons:")
        lines.extend(f"  - {r}" for r in reasons)
    lines.append("")
    lines.append("Not financial advice. Generated locally by offgrid-trader.")

    return {"subject": subject, "text": "\n".join(lines)}


# --------------------------------------------------------------------------- #
# Channels
# --------------------------------------------------------------------------- #
# Effective config resolvers — DB override first, env default second, so every
# channel is configurable at runtime from the Settings page (no restart).
# --------------------------------------------------------------------------- #
def _db_or(key: str, env_val: str) -> str:
    return get_setting(key, "") or env_val


def _bool_db_or(key: str, env_val: bool) -> bool:
    raw = get_setting(key, "")
    return raw.lower() == "true" if raw else env_val


def resolve_email() -> dict[str, Any]:
    e = get_settings().email
    port_raw = get_setting("email_smtp_port", "")
    return {
        "enabled": _bool_db_or("email_enabled", e.enabled),
        "smtp_host": _db_or("email_smtp_host", e.smtp_host),
        "smtp_port": int(port_raw) if port_raw.isdigit() else e.smtp_port,
        "username": _db_or("email_username", e.username),
        "password": _db_or("email_password", e.password),
        "sender": _db_or("email_from", e.sender),
        "recipient": _db_or("email_to", e.recipient),
    }


def resolve_telegram() -> dict[str, Any]:
    t = get_settings().telegram
    return {
        "enabled": _bool_db_or("telegram_enabled", t.enabled),
        "bot_token": _db_or("telegram_bot_token", t.bot_token),
        "chat_id": _db_or("telegram_chat_id", t.chat_id),
    }


def send_email(subject: str, body: str) -> bool:
    """SMTP email — DESCOPED in favor of ntfy (untested; no-op).

    ntfy covers the same alerting use cases with a simpler, more interactive UX.
    To re-enable: uncomment the SMTP imports at the top of this module and the
    body below, and uncomment the Email/SMTP section in the Settings UI
    (frontend/src/pages/SettingsPage.jsx). The config plumbing (resolve_email,
    GET/POST /settings/notifications/email) is left intact.
    """
    return False

    # email = resolve_email()
    # if not (email["enabled"] and email["username"] and email["password"] and email["recipient"]):
    #     return False
    #
    # message = MIMEMultipart()
    # message["From"] = email["sender"] or email["username"]
    # message["To"] = email["recipient"]
    # message["Subject"] = subject
    # message.attach(MIMEText(body, "plain"))
    #
    # try:
    #     context = ssl.create_default_context()
    #     with smtplib.SMTP(email["smtp_host"], email["smtp_port"], timeout=20) as server:
    #         server.starttls(context=context)
    #         server.login(email["username"], email["password"])
    #         server.sendmail(
    #             email["sender"] or email["username"],
    #             [email["recipient"]],
    #             message.as_string(),
    #         )
    #     return True
    # except Exception as exc:  # pragma: no cover - network/credential dependent
    #     _log.warning("email send failed: %s", exc)
    #     return False


def send_telegram(subject: str, body: str, reply_markup: dict | None = None) -> bool:
    """Send *subject* + *body* via Telegram Bot API. Returns success.

    ``reply_markup`` (optional) is an inline-keyboard dict, e.g. a URL button:
    ``{"inline_keyboard": [[{"text": "✅ Confirm", "url": "https://…"}]]}``.
    """

    import httpx  # already in requirements; local import to avoid top-level dep

    tg = resolve_telegram()
    if not (tg["enabled"] and tg["bot_token"] and tg["chat_id"]):
        return False

    text = f"*{subject}*\n\n{body}"
    url = f"https://api.telegram.org/bot{tg['bot_token']}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": tg["chat_id"],
        "text": text,
        "parse_mode": "Markdown",
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        r = httpx.post(url, json=payload, timeout=10.0)
        r.raise_for_status()
        return True
    except Exception as exc:  # pragma: no cover - network dependent
        # Telegram rejects the whole message when an inline button URL is invalid
        # (e.g. a localhost BACKEND_PUBLIC_URL → BUTTON_URL_INVALID). Retry without
        # the button so plain delivery still succeeds.
        if reply_markup:
            try:
                payload.pop("reply_markup", None)
                r = httpx.post(url, json=payload, timeout=10.0)
                r.raise_for_status()
                _log.info("telegram: sent without inline button (button URL rejected)")
                return True
            except Exception as exc2:  # pragma: no cover - network dependent
                _log.warning("telegram send failed: %s", exc2)
                return False
        _log.warning("telegram send failed: %s", exc)
        return False


def send_alert(
    opportunity: dict[str, Any],
    *,
    min_confidence: float | None = None,
) -> dict[str, Any]:
    """Format and dispatch an alert if it clears the confidence floor.

    Returns a result dict describing what happened, e.g.
    ``{"sent": True, "channels": ["telegram", "ntfy"], "skipped": False}``.
    """

    settings = get_settings()
    floor = settings.thresholds.confidence_floor if min_confidence is None else min_confidence
    confidence = float(opportunity.get("confidence") or 0.0)

    if confidence < floor:
        return {
            "sent": False,
            "skipped": True,
            "reason": f"confidence {confidence:.0f} < floor {floor:.0f}",
            "channels": [],
        }

    message = format_alert(opportunity)

    # Master kill-switch: when "Alert dispatch" is off, suppress every channel
    # (email, Telegram, ntfy). Per-channel Enable flags only matter when this is on.
    # Manual tests via POST /notifications/test bypass this switch.
    if not _is_alerts_enabled():
        _log.info("alert dispatch disabled — suppressing all channels")
        return {
            "sent": False,
            "skipped": True,
            "reason": "alert dispatch disabled",
            "channels": [],
            "subject": message["subject"],
        }

    from .notifications import dispatch as _notify_dispatch

    cfg = get_settings()
    channels: list[str] = []

    if send_email(message["subject"], message["text"]):
        channels.append("email")

    if send_telegram(message["subject"], message["text"]):
        channels.append("telegram")

    # ntfy and any other registered channels
    backend_url = get_setting("backend_public_url", "") or cfg.backend_public_url
    ticker = opportunity.get("ticker", "?")
    side = str(opportunity.get("type", "buy"))
    actions: list[dict] | None = None
    if opportunity.get("ticker"):
        order_body = (
            f'{{"ticker": "{ticker}", "side": "{side}",'
            f' "qty": 1, "order_type": "market", "time_in_force": "day"}}'
        )
        actions = [
            {
                "label": f"Paper {ticker} {side.upper()}",
                "url": f"{backend_url}/paper/orders",
                "method": "POST",
                "body": order_body,
            }
        ]

    ntfy_results = _notify_dispatch(message["subject"], message["text"], actions=actions)
    channels.extend(k for k, v in ntfy_results.items() if v)

    return {
        "sent": bool(channels),
        "skipped": False,
        "channels": channels,
        "subject": message["subject"],
    }


def send_order_notification(
    *,
    kind: str,  # "order" (bracket) | "fractional"
    ticker: str,
    side: str,
    amount: float,
    mode: str = "paper",
    detail: str = "",
) -> None:
    """Notify configured channels that an order / fractional position was placed.

    Gated by the ``order_notifications_enabled`` setting (default on). Reuses
    :func:`send_system_event` so it respects each channel's own config. Never
    raises — placement must never fail because a notification failed.
    """
    try:
        from .database import get_setting

        if get_setting("order_notifications_enabled", "true") != "true":
            return
        icon = "📈" if kind == "order" else "🪙"
        label = "Order" if kind == "order" else "Fractional buy"
        mode_tag = " · LIVE 💰" if mode == "live" else ""
        msg = f"{icon} {label} placed: {side.upper()} {ticker} — ${amount:.2f}{mode_tag}"
        if detail:
            msg += f"\n{detail}"
        send_system_event(msg)
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("order notification failed: %s", exc)


def send_system_event(message: str) -> dict[str, bool]:
    """Fire a minimal system notification (e.g. startup/shutdown) via enabled channels.

    Reuses the existing send logic (ntfy dispatch + Telegram). Each channel only
    fires when it is configured and enabled (their own guards). Never raises —
    every failure is logged and swallowed so this can't block startup or shutdown.

    The emoji lives in the message body (UTF-8, preserved); the ntfy Title stays
    a plain ASCII "MarketSage".
    """
    results: dict[str, bool] = {}
    try:
        from .notifications import dispatch as _notify_dispatch

        results.update(_notify_dispatch("MarketSage", message))
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("system notification via ntfy failed: %s", exc)
    try:
        if send_telegram(message, ""):
            results["telegram"] = True
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("system notification via telegram failed: %s", exc)
    return results


if __name__ == "__main__":
    import json

    demo = {
        "ticker": "AAPL",
        "type": "long",
        "confidence": 78.0,
        "price": 190.12,
        "entry": 190.0,
        "stop": 185.0,
        "target": 200.0,
        "source": "ai+rsi_extreme",
        "reasons": ["AI flagged long setup", "RSI oversold on 4H, 1D"],
    }
    print(json.dumps(send_alert(demo), indent=2, default=str))
