"""Pluggable notification channel registry.

Add a new channel by:
1. Creating backend/notifications/<channel>.py that implements NotificationChannel.
2. Importing and appending an instance to REGISTRY in register_channels() below.
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

_log = logging.getLogger(__name__)


@runtime_checkable
class NotificationChannel(Protocol):
    """Protocol every notification channel must satisfy."""

    name: str

    @property
    def is_configured(self) -> bool:
        pass  # Protocol stub — implemented by each channel class

    def send(
        self,
        subject: str,
        body: str,
        *,
        actions: list[dict] | None = None,
        tags: str | None = None,
        priority: str | None = None,
    ) -> bool:
        pass  # Protocol stub — implemented by each channel class


_REGISTRY: list[NotificationChannel] = []


def register_channels() -> None:
    """Populate the registry. Called once at app startup (backend/main.py lifespan)."""
    from .ntfy import NtfyChannel

    _REGISTRY.clear()
    _REGISTRY.append(NtfyChannel())


def dispatch(
    subject: str,
    body: str,
    *,
    actions: list[dict] | None = None,
    tags: str | None = None,
    priority: str | None = None,
) -> dict[str, bool]:
    """Send to all configured channels; isolate failures per channel.

    Returns a mapping of channel name → success bool.
    """
    results: dict[str, bool] = {}
    for channel in _REGISTRY:
        if not channel.is_configured:
            continue
        try:
            results[channel.name] = channel.send(
                subject, body, actions=actions, tags=tags, priority=priority
            )
        except Exception as exc:  # noqa: BLE001
            _log.warning("notification channel %r failed: %s", channel.name, exc)
            results[channel.name] = False

    if results:
        from backend.database import save_event

        _ok = [k for k, v in results.items() if v]
        save_event(
            "notification",
            f"Notification sent via {', '.join(_ok)}" if _ok else "Notification failed",
            level="info" if _ok else "warn",
            meta={"subject": subject},
        )
    return results
