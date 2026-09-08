# API Reference

Full reference for the **MarketSage** FastAPI backend.

Base URL (Docker): `http://localhost:8010`  
Base URL (native uvicorn): `http://localhost:8000`

Interactive docs: `http://localhost:8010/docs` or `http://localhost:5174/docs`

---

## Health

### `GET /health`

Liveness check and config summary.

**Response**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "ollama_model": "qwen2.5:14b",
  "ollama_host": "http://ollama:11434",
  "watchlist_size": 6,
  "scheduler": {
    "running": true,
    "market_open": false,
    "last_run": "2026-08-09T14:32:00Z"
  },
  "disclaimer": "Not financial advice."
}
```

```bash
curl http://localhost:8010/health
```

---

## On-demand analysis

### `POST /analyze`

Run the full pipeline for a ticker synchronously. Blocks until complete.

**Request body**
```json
{ "ticker": "AAPL", "send_alerts": false }
```

**Response**
```json
{
  "ticker": "AAPL",
  "analysis": {
    "trend": "bullish",
    "momentum": "strong",
    "signals": ["RSI approaching oversold on 4H"],
    "risk_factors": ["Earnings next week"],
    "key_levels": { "support": [183.5], "resistance": [191.2] },
    "confidence": 78
  },
  "opportunities": [...],
  "actionable": [...],
  "saved_signal_ids": [42],
  "alerts": [],
  "errors": []
}
```

```bash
curl -X POST http://localhost:8010/analyze \
  -H 'Content-Type: application/json' \
  -d '{"ticker": "AAPL"}'
```

---

### `POST /analyze/stream`

Same pipeline as `/analyze`, delivered as a **Server-Sent Events** stream.
Each event is a `data: <json>\n\n` line. The **TickerAgent** runs five skills
and emits events as each one starts and finishes.

**Request body** — same as `/analyze`

**Event types**

| `type` | When emitted | Key fields |
|---|---|---|
| `memory` | Prior scan context loaded from DB | `ticker`, `memory` (last signal, RSI streak, price trend) |
| `step` | Before and after each of the 5 skills | `step` (`fetch`/`analyze`/`detect`/`persist`/`alert`), `status` (`running`/`done`/`error`), `elapsed_ms` |
| `retry` | Before a skill retry sleep (e.g. Ollama timeout) | `skill`, `attempt`, `delay_s` |
| `skill_error` | Non-critical skill failed after all retries | `skill`, `error` |
| `result` | After all skills complete | Full payload (see below) |

**Example event sequence**
```
data: {"type":"memory",  "ticker":"AAPL", "memory":{...}}

data: {"type":"step", "step":"fetch",   "status":"running"}
data: {"type":"step", "step":"fetch",   "status":"done",   "elapsed_ms":2840}

data: {"type":"step", "step":"analyze", "status":"running"}
data: {"type":"retry", "skill":"ai_analysis", "attempt":1, "delay_s":2}
data: {"type":"step", "step":"analyze", "status":"running"}
data: {"type":"step", "step":"analyze", "status":"done",   "elapsed_ms":14210}

data: {"type":"step", "step":"detect",  "status":"running"}
data: {"type":"step", "step":"detect",  "status":"done",   "elapsed_ms":85}

data: {"type":"step", "step":"persist", "status":"running"}
data: {"type":"step", "step":"persist", "status":"done",   "elapsed_ms":12}

data: {"type":"step", "step":"alert",   "status":"running"}
data: {"type":"step", "step":"alert",   "status":"done",   "elapsed_ms":1}

data: {"type":"result", "ticker":"AAPL", "analysis":{...}, ...}
```

**Result event** (final)
```json
{
  "type": "result",
  "ticker": "AAPL",
  "analysis": { "trend": "Bullish", "opportunity": {"type": "long", "confidence": 72}, "..." : "..." },
  "market_data": { "..." : "..." },
  "opportunities": [...],
  "actionable": [...],
  "saved_signal_ids": [42],
  "alerts": [],
  "errors": []
}
```

`market_data` has the same shape as `GET /market-data/{ticker}`.

```bash
# Stream events to stdout:
curl -N -X POST http://localhost:8010/analyze/stream \
  -H 'Content-Type: application/json' \
  -d '{"ticker": "AAPL"}'
