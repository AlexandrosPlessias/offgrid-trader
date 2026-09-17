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

import json
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


def _tg_html_escape(s: str) -> str:
    """Escape the only three characters Telegram's HTML parse_mode reserves."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def format_alert(opportunity: dict[str, Any]) -> dict[str, str]:
    """Build a ``{"subject", "text"}`` message from an opportunity dict."""

    ticker = opportunity.get("ticker", "?")
    side = str(opportunity.get("type", "none")).upper()
    confidence = float(opportunity.get("confidence") or 0.0)
    price = opportunity.get("price")
    source = opportunity.get("source") or "+".join(opportunity.get("sources", []) or [])
    reasons = opportunity.get("reasons") or []

    subject = f"MarketSage · {side} {ticker} · {confidence:.0f}% confidence"

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
    lines.append("Not financial advice · Generated locally by MarketSage")

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


def send_telegram(
    subject: str,
    body: str,
    reply_markup: dict | None = None,
    *,
    preformatted: bool = False,
) -> bool:
    """Send *subject* + *body* via Telegram Bot API (HTML parse mode). Returns success.

    ``reply_markup`` (optional) is an inline-keyboard dict, e.g. a callback button:
    ``{"inline_keyboard": [[{"text": "📄 Order", "callback_data": "ord:…"}]]}``.
    ``preformatted`` wraps the body in ``<pre>`` so space-aligned tables render as a
    monospace block (signal alert / EoD digest); since HTML needs only ``& < >``
    escaped, it also makes LLM-generated body text injection-proof.
    """

    import httpx  # already in requirements; local import to avoid top-level dep

    tg = resolve_telegram()
    if not (tg["enabled"] and tg["bot_token"] and tg["chat_id"]):
        return False

    subj = f"<b>{_tg_html_escape(subject)}</b>"
    if body:
        esc = _tg_html_escape(body)
        text = f"{subj}\n\n<pre>{esc}</pre>" if preformatted else f"{subj}\n\n{esc}"
    else:
        text = subj  # subject-only (e.g. system events) — avoid an empty <pre> block
    url = f"https://api.telegram.org/bot{tg['bot_token']}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": tg["chat_id"],
        "text": text,
        "parse_mode": "HTML",
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        r = httpx.post(url, json=payload, timeout=10.0)
        r.raise_for_status()
        return True
    except Exception:  # pragma: no cover - network dependent
        # Retry once without the inline button — an invalid button URL (e.g. a localhost
        # BACKEND_PUBLIC_URL → BUTTON_URL_INVALID) rejects the whole message.
        if reply_markup:
            try:
                payload.pop("reply_markup", None)
                r = httpx.post(url, json=payload, timeout=10.0)
                r.raise_for_status()
                _log.info("telegram: sent without inline button (button URL rejected)")
                return True
            except Exception:  # pragma: no cover - network dependent
                _log.debug("telegram retry without inline button failed; trying plain text")
        # Last resort: drop HTML parse_mode and resend as plain text, so an HTML parse
        # error never silently loses the message.
        try:
            payload.pop("reply_markup", None)
            payload.pop("parse_mode", None)
            payload["text"] = f"{subject}\n\n{body}".strip() if body else subject
            r = httpx.post(url, json=payload, timeout=10.0)
            r.raise_for_status()
            _log.info("telegram: sent as plain text (parse_mode dropped)")
            return True
        except Exception as exc:  # pragma: no cover - network dependent
            _log.warning("telegram send failed: %s", exc)
            return False


def _order_side(opp_type: str) -> str:
    """Map an opportunity type (long/short) to an Alpaca order side (buy/sell)."""
    return "sell" if str(opp_type).lower() in ("short", "sell") else "buy"


def _bracket_payload(opp: dict[str, Any]) -> dict[str, Any]:
    """Build a ManualOrderRequest body (POST /paper/orders/place) from an opportunity."""
    return {
        "ticker": opp.get("ticker"),
        "side": _order_side(opp.get("type", "long")),
        "entry": opp.get("entry"),
        "stop": opp.get("stop"),
        "target": opp.get("target"),
        "signal_confidence": opp.get("confidence"),
        "signal_source": opp.get("source") or "+".join(opp.get("sources", []) or []),
    }


def _frac_payload(opp: dict[str, Any]) -> dict[str, Any]:
    """Build a FracOrderRequest body (POST /frac/order) from a long opportunity.

    The tap is the confirmation, so ``confirm_live=True`` lets it place in live mode too.
    """
    return {
        "ticker": opp.get("ticker"),
        "side": "buy",
        "entry": opp.get("entry"),
        "confirm_live": True,
        "signal_confidence": opp.get("confidence"),
        "signal_source": opp.get("source") or "+".join(opp.get("sources", []) or []),
    }


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

    # From-notification trade buttons drive the same endpoints the UI uses (dedup,
    # shortable/fractionable checks, budget cap — no bypass). Two actions per alert:
    # a bracket order (long or short, needs entry/stop/target) and, for long signals,
    # a fractional buy. ntfy carries them as http actions; Telegram as callback buttons.
    backend_url = (get_setting("backend_public_url", "") or cfg.backend_public_url).rstrip("/")
    ticker = opportunity.get("ticker")
    is_long = str(opportunity.get("type", "long")).lower() in ("long", "buy")
    order_side = _order_side(opportunity.get("type", "long"))
    has_levels = ticker is not None and all(
        opportunity.get(k) is not None for k in ("entry", "stop", "target")
    )
    has_entry = ticker is not None and opportunity.get("entry") is not None

    actions: list[dict] = []
    tg_buttons: list[dict] = []
    if has_levels:
        actions.append(
            {
                "label": f"Order {ticker} {order_side.upper()}",
                "url": f"{backend_url}/paper/orders/place",
                "method": "POST",
                "body": json.dumps(_bracket_payload(opportunity)),
            }
        )
        tg_buttons.append(
            {
                "text": f"📄 Order {order_side.upper()} {ticker}",
                "callback_data": (
                    f"ord:{ticker}:{order_side}:{opportunity['entry']:.2f}"
                    f":{opportunity['stop']:.2f}:{opportunity['target']:.2f}"
                ),
            }
        )
    if is_long and has_entry:
        actions.append(
            {
                "label": f"Frac {ticker}",
                "url": f"{backend_url}/frac/order",
                "method": "POST",
                "body": json.dumps(_frac_payload(opportunity)),
            }
        )
        tg_buttons.append(
            {
                "text": f"🪙 Frac {ticker}",
                "callback_data": f"frac:{ticker}:{opportunity['entry']:.2f}",
            }
        )

    tg_markup = {"inline_keyboard": [[b] for b in tg_buttons]} if tg_buttons else None
    tag = "chart_with_upwards_trend" if is_long else "chart_with_downwards_trend"

    if send_telegram(
        message["subject"], message["text"], reply_markup=tg_markup, preformatted=True
    ):
        channels.append("telegram")

    ntfy_results = _notify_dispatch(
        message["subject"],
        message["text"],
        actions=actions or None,
        tags=tag,
        priority="high",
    )
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
    side: str,  # "buy" | "sell"
    amount: float,
    mode: str = "paper",
    detail: str = "",
    is_close: bool = False,  # True for stop/target/manual exits
) -> None:
    """Notify configured channels that an order / fractional position was placed or closed.

    Gated by the ``order_notifications_enabled`` setting (default on). Reuses
    :func:`send_system_event` so it respects each channel's own config. Never
    raises — placement must never fail because a notification failed.
    """
    try:
        from .database import get_setting, save_event

        if kind == "fractional":
            label = "Fractional exit" if is_close else "Fractional buy"
            icon = "📉" if is_close else "🪙"
        else:
            label = "Order closed" if is_close else "Order placed"
            icon = "📉" if is_close else "📈"

        save_event(
            "order",
            f"{label} — {side.upper()} {ticker} ${amount:.2f} ({mode})",
            meta={
                "ticker": ticker,
                "side": side,
                "amount": amount,
                "mode": mode,
                "kind": kind,
                "is_close": is_close,
            },
        )
        if get_setting("order_notifications_enabled", "true") != "true":
            return
        mode_label = "LIVE 💰" if mode == "live" else "paper"
        msg = f"{icon} {label} — {side.upper()} {ticker} · ${amount:.2f} · {mode_label}"
        if detail:
            msg += f"\n{detail}"
        tags = "moneybag,white_check_mark" if mode == "live" else "white_check_mark"
        priority = "high" if mode == "live" else "default"
        send_system_event(msg, tags=tags, priority=priority)
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("order notification failed: %s", exc)


def send_system_event(
    message: str, *, tags: str | None = None, priority: str | None = None
) -> dict[str, bool]:
    """Fire a minimal system notification (e.g. startup/shutdown) via enabled channels.

    Reuses the existing send logic (ntfy dispatch + Telegram). Each channel only
    fires when it is configured and enabled (their own guards). Never raises —
    every failure is logged and swallowed so this can't block startup or shutdown.

    The emoji lives in the message body (UTF-8, preserved); the ntfy Title stays
    a plain ASCII "MarketSage". ``tags``/``priority`` tune the ntfy notification.
    """
    results: dict[str, bool] = {}
    try:
        from .notifications import dispatch as _notify_dispatch

        results.update(_notify_dispatch("MarketSage", message, tags=tags, priority=priority))
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("system notification via ntfy failed: %s", exc)
    try:
        if send_telegram(message, ""):
            results["telegram"] = True
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("system notification via telegram failed: %s", exc)
    return results


def send_report(
    subject: str,
    body: str,
    *,
    tags: str | None = None,
    priority: str | None = None,
    preformatted: bool = True,
) -> dict[str, bool]:
    """Fan a digest/report out to BOTH ntfy and Telegram.

    Like :func:`send_system_event` but carries a distinct subject + a rich body and
    renders the Telegram side as a monospace ``<pre>`` block (``preformatted``), so
    space-aligned tables survive. Used by the EoD digest and the LLM periodic reports.
    Never raises — each channel failure is logged and swallowed.
    """
    results: dict[str, bool] = {}
    try:
        from .notifications import dispatch as _notify_dispatch

        results.update(_notify_dispatch(subject, body, tags=tags, priority=priority))
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("report via ntfy failed: %s", exc)
    try:
        if send_telegram(subject, body, preformatted=preformatted):
            results["telegram"] = True
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("report via telegram failed: %s", exc)
    return results


if __name__ == "__main__":
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
