"""Alerting: format opportunities and deliver via Gmail SMTP, Slack, and/or Telegram.

Alerts only fire for opportunities whose confidence meets the configured
floor. All channels are optional and independently gated by their
``*_ENABLED`` env flags and by having complete credentials.

Email and Slack can be suspended globally with ``ALERTS_SEND_ENABLED=false``
(e.g. during local testing) while keeping Telegram active.

Run standalone to send a test alert through whatever channels are configured::

    python -m backend.alerts
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List, Optional

import requests

from .config import get_settings
from .database import get_setting

_log = logging.getLogger(__name__)


def _is_alerts_enabled() -> bool:
    db_val = get_setting("alerts_enabled", "")
    if db_val:
        return db_val.lower() == "true"
    return get_settings().alerts_send_enabled


def _fmt_level(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def format_alert(opportunity: Dict[str, Any]) -> Dict[str, str]:
    """Build a ``{"subject", "text"}`` message from an opportunity dict."""

    ticker = opportunity.get("ticker", "?")
    side = str(opportunity.get("type", "none")).upper()
    confidence = float(opportunity.get("confidence") or 0.0)
    price = opportunity.get("price")
    source = opportunity.get("source") or "+".join(opportunity.get("sources", []) or [])
    reasons = opportunity.get("reasons") or []

    subject = f"[offgrid-trader] {side} {ticker} ({confidence:.0f}% confidence)"

    lines: List[str] = [
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
def send_email(subject: str, body: str) -> bool:
    """Send *body* via Gmail SMTP using an App Password. Returns success."""

    settings = get_settings()
    email = settings.email
    if not email.is_configured:
        return False

    message = MIMEMultipart()
    message["From"] = email.sender or email.username
    message["To"] = email.recipient
    message["Subject"] = subject
    message.attach(MIMEText(body, "plain"))

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(email.smtp_host, email.smtp_port, timeout=20) as server:
            server.starttls(context=context)
            server.login(email.username, email.password)
            server.sendmail(
                email.sender or email.username,
                [email.recipient],
                message.as_string(),
            )
        return True
    except Exception as exc:  # pragma: no cover - network/credential dependent
        _log.warning("email send failed: %s", exc)
        return False


def send_slack(text: str) -> bool:
    """Post *text* to the configured Slack Incoming Webhook. Returns success."""

    settings = get_settings()
    slack = settings.slack
    if not slack.is_configured:
        return False
    try:
        response = requests.post(slack.webhook_url, json={"text": text}, timeout=15)
        if response.status_code // 100 == 2:
            return True
        _log.warning("slack returned HTTP %s: %s", response.status_code, response.text[:200])
        return False
    except Exception as exc:  # pragma: no cover - network dependent
        _log.warning("slack send failed: %s", exc)
        return False


def send_telegram(subject: str, body: str) -> bool:
    """Send *subject* + *body* via Telegram Bot API. Returns success."""

    import httpx  # already in requirements; local import to avoid top-level dep

    settings = get_settings()
    tg = settings.telegram
    if not tg.is_configured:
        return False

    text = f"*{subject}*\n\n{body}"
    url = (
        f"https://api.telegram.org/bot{tg.bot_token}/sendMessage"
    )
    try:
        r = httpx.post(
            url,
            json={
                "chat_id": tg.chat_id,
                "text": text,
                "parse_mode": "Markdown",
            },
            timeout=10.0,
        )
        r.raise_for_status()
        return True
    except Exception as exc:  # pragma: no cover - network dependent
        _log.warning("telegram send failed: %s", exc)
        return False


def send_alert(
    opportunity: Dict[str, Any],
    *,
    min_confidence: Optional[float] = None,
) -> Dict[str, Any]:
    """Format and dispatch an alert if it clears the confidence floor.

    Returns a result dict describing what happened, e.g.
    ``{"sent": True, "channels": ["slack"], "skipped": False}``.
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
    channels: List[str] = []

    if _is_alerts_enabled():
        if send_email(message["subject"], message["text"]):
            channels.append("email")
        if send_slack(message["text"]):
            channels.append("slack")
    else:
        _log.info("alerts disabled — skipping email/Slack")

    if send_telegram(message["subject"], message["text"]):
        channels.append("telegram")

    return {
        "sent": bool(channels),
        "skipped": False,
        "channels": channels,
        "subject": message["subject"],
    }


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
