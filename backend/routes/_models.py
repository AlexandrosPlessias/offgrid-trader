"""Shared helpers used by multiple route modules."""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException

_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,15}$")


def _clean_ticker(raw: str) -> str:
    """Normalise and validate a user-supplied ticker symbol.

    Raises ``HTTPException(400)`` if *raw* doesn't look like a real ticker.
    """
    ticker = raw.strip().upper()
    if not ticker or not _TICKER_RE.match(ticker):
        raise HTTPException(status_code=400, detail="invalid ticker")
    return ticker


def _log_safe(value: str) -> str:
    """Strip CR/LF from *value* so it can't forge extra log lines/entries."""
    return value.replace("\r", "").replace("\n", "")


def _safe_error_text(msg: str, limit: int = 200) -> str:
    """Flatten and bound an error string before returning it over the API.

    Only for messages we author ourselves. Collapsing control characters turns a
    multi-line traceback into one line, and the cap stops a large or structured
    upstream response being echoed back wholesale. Raw text from an unexpected
    exception should not be sent to a caller at all — log it and return a generic
    message instead, since it can carry file paths, config values or stack detail.
    """
    flat = " ".join(str(msg).split())
    return flat[:limit] + "…" if len(flat) > limit else flat


def _sse_frame(payload: dict[str, Any]) -> str:
    """Encode *payload* as a single SSE data frame (``data: ...\\n\\n``)."""
    return f"data: {json.dumps(payload)}\n\n"


def _alerts_enabled() -> bool:
    from backend.config import get_settings
    from backend.database import get_setting

    db_val = get_setting("alerts_enabled", "")
    if db_val:
        return db_val.lower() == "true"
    return get_settings().alerts_send_enabled
