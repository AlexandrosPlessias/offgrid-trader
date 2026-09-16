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

    def send(self, subject: str, body: str, *, actions: list[dict] | None = None) -> bool:
        pass  # Protocol stub — implemented by each channel class


_REGISTRY: list[NotificationChannel] = []


def register_channels() -> None:
    """Populate the registry. Called once at app startup (backend/main.py lifespan)."""
    from .ntfy import NtfyChannel

    _REGISTRY.clear()
    _REGISTRY.append(NtfyChannel())


def dispatch(subject: str, body: str, *, actions: list[dict] | None = None) -> dict[str, bool]:
    """Send to all configured channels; isolate failures per channel.

    Returns a mapping of channel name → success bool.
    """
    results: dict[str, bool] = {}
    for channel in _REGISTRY:
        if not channel.is_configured:
            continue
        try:
            results[channel.name] = channel.send(subject, body, actions=actions)
        except Exception as exc:  # noqa: BLE001
            _log.warning("notification channel %r failed: %s", channel.name, exc)
            results[channel.name] = False
    return results
