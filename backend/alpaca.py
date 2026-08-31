"""Alpaca paper-trading broker client.

Thin ``httpx``-based wrapper around the Alpaca REST API v2.
Credentials are read from DB settings first (alpaca_paper_url,
alpaca_key_id, alpaca_secret_key), falling back to env-var defaults
stored in :class:`~backend.config.AlpacaConfig`.

Usage::

    from backend.alpaca import get_client, AlpacaError

    client = get_client()
    account = client.get_account()   # {"equity": ..., "buying_power": ...}
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

import httpx

from .config import get_settings
from .database import get_setting

_log = logging.getLogger(__name__)

_TIMEOUT = 15  # seconds for all Alpaca calls
_DATA_URL = "https://data.alpaca.markets"  # market data — separate host from trading API

# Allowlist of hostnames the client is permitted to connect to.
# Prevents SSRF if a malicious value is stored in DB settings.
_ALLOWED_HOSTS: frozenset[str] = frozenset(
    {
        "paper-api.alpaca.markets",
        "api.alpaca.markets",
        "data.alpaca.markets",
    }
)

_ALLOWED_BASE_URLS: dict[str, str] = {
    "paper-api.alpaca.markets": "https://paper-api.alpaca.markets",
    "api.alpaca.markets": "https://api.alpaca.markets",
    "data.alpaca.markets": "https://data.alpaca.markets",
}


class AlpacaError(Exception):
    """Raised when an Alpaca API call fails."""


def _validate_url(url: str) -> str:
    """Validate *url* and return a URL reconstructed from safe components.

    Enforces HTTPS and restricts the hostname to known Alpaca endpoints so
    that a compromised DB setting cannot redirect requests to an internal
    network address (SSRF).  The returned string is built from the validated
    ``parsed.hostname`` — not from the original input — breaking any taint
    chain that CodeQL (or similar tools) would otherwise track.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise AlpacaError(
            f"Alpaca base URL must use HTTPS (got scheme {parsed.scheme!r})"
        )
    if parsed.hostname not in _ALLOWED_HOSTS:
        raise AlpacaError(
            f"Alpaca base URL host {parsed.hostname!r} is not an allowed "
            f"Alpaca endpoint. Allowed hosts: {sorted(_ALLOWED_HOSTS)}"
        )
    return _ALLOWED_BASE_URLS[parsed.hostname]


