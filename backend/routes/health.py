"""Health and auth routes: GET /health, POST /auth/verify."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException

from backend import __version__
from backend.config import get_settings
from backend.database import get_setting
from backend.scheduler import scheduler

router = APIRouter()


@router.get("/health")
def health() -> dict[str, Any]:
    settings = get_settings()
    db_model = get_setting("ollama_model", "")
    db_provider = get_setting("llm_provider", "")
    provider = db_provider or settings.llm.provider
    active_model = (
        db_model or settings.ollama.model
        if provider == "ollama"
        else (get_setting("llm_model", "") or settings.llm.default_model_for(provider))
    )
    result: dict[str, Any] = {
        "status": "ok",
        "version": __version__,
        "llm_provider": provider,
        "llm_model": active_model,
        "watchlist_size": len(settings.watchlist),
        "scheduler": scheduler.status(),
        "disclaimer": "Not financial advice.",
    }
    # Keep ollama_host for backward compatibility with existing clients/tooling.
    if provider == "ollama":
        result["ollama_host"] = settings.ollama.host
        result["ollama_model"] = active_model  # backward compat alias
    return result


@router.post("/auth/verify")
def auth_verify(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Validate the admin token.  Always open (no auth required — this is the login endpoint).

    Returns ``{"ok": true, "dev_mode": true}`` when no token is configured
    (accepts any input — safe for local / dev deployments only).
    Returns ``{"ok": true, "dev_mode": false}`` on a correct token.
    Returns HTTP 401 on a wrong token.
    """
    token: str = body.get("token", "")
    expected = get_settings().admin_token or get_setting("admin_token", "")
    if not expected:
        return {"ok": True, "dev_mode": True}
    if token == expected:
        return {"ok": True, "dev_mode": False}
    raise HTTPException(status_code=401, detail="Invalid token.")
