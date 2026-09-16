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
import uuid
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
        raise AlpacaError(f"Alpaca base URL must use HTTPS (got scheme {parsed.scheme!r})")
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
        normalised = raw_url.removesuffix("/v2")
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
        notional: float,  # fixed $ amount — converted to whole shares internally
        entry_price: float,  # current price used to derive share qty
        stop_price: float,
        take_profit_price: float,
    ) -> dict[str, Any]:
        """Place a market bracket order (entry at market + stop-loss + take-profit).

        Alpaca does not allow ``notional`` (fractional) for bracket orders —
        it raises "fractional orders must be simple orders".  We therefore
        compute whole-share ``qty`` from ``notional / entry_price`` (minimum 1
        share).  Stop and take-profit prices are rounded to 2 decimal places to
        satisfy Alpaca's minimum pricing increment requirement.

        Returns the raw Alpaca order dict.
        """
        if not self._key_id or not self._secret_key:
            raise AlpacaError("Alpaca credentials not configured")

        qty = int(notional / entry_price) if entry_price > 0 else 0
        if qty < 1:
            raise AlpacaError(
                f"Position size ${notional:.0f} is too small to buy 1 share of {ticker} "
                f"at ${entry_price:.2f} — minimum required: ${entry_price:.2f}. "
                f"Increase 'Position size $' in Settings → Paper Trading."
            )
        # Alpaca rejects sub-penny increments on limit/stop legs
        stop_2dp = round(stop_price, 2)
        tp_2dp = round(take_profit_price, 2)

        body: dict[str, Any] = {
            "symbol": ticker,
            "qty": str(qty),
            "side": side,
            "type": "market",
            "time_in_force": "day",
            "order_class": "bracket",
            "stop_loss": {"stop_price": str(stop_2dp)},
            "take_profit": {"limit_price": str(tp_2dp)},
        }
        # Sanitise user-supplied strings before logging to prevent log-injection
        # (CodeQL py/log-injection: strip CR/LF that could forge log lines).
        # entry_price/stop_2dp/tp_2dp are floats formatted with %.2f — CR/LF is impossible.
        safe_side = side.replace("\r", "").replace("\n", "")
        safe_ticker = ticker.replace("\r", "").replace("\n", "")
        _log.info(  # lgtm [py/log-injection]
            "alpaca: placing %s %s qty=%d (notional=$%.0f @ $%.2f) stop=%.2f tp=%.2f",
            safe_side,
            safe_ticker,
            qty,
            notional,
            entry_price,
            stop_2dp,
            tp_2dp,
        )
        return self._post("/v2/orders", body)

    def place_notional_order(
        self,
        *,
        ticker: str,
        side: str,  # "buy" | "sell"
        notional: float | None = None,  # $ amount — fractional buy
        qty: float | None = None,  # share qty — used to sell/close a held fraction
        time_in_force: str = "day",
    ) -> dict[str, Any]:
        """Place a simple (non-bracket) market order supporting fractional shares.

        Alpaca allows fractional trading only on *simple* market/limit orders —
        never bracket/OTO (``place_bracket_order`` rejects fractional for that
        reason).  Buys use ``notional`` (a dollar amount, e.g. $15 → 0.07
        shares); sells/closes use ``qty`` (the exact fractional quantity held).
        Exactly one of ``notional`` or ``qty`` must be supplied.

        Returns the raw Alpaca order dict.
        """
        if not self._key_id or not self._secret_key:
            raise AlpacaError("Alpaca credentials not configured")
        if (notional is None) == (qty is None):
            raise AlpacaError("place_notional_order: provide exactly one of notional or qty")

        body: dict[str, Any] = {
            "symbol": ticker,
            "side": side,
            "type": "market",
            "time_in_force": time_in_force,
        }
        if notional is not None:
            body["notional"] = str(round(notional, 2))
        else:
            body["qty"] = str(qty)

        # Sanitise user-supplied strings before logging (CodeQL py/log-injection).
        safe_side = side.replace("\r", "").replace("\n", "")
        safe_ticker = ticker.replace("\r", "").replace("\n", "")
        _log.info(  # lgtm [py/log-injection]
            "alpaca: placing fractional %s %s notional=%s qty=%s",
            safe_side,
            safe_ticker,
            body.get("notional"),
            body.get("qty"),
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
        # Validate UUID format before inserting into URL path.
        # Alpaca order IDs are always UUIDs; normalising via uuid.UUID() also
        # breaks any taint chain that CodeQL would track as partial SSRF.
        try:
            safe_id = str(uuid.UUID(str(alpaca_order_id)))
        except (ValueError, AttributeError) as exc:
            raise AlpacaError("cancel_order: invalid order ID format") from exc
        return self._delete(f"/v2/orders/{safe_id}")

    def get_most_actives(self, top: int = 20) -> list[dict[str, Any]]:
        """Return the most-active stocks by volume from the Alpaca screener.

        Hits the market-data host (data.alpaca.markets) using the v1beta1
        screener endpoint.  Returns normalised items: {symbol, volume, trade_count}.

        Raises :class:`AlpacaError` on any HTTP failure, including HTTP 403
        when the free tier does not include screener access.  Callers should
        catch ``AlpacaError`` and fall back to yfinance.
        """
        url = f"{_DATA_URL}/v1beta1/screener/stocks/most-actives"
        try:
            r = httpx.get(
                url,
                headers=self._headers(),
                params={"by": "volume", "top": max(1, min(top, 100))},
                timeout=_TIMEOUT,
            )
            if not r.is_success:
                raise AlpacaError(f"most-actives → {r.status_code}: {r.text[:200]}")
            return r.json().get("most_actives", [])
        except httpx.RequestError as exc:
            raise AlpacaError(f"most-actives network error: {exc}") from exc

    def get_movers(self, top: int = 20) -> dict[str, list[dict[str, Any]]]:
        """Return top gainers and losers from the Alpaca screener.

        Returns ``{"gainers": [...], "losers": [...]}`` where each item
        contains {symbol, price, change, percent_change}.

        Raises :class:`AlpacaError` on any HTTP failure, including HTTP 403.
        """
        url = f"{_DATA_URL}/v1beta1/screener/stocks/movers"
        try:
            r = httpx.get(
                url,
                headers=self._headers(),
                params={"top": max(1, min(top, 50))},
                timeout=_TIMEOUT,
            )
            if not r.is_success:
                raise AlpacaError(f"movers → {r.status_code}: {r.text[:200]}")
            data = r.json()
            return {
                "gainers": data.get("gainers", []),
                "losers": data.get("losers", []),
            }
        except httpx.RequestError as exc:
            raise AlpacaError(f"movers network error: {exc}") from exc

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


# --------------------------------------------------------------------------- #
# Fractional profile — a *second* Alpaca account (paper during monitoring,
# live once the user swaps its host).  Kept separate from the singleton above
# so the two accounts never share a client instance.
# --------------------------------------------------------------------------- #
_frac_client_state: dict[str, Any] = {"client": None, "cache_key": ""}


def frac_mode() -> str:
    """Return ``'live'`` or ``'paper'`` for the fractional profile's host."""
    base_url = get_setting("frac_alpaca_url", "") or get_settings().frac.url
    return "live" if "://api.alpaca.markets" in base_url else "paper"


def get_frac_client() -> AlpacaClient:
    """Return a (possibly cached) :class:`AlpacaClient` for the fractional profile.

    Reads the ``frac_alpaca_*`` DB settings (falling back to ``FracConfig``
    env defaults).  Re-instantiates when the key **or host** changes, so the
    paper→live swap from the Settings page takes effect without a restart.
    """
    cfg = get_settings().frac
    key_id = get_setting("frac_alpaca_key_id", "") or cfg.key_id
    secret_key = get_setting("frac_alpaca_secret_key", "") or cfg.secret_key
    base_url = get_setting("frac_alpaca_url", "") or cfg.url
    cache_key = f"{key_id}@{base_url}"
    if _frac_client_state["client"] is None or cache_key != _frac_client_state["cache_key"]:
        _frac_client_state["client"] = AlpacaClient(
            key_id=key_id, secret_key=secret_key, base_url=base_url
        )
        _frac_client_state["cache_key"] = cache_key
    return _frac_client_state["client"]