class AlpacaClient:
    """Synchronous Alpaca REST API v2 client for paper trading.

    When *key_id*, *secret_key*, or *base_url* are supplied explicitly they
    take precedence over DB settings and env vars.  This is used by the
    connection-test endpoint so credentials can be tested before saving.
    """

    def __init__(
        self,
        *,
        key_id: str | None = None,
        secret_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        cfg = get_settings().alpaca
        raw_url = (base_url or get_setting("alpaca_paper_url", "") or cfg.paper_url).rstrip("/")
        # Normalise: strip /v2 suffix so paths like /v2/account are always appended once.
        # Users sometimes paste the full versioned URL (e.g. https://paper-api.alpaca.markets/v2).
        normalised = raw_url[:-3] if raw_url.endswith("/v2") else raw_url
        self._base_url = _validate_url(normalised)
        self._key_id = (
            key_id if key_id is not None else (get_setting("alpaca_key_id", "") or cfg.key_id)
        )
        self._secret_key = (
            secret_key
            if secret_key is not None
            else (get_setting("alpaca_secret_key", "") or cfg.secret_key)
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "APCA-API-KEY-ID": self._key_id,
            "APCA-API-SECRET-KEY": self._secret_key,
            "Accept": "application/json",
        }

    def _get(self, path: str, params: dict | None = None) -> Any:
        url = f"{self._base_url}{path}"
        try:
            r = httpx.get(url, headers=self._headers(), params=params, timeout=_TIMEOUT)
            if not r.is_success:
                raise AlpacaError(f"GET {path} → {r.status_code}: {r.text[:200]}")
            return r.json()
        except httpx.RequestError as exc:
            raise AlpacaError(f"GET {path} network error: {exc}") from exc

    def _post(self, path: str, body: dict) -> Any:
        url = f"{self._base_url}{path}"
        try:
            r = httpx.post(url, headers=self._headers(), json=body, timeout=_TIMEOUT)
            if not r.is_success:
                raise AlpacaError(f"POST {path} → {r.status_code}: {r.text[:200]}")
            return r.json()
        except httpx.RequestError as exc:
            raise AlpacaError(f"POST {path} network error: {exc}") from exc

    def _delete(self, path: str) -> bool:
        url = f"{self._base_url}{path}"
        try:
            r = httpx.delete(url, headers=self._headers(), timeout=_TIMEOUT)
            # 204 No Content = success for Alpaca DELETE
            return r.status_code in (200, 204)
        except httpx.RequestError as exc:
            raise AlpacaError(f"DELETE {path} network error: {exc}") from exc

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    def get_account(self) -> dict[str, Any]:
        """Return Alpaca account summary with computed day P&L."""
        raw = self._get("/v2/account")
        equity = float(raw.get("equity") or 0)
        last_equity = float(raw.get("last_equity") or equity)
        day_pnl = equity - last_equity
        day_pnl_pct = (day_pnl / last_equity * 100) if last_equity else 0.0
        return {
            "equity": equity,
            "last_equity": last_equity,
            "day_pnl": day_pnl,
            "day_pnl_pct": round(day_pnl_pct, 4),
            "cash": float(raw.get("cash") or 0),
            "buying_power": float(raw.get("buying_power") or 0),
            "non_marginable_buying_power": float(raw.get("non_marginable_buying_power") or 0),
            "portfolio_value": float(raw.get("portfolio_value") or 0),
            "long_market_value": float(raw.get("long_market_value") or 0),
            "short_market_value": float(raw.get("short_market_value") or 0),
            "initial_margin": float(raw.get("initial_margin") or 0),
            "maintenance_margin": float(raw.get("maintenance_margin") or 0),
            "daytrade_count": int(raw.get("daytrade_count") or 0),
            "multiplier": raw.get("multiplier", "1"),
            "shorting_enabled": bool(raw.get("shorting_enabled", False)),
            "trading_blocked": bool(raw.get("trading_blocked", False)),
            "account_blocked": bool(raw.get("account_blocked", False)),
            "currency": raw.get("currency", "USD"),
            "status": raw.get("status"),
            "balance_asof": raw.get("balance_asof"),
        }

    def get_clock(self) -> dict[str, Any]:
        """Return market clock (is_open, next_open, next_close)."""
        return self._get("/v2/clock")

    def get_portfolio_history(
        self,
        period: str = "1M",
        timeframe: str = "1D",
    ) -> dict[str, Any]:
        """Return equity curve + P&L for the given period/timeframe.

        period:    1D, 1W, 1M, 3M, 6M, 1A
        timeframe: 1Min, 5Min, 15Min, 1H, 1D
        """
        return self._get(
            "/v2/account/portfolio/history",
            params={"period": period, "timeframe": timeframe},
        )

    def place_bracket_order(
        self,
        *,
        ticker: str,
        side: str,  # "buy" | "sell"
        notional: float,  # fixed $ amount
        stop_price: float,
        take_profit_price: float,
    ) -> dict[str, Any]:
        """Place a market bracket order (entry at market + stop-loss + take-profit).

        Uses ``notional`` (dollar amount) so fractional shares are handled
        automatically by Alpaca for supported securities.

        Returns the raw Alpaca order dict.
        """
        if not self._key_id or not self._secret_key:
            raise AlpacaError("Alpaca credentials not configured")

        body: dict[str, Any] = {
            "symbol": ticker,
            "notional": str(round(notional, 2)),
            "side": side,
            "type": "market",
            "time_in_force": "day",
            "order_class": "bracket",
            "stop_loss": {"stop_price": str(round(stop_price, 4))},
            "take_profit": {"limit_price": str(round(take_profit_price, 4))},
        }
        _log.info(
            "alpaca: placing %s %s notional=$%.2f stop=%.4f tp=%.4f",
            side,
            ticker,
            notional,
            stop_price,
            take_profit_price,
        )
        return self._post("/v2/orders", body)

    def get_orders(self, status: str = "all", limit: int = 50) -> list[dict[str, Any]]:
        """Return recent orders from Alpaca (most recent first)."""
        return self._get(
            "/v2/orders",
            params={"status": status, "limit": limit, "direction": "desc"},
        )

    def get_positions(self) -> list[dict[str, Any]]:
        """Return all open positions."""
        return self._get("/v2/positions")

    def cancel_order(self, alpaca_order_id: str) -> bool:
        """Cancel a pending order. Returns True on success."""
        return self._delete(f"/v2/orders/{alpaca_order_id}")

    def get_snapshots(self, tickers: list[str]) -> dict[str, Any]:
        """Return live market snapshots for up to 50 tickers in one call.

        Hits the market data host (data.alpaca.markets) rather than the
        trading API.  Each entry contains dailyBar, prevDailyBar, minuteBar,
        latestTrade, and latestQuote.  Free-tier credentials are sufficient.
        """
        if not tickers:
            return {}
        symbols = ",".join(t.upper() for t in tickers[:50])
        url = f"{_DATA_URL}/v2/stocks/snapshots"
        try:
            r = httpx.get(
                url,
                headers=self._headers(),
                params={"symbols": symbols},
                timeout=_TIMEOUT,
            )
            if not r.is_success:
                raise AlpacaError(f"snapshots → {r.status_code}: {r.text[:200]}")
            return r.json() or {}
        except httpx.RequestError as exc:
            raise AlpacaError(f"snapshots network error: {exc}") from exc


# --------------------------------------------------------------------------- #
# Module-level singleton — recreated when credentials change
# --------------------------------------------------------------------------- #
# Stored in a dict so the factory never needs a `global` statement.
_client_state: dict[str, Any] = {"client": None, "key_id": ""}


def get_client() -> AlpacaClient:
    """Return a (possibly cached) :class:`AlpacaClient`.

    Re-instantiates when the DB key_id changes so runtime credential
    updates from the Settings page take effect without a restart.
    """
    current_key_id = get_setting("alpaca_key_id", "") or get_settings().alpaca.key_id
    if _client_state["client"] is None or current_key_id != _client_state["key_id"]:
        _client_state["client"] = AlpacaClient()
        _client_state["key_id"] = current_key_id
    return _client_state["client"]