```

---

## Market data

### `GET /market-data/{ticker}`

Returns the full market-data snapshot: price, fundamentals, and technicals
across 1H / 4H / 1D.

```bash
curl http://localhost:8010/market-data/AAPL
```

**Response shape**
```json
{
  "ticker": "AAPL",
  "timestamp": "2026-08-09T14:30:00Z",
  "price": {
    "current": 211.45,
    "previous_close": 209.80,
    "change": 1.65,
    "change_pct": 0.79,
    "volume": 52341000,
    "avg_volume": 48200000,
    "volume_ratio": 1.09,
    "ma5": 210.2,
    "ma20": 207.8,
    "day_high": 212.30,
    "day_low": 209.50,
    "week52_high": 237.23,
    "week52_low": 164.08
  },
  "fundamentals": {
    "name": "Apple Inc.",
    "sector": "Technology",
    "industry": "Consumer Electronics",
    "market_cap": 3200000000000,
    "pe_ratio": 32.4,
    "trailing_pe": 32.4,
    "forward_pe": 28.1
  },
  "technicals": {
    "1H": { "RSI": 54.2, "MACD": {"macd": 0.12, "signal": 0.09, "histogram": 0.03},
            "EMA20": 210.8, "EMA50": 209.1, "EMA200": 198.4,
            "BollingerBands": {"upper": 214.2, "middle": 210.3, "lower": 205.8},
            "Stochastic": {"k": 62.1, "d": 58.4},
            "recommendation": "BUY" },
    "4H": { "..." : "..." },
    "1D": { "..." : "..." }
  },
  "balance_sheet": {
    "period": "2026-03-31",
    "total_assets": 364980000000,
    "total_liabilities": 308030000000,
    "stockholders_equity": 56950000000,
    "total_debt": 104590000000,
    "cash": 29650000000,
    "debt_to_equity": 1.836
  },
  "macro": {
    "fed_funds_rate": {"value": 5.0,   "date": "2026-07-01"},
    "cpi_yoy":        {"value": 3.1,   "date": "2026-07-01"},
    "unemployment":   {"value": 3.9,   "date": "2026-07-01"},
    "yield_spread":   {"value": -0.42, "date": "2026-07-15", "inverted": true},
    "shiller_cape":   {"value": 34.21, "date": "2026-07-01"}
  },
  "news": [
    {
      "headline": "Apple reports record quarter",
      "source":   "Reuters",
      "url":      "https://reuters.com/...",
      "datetime": 1722412800
    }
  ],
  "exchange": "NASDAQ",
  "errors": []
}
```

**New keys (added in backlog item 2):**

| Key | Type | Notes |
|---|---|---|
| `fundamentals.trailing_pe` | `float\|null` | Same as `pe_ratio`; canonical name going forward |
| `fundamentals.forward_pe` | `float\|null` | Forward P/E based on consensus estimates |
| `balance_sheet` | `object` | Most recent annual balance sheet; daily DB cache |
| `balance_sheet.period` | `string` | ISO date of the balance sheet period end |
| `balance_sheet.debt_to_equity` | `float\|null` | Derived: `total_debt / stockholders_equity` |
| `macro` | `object` | US macro indicators; global 6h DB cache |
| `macro.yield_spread.inverted` | `bool` | `true` when 10y-2y < 0 (recession signal) |
| `macro.shiller_cape` | `{value, date}\|null` | Shiller CAPE from multpl.com; `null` on scrape failure |
| `news` | `List[Dict]` | List of `{headline, source, url, datetime}` dicts (was `List[str]` before) |
```

---

### `GET /market-data/{ticker}/history`

Returns OHLCV + volume history from yfinance as a list of daily candles.

**Query parameters**

| Param | Default | Notes |
|---|---|---|
| `period` | `3mo` | yfinance period: `1mo` `3mo` `6mo` `1y` `2y` `5y` |
| `interval` | `1d` | yfinance interval: `1d` `1wk` |

```bash
curl 'http://localhost:8010/market-data/AAPL/history?period=1mo'
```

