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


def _confidence_to_priority(confidence: float) -> str:
    if confidence >= 80:
        return "high"
    if confidence >= 65:
        return "default"
    return "low"


class NtfyChannel:
    name = "ntfy"

    @property
    def is_configured(self) -> bool:
        enabled = get_setting("ntfy_enabled", "")
        topic = get_setting("ntfy_topic", "") or get_settings().ntfy.topic
        if enabled:
            return enabled.lower() == "true" and bool(topic)
        return get_settings().ntfy.is_configured

    def _topic(self) -> str:
        return get_setting("ntfy_topic", "") or get_settings().ntfy.topic

    def _server(self) -> str:
        return get_setting("ntfy_server", "") or get_settings().ntfy.server

    def send(
        self,
        subject: str,
        body: str,
        *,
        actions: list[dict] | None = None,
    ) -> bool:
        """POST a notification to the ntfy server.

        actions is an optional list of {"label": str, "url": str, "method": str, "body": str}
        dicts that become ntfy `http` action buttons.
        """
        topic = self._topic()
        server = self._server().rstrip("/")
        url = f"{server}/{topic}"

        headers: dict[str, str] = {
            "Title": subject,
            "Tags": "chart_with_upwards_trend,bell",
            "Content-Type": "text/plain",
        }

        if actions:
            action_parts = []
            for a in actions:
                parts = [
                    f"http, {a['label']}, {a['url']}",
                    f"method={a.get('method', 'POST')}",
                ]
                if a.get("body"):
                    parts.append(f"body={a['body']}")
                parts.append("headers.Content-Type=application/json")
                action_parts.append(", ".join(parts))
            headers["Actions"] = "; ".join(action_parts)

        try:
            r = httpx.post(url, content=body.encode(), headers=headers, timeout=10.0)
            r.raise_for_status()
            _log.info("ntfy notification sent to %s/%s", server, topic)
            return True
        except Exception as exc:  # pragma: no cover - network dependent
            _log.warning("ntfy send failed: %s", exc)
            return False
