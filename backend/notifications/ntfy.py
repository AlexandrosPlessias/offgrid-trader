"""ntfy push-notification channel.

Delivers a batched scan-cycle summary to a self-hosted ntfy server
(Docker infra container or Fly.io sidecar). Uses ntfy's `http` action
buttons so the user can place a paper trade directly from the phone
without a separate callback endpoint.
"""

from __future__ import annotations

import logging

import httpx

from backend.config import get_settings
from backend.database import get_setting

_log = logging.getLogger(__name__)


def _ascii_header(value: str) -> str:
    """Coerce a string to an ASCII-safe HTTP header value.

    HTTP headers must be Latin-1; ntfy Title/Tags with unicode (em dash, emoji)
    make httpx raise. Replace common punctuation, drop anything else. Emoji and
    unicode belong in the message *body* (UTF-8), not headers.
    """
    replacements = {
        "—": "-",
        "–": "-",
        "·": "-",
        "’": "'",
        "‘": "'",
        "“": '"',
        "”": '"',
        "…": "...",
    }
    for uni, ascii_ in replacements.items():
        value = value.replace(uni, ascii_)
    return value.encode("ascii", "ignore").decode("ascii").strip()


def resolve_topic() -> str:
    return get_setting("ntfy_topic", "") or get_settings().ntfy.topic


def resolve_server() -> str:
    return get_setting("ntfy_server", "") or get_settings().ntfy.server


def _validate_server(server: str) -> str:
    """Reject non-http/https server URLs to prevent SSRF via a misconfigured DB value."""
    from urllib.parse import urlparse

    parsed = urlparse(server)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"ntfy server must use http or https scheme, got: {parsed.scheme!r}")
    return server


def post_ntfy(
    server: str,
    topic: str,
    subject: str,
    body: str,
    *,
    tags: str | None = None,
    actions: list[dict] | None = None,
    priority: str | None = None,
) -> bool:
    """Low-level ntfy publish. Returns True on 2xx.

    actions is an optional list of {"label", "url", "method", "body"} dicts
    rendered as ntfy `http` action buttons.
    """
    url = f"{_validate_server(server).rstrip('/')}/{topic}"
    headers: dict[str, str] = {
        "Title": _ascii_header(subject) or "MarketSage",
        "Tags": _ascii_header(tags) if tags else "chart_with_upwards_trend,bell",
        "Content-Type": "text/plain; charset=utf-8",
    }
    if priority:
        headers["Priority"] = priority
    if actions:
        # Inject the admin Bearer token into every action so the backend's auth
        # middleware doesn't 401 the HTTP request ntfy fires on button tap.
        _token = get_setting("admin_token", "") or get_settings().admin_token or ""
        action_parts = []
        for a in actions:
            label = _ascii_header(a["label"]) or "Action"
            parts = [f"http, {label}, {a['url']}", f"method={a.get('method', 'POST')}"]
            if a.get("body"):
                # Single-quote so the JSON body's internal commas don't split the
                # comma-delimited ntfy Actions grammar (ntfy honours quoted values).
                parts.append(f"body='{a['body']}'")
            parts.append("headers.Content-Type=application/json")
            if _token:
                parts.append(f"headers.Authorization=Bearer {_token}")
            action_parts.append(", ".join(parts))
        headers["Actions"] = _ascii_header("; ".join(action_parts))

    try:
        r = httpx.post(url, content=body.encode(), headers=headers, timeout=10.0)
        r.raise_for_status()
        # Sanitize before logging — strip newlines to prevent log-injection.
        safe_server = server[:50].replace("\n", "").replace("\r", "")
        safe_topic = topic[:50].replace("\n", "").replace("\r", "")
        _log.info("ntfy notification sent (server=%r, topic=%r)", safe_server, safe_topic)
        return True
    except Exception as exc:  # pragma: no cover - network dependent
        _log.warning("ntfy send failed: %s", exc)
        return False


class NtfyChannel:
    name = "ntfy"

    @property
    def is_configured(self) -> bool:
        enabled = get_setting("ntfy_enabled", "")
        topic = resolve_topic()
        if enabled:
            return enabled.lower() == "true" and bool(topic)
        return get_settings().ntfy.is_configured

    def send(
        self,
        subject: str,
        body: str,
        *,
        actions: list[dict] | None = None,
        tags: str | None = None,
        priority: str | None = None,
    ) -> bool:
        return post_ntfy(
            resolve_server(),
            resolve_topic(),
            subject,
            body,
            tags=tags,
            actions=actions,
            priority=priority,
        )