**Response**
```json
{
  "ticker": "AAPL",
  "period": "1mo",
  "interval": "1d",
  "candles": [
    {
      "date":   "2026-07-09",
      "open":   207.50,
      "high":   209.80,
      "low":    206.20,
      "close":  209.10,
      "volume": 48200000,
      "up":     true
    },
    ...
  ]
}
```

`up: true` means close ≥ previous day's close (used for volume bar color coding).

---

## Watchlist

### `GET /watchlist`

Returns the effective watchlist (base list + added − removed), scheduler status,
and the current alerts toggle.

```bash
curl http://localhost:8010/watchlist
```

**Response**
```json
{
  "watchlist": ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "SPY"],
  "scan_interval_minutes": 15,
  "scheduler": { "running": true, "market_open": false, "last_run": "..." },
  "alerts_enabled": true
}
```

### `POST /watchlist`

Add a ticker to the watchlist. Persisted in SQLite; survives restarts.

```bash
curl -X POST http://localhost:8010/watchlist \
  -H 'Content-Type: application/json' \
  -d '{"ticker": "GOOGL"}'
```

### `DELETE /watchlist/{ticker}`

Remove a ticker from the watchlist. Persisted in SQLite.

```bash
curl -X DELETE http://localhost:8010/watchlist/GOOGL
```

---

## Settings

### `GET /settings`

Returns all current effective settings (env file defaults overridden by any DB values set at runtime).

```bash
curl http://localhost:8010/settings
```

**Response**
```json
{
  "ollama_model": "qwen2.5:7b",
  "ollama_timeout": 180,
  "alerts_enabled": false,
  "env_model": "qwen2.5:7b",
  "env_timeout": 180,
  "scan_interval_minutes": 300,
  "scheduler_running": false
}
```

---

### `POST /settings/scheduler`

Start or stop the background auto-scan loop. **Off by default** — the scheduler does not start automatically unless explicitly enabled. State is persisted to SQLite and survives container restarts.

**Request body**
```json
{ "running": true }
```

**Response** — current scheduler status
```json
{
  "running": true,
  "market_open": false,
  "last_run": null,
  "scan_interval_minutes": 300,
  "watchlist": ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "SPY"]
}
```

```bash
# Turn on:
curl -X POST http://localhost:8010/settings/scheduler \
  -H 'Content-Type: application/json' \
  -d '{"running": true}'

# Turn off:
curl -X POST http://localhost:8010/settings/scheduler \
  -H 'Content-Type: application/json' \
  -d '{"running": false}'
```

---

### `POST /settings/scan-interval`

Change the minutes between scans while the market is open. Takes effect on the next loop cycle — no restart required.

**Request body**
```json
{ "minutes": 60 }
```

```bash
curl -X POST http://localhost:8010/settings/scan-interval \
  -H 'Content-Type: application/json' \
  -d '{"minutes": 60}'
```

---

### `POST /settings/alerts`

Enable or disable alert dispatch at runtime (no restart required).

