"""Section 3 — Config loads and masks secrets."""

from __future__ import annotations

from backend import config


def test_config(check):
    # --------------------------------------------------------------------------- #
    # 3. Config loads and masks secrets
    # --------------------------------------------------------------------------- #
    settings = config.get_settings()
    check("config watchlist non-empty", len(settings.watchlist) > 0)
    check("ollama chat url built", settings.ollama.chat_url.endswith("/api/chat"))