```bash
# Disable alerts:
curl -X POST http://localhost:8010/settings/alerts \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'

# Re-enable:
curl -X POST http://localhost:8010/settings/alerts \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

---

### `POST /settings/ollama`

Override the Ollama model and/or timeout at runtime without restarting the container. Only models already pulled in Ollama can be selected.

**Request body** (all fields optional)
```json
{ "model": "qwen2.5:14b", "timeout": 240 }
```

```bash
curl -X POST http://localhost:8010/settings/ollama \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen2.5:14b", "timeout": 240}'
```

---

## Data

### `POST /data/reset`

Clear all rows from `signals` and `analysis_log`. App settings (watchlist overrides, scheduler state, scan interval, Ollama model, alerts toggle) are **preserved**.

```bash
curl -X POST http://localhost:8010/data/reset
```

**Response**
```json
{
  "cleared": ["signals", "analysis_log"],
  "signals_deleted": 42,
  "analyses_deleted": 18
}
```

---

## Signals

### `GET /signals`

Recent stored signals. Only signals at or above `CONFIDENCE_FLOOR` are stored.

**Query parameters:** `limit` (default 50, max 500), `ticker` (optional filter)

```bash
curl 'http://localhost:8010/signals?limit=20'
curl 'http://localhost:8010/signals?ticker=AAPL&limit=10'
```

**Response**
```json
{
  "count": 3,
  "signals": [
    {
      "id": 42,
      "ticker": "AAPL",
      "type": "long",
      "confidence": 78.0,
      "price": 211.45,
      "entry": 211.45,
      "stop": 208.00,
      "target": 218.50,
      "source": "ai+rsi",
      "created_at": "2026-08-09T14:32:00Z"
    }
  ]
}
```

### `GET /analysis`

Recent analysis-log entries across **all tickers**, newest first. Shown in the Explorer tab's
collapsible **Analysis History** panel; clicking a row opens the saved analysis in the Explorer.

**Query parameters:** `limit` (default 25, max 100)

```bash
curl 'http://localhost:8010/analysis?limit=10'
```

**Response**
```json
{
  "count": 3,
  "history": [
    {
      "id": 18,
      "ticker": "NVDA",
      "analysis_json": {
        "trend": "Bullish",
        "opportunity": { "type": "long", "confidence": 72.0, "entry": 134.5, "stop": 128.0, "target": 148.0 },
        "signals": [...],
        "risk_factors": [...],
        "key_levels": { "support": [128.0], "resistance": [148.0] }
      },
      "market_snapshot": { "ticker": "NVDA", "price": { "current": 134.5, ... }, ... },
      "opportunities": [
        { "type": "long", "confidence": 72.5, "source": "RSI+EMA", ... }
      ],
      "actionable": [
        { "type": "long", "confidence": 72.5, "source": "RSI+EMA", ... }
      ],
      "created_at": "2026-08-09T15:10:00Z"
    }
  ]
}
```

`opportunities` is the full list of rule-based scores (all confidence levels).
`actionable` is the subset that cleared `CONFIDENCE_FLOOR`. Both fields are `null`
for history entries recorded before this feature was added (open in Explorer → shows
"opportunity scores not stored — re-run to see").

---

### `DELETE /signals/{signal_id}`

Delete a stored signal by id. Returns `404` if the signal does not exist.

```bash
curl -X DELETE http://localhost:8010/signals/42
```

**Response**
```json
{ "deleted": true, "id": 42 }
```

---

### `DELETE /analysis/{entry_id}`

Delete an analysis-log entry by id. Returns `404` if the entry does not exist.

```bash
curl -X DELETE http://localhost:8010/analysis/18
```

**Response**
```json
{ "deleted": true, "id": 18 }
```

---

### `GET /analysis/{ticker}`

Analysis-log history for a single ticker (most recent first).

**Query parameters:** `limit` (default 20, max 200)

```bash
curl 'http://localhost:8010/analysis/AAPL?limit=5'
```

**Response**
```json
{
  "ticker": "AAPL",
  "count": 2,
  "history": [
    {
      "id": 17,
      "ticker": "AAPL",
      "analysis_json": { ... },
      "market_snapshot_json": { ... },
      "created_at": "2026-08-09T14:32:00Z"
    }
  ]
}
```

---

## Webhook

### `POST /webhook/tradingview`

Receive a TradingView Pro alert payload and trigger a background analysis.

**Request body**
```json
{ "ticker": "AAPL", "action": "buy", "price": 211.45 }
```

`ticker` or `symbol` is required; `action` and `price` are optional.

**Response** — immediate `202 Accepted`
```json
{ "status": "accepted", "ticker": "AAPL", "message": "analysis scheduled in background" }
```

Configure in TradingView → Alerts → Webhook URL:
```
http://<your-host>:8010/webhook/tradingview
```

Message body:
```json
{ "ticker": "{{ticker}}", "action": "{{strategy.order.action}}", "price": {{close}} }
```

---

## Backtesting

Full request/response documentation is in [backtesting.md](backtesting.md). Quick reference:

| Method | Path | Description |
|---|---|---|
| `POST` | `/backtest/stream` | Start a backtest; returns SSE stream (`progress`, `fallback`, `quota_stop`, `result`, `error`) |
| `GET` | `/backtest` | List all past runs |
| `GET` | `/backtest/{run_id}` | Fetch a specific run including all its trades |
| `DELETE` | `/backtest/{run_id}` | Delete a run and cascade-delete its trades |

---

## Paper Trading (Alpaca)

Requires Alpaca credentials in Settings → 📈 Paper Trading. All endpoints work even when the `paper_trading_enabled` toggle is off (you can check the account and live prices without enabling auto-placement).

### `GET /paper/account`

Live Alpaca account summary.

**Response**
```json
{
  "equity": 100234.56,
  "last_equity": 100100.00,
  "day_pnl": 134.56,
  "day_pnl_pct": 0.1344,
  "cash": 82500.00,
  "buying_power": 165000.00,
  "portfolio_value": 100234.56,
  "long_market_value": 17734.56,
  "short_market_value": 0.0,
  "daytrade_count": 0,
  "currency": "USD",
  "status": "ACTIVE"
}
```

```bash
curl http://localhost:8010/paper/account
```

---

### `GET /paper/orders`

Local DB paper orders (most recent first), joined with signal data.

**Query params:** `limit` (default 100)

```bash
curl http://localhost:8010/paper/orders
```

---

### `GET /paper/positions`

Live open positions from Alpaca.

```bash
curl http://localhost:8010/paper/positions
```

---

### `POST /paper/orders/place`

Manually place a bracket order for a given signal or opportunity. Respects the same deduplication rules as the scheduler (`signal_id` match **or** open `ticker+side` match). Returns `placed: false` with a `reason` instead of erroring when a duplicate is detected.

```bash
curl -X POST http://localhost:8010/paper/orders/place \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ticker":"NVDA","side":"buy","entry":226.05,"stop":219.26,"target":239.61}'
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `ticker` | string | ✓ | Stock symbol |
| `side` | `"buy"` \| `"sell"` | ✓ | Direction |
| `entry` | float | ✓ | Entry price — used to compute `qty = floor(notional / entry)` |
| `stop` | float | ✓ | Stop-loss price (rounded to 2 dp) |
| `target` | float | ✓ | Take-profit price (rounded to 2 dp) |
| `notional` | float | — | Position size in $ (defaults to Settings value) |
| `signal_id` | int | — | Links order to a stored signal for dedup |

**Response (success):**
```json
{"placed": true, "alpaca_order_id": "abc123", "status": "accepted"}
```

**Response (dedup blocked):**
```json
{"placed": false, "reason": "ticker_open", "detail": "An open buy order for NVDA already exists"}
```

**Errors:** `400` paper trading disabled · `502` Alpaca API error (e.g. budget too small for 1 share)

---

### `POST /paper/orders/{order_id}/cancel`

Cancel a pending order by its local DB id. Calls `DELETE /v2/orders/{alpaca_id}` on Alpaca then updates the local status.

```bash
curl -X POST http://localhost:8010/paper/orders/42/cancel
```

---

### `POST /paper/sync`

Trigger an immediate Alpaca order-status poll (fills in automatically after each scan; this is the manual trigger).

```bash
curl -X POST http://localhost:8010/paper/sync
```

---

### `GET /paper/clock`

Current Alpaca market clock.

**Response**
```json
{
  "timestamp": "2026-08-31T10:32:00-04:00",
  "is_open": true,
  "next_open": "2026-09-01T09:30:00-04:00",
  "next_close": "2026-08-31T16:00:00-04:00"
}
```

---

### `GET /paper/history`

Portfolio equity curve for charting.

**Query params:** `period` (default `1M`; valid: `1D`, `1W`, `1M`, `3M`, `6M`, `1A`), `timeframe` (default `1D`; valid: `1Min`, `5Min`, `15Min`, `1H`, `1D`)

```bash
curl "http://localhost:8010/paper/history?period=1M&timeframe=1D"
```

---

### `GET /paper/market/snapshots`

Live market data snapshots for a list of tickers (Alpaca data API). Called by the Dashboard watchlist every 30 s during market hours.

**Query params:** `symbols` — comma-separated ticker list (max 50)

**Response**
```json
{
  "market_open": true,
  "snapshots": {
    "AAPL": {
      "price": 185.42,
      "open": 184.10,
      "high": 186.00,
      "low": 183.80,
      "close": 185.42,
      "vwap": 184.95,
      "volume": 42381920,
      "prev_close": 183.00,
      "day_chg": 2.42,
      "day_chg_pct": 1.32,
      "bid": 185.40,
      "ask": 185.44,
      "last_trade_at": "2026-08-31T14:32:00Z"
    }
  }
}
```

```bash
curl "http://localhost:8010/paper/market/snapshots?symbols=AAPL,MSFT,NVDA"
```

---

### `POST /settings/alpaca`

Save Alpaca credentials and paper trading settings.

**Request body**
```json
{
  "paper_url": "https://paper-api.alpaca.markets",
  "key_id": "PKxxxxxxx",
  "secret_key": "xxxxxxx",
  "use_env": false,
  "paper_trading_enabled": true,
  "position_size": 500.0,
  "min_confidence": 70.0
}
```

Pass `"use_env": true` to clear DB credentials and revert to `.env` values.

---

### `POST /settings/alpaca/test`

Test credentials without saving them. Returns account data on success or an error message on failure.

**Request body**
```json
{
  "key_id": "PKxxxxxxx",
  "secret_key": "xxxxxxx",
  "paper_url": "https://paper-api.alpaca.markets"
}
```

---

## Discovery

See [trending-discovery.md](trending-discovery) for full context. Quick reference:

| Method | Path | Description |
|---|---|---|
| `GET` | `/discovery/trending` | Latest completed run with ranked candidates |
| `POST` | `/discovery/refresh` | Run a fresh discovery cycle (SSE stream) |
| `GET` | `/discovery/history` | Recent run summaries (no candidates) |
| `GET` | `/discovery/history/{run_id}/candidates` | All scored candidates for a specific run |
| `GET` | `/settings/discovery` | Read discovery configuration |
| `POST` | `/settings/discovery` | Update discovery configuration |

### `GET /discovery/trending`

Query params: `limit` (1–100, default 25)

```json
{
  "run": { "id": 3, "created_at": "2026-09-08T14:00:00Z", "sources": "alpaca,yfinance", "candidate_count": 18, "status": "done" },
  "candidates": [
    {
      "ticker": "NVDA", "price": 131.2, "percent_change": 4.5, "volume": 45000000,
      "source": "alpaca_actives", "score": 87.5,
      "reasons": ["Strong move +4.5% today (up)", "Price above EMA20 (uptrend)"],
      "components": { "momentum": 13.5, "volume": 25.0, "trend": 25.0, "rsi_macd": 14.0 },
      "already_in_watchlist": false
    }
  ],
  "watchlist": ["AAPL", "MSFT"]
}
```

### `POST /discovery/refresh`

Streams a Server-Sent Events response. Each event is a JSON object on a `data:` line:

| `type` | `step` values | Meaning |
|---|---|---|
| `step` | `fetch` | Candidate fetch progress (Alpaca / yfinance count) |
| `step` | `warn` | Non-fatal warning (e.g. Alpaca 403, key not configured) |
| `step` | `score` | Per-ticker scoring progress — `[N/total] TICKER → score pts` |
| `step` | `done` | Run complete |
| `result` | — | Final payload with `run_id`, `candidate_count`, full `candidates` array |
| `error` | — | Unrecoverable error; `message` field has detail |

```bash
curl -N -X POST http://localhost:8010/discovery/refresh \
  -H "Content-Type: application/json" \
  -d '{"sources":"alpaca,yfinance","max_candidates":25,"min_score":60}'
```

Request body fields (all optional — fall back to DB settings):

| Field | Default | Description |
|---|---|---|
| `sources` | `"alpaca,yfinance"` | Comma-separated source list |
| `max_candidates` | `25` | Candidates to score |
| `min_score` | `60` | Minimum score to include in result |

### `GET /discovery/history`

Query params: `limit` (1–100, default 20). Returns run summaries without candidates.

```json
{ "runs": [{ "id": 3, "created_at": "...", "sources": "alpaca,yfinance", "candidate_count": 18, "status": "done", "error": null }] }
```

### `GET /discovery/history/{run_id}/candidates`

Returns all scored candidates for one run, ordered by score descending.

```json
{ "run_id": 3, "candidates": [{ "ticker": "NVDA", "score": 87.5, "source": "alpaca_actives", "price": 131.2, ... }] }
```

