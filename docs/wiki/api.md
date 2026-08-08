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
Each event is a `data: <json>\n\n` line. Three step events are emitted in
sequence, then a single result event.

**Request body** — same as `/analyze`

**Step events** (three, one per pipeline stage)
```json
{"type": "step", "step": "fetch",   "status": "running", "msg": "Fetching market data for AAPL…"}
{"type": "step", "step": "fetch",   "status": "done",    "elapsed": 2.8}
{"type": "step", "step": "analyze", "status": "running", "msg": "Running AI analysis (qwen2.5:14b)…"}
{"type": "step", "step": "analyze", "status": "done",    "elapsed": 14.2}
{"type": "step", "step": "detect",  "status": "running", "msg": "Detecting opportunities…"}
{"type": "step", "step": "detect",  "status": "done",    "elapsed": 0.1}
```

`status` values: `running` | `done` | `error`  
On error: `{"type":"step","step":"...","status":"error","msg":"<error message>"}`

**Result event** (final, after persist)
```json
{
  "type": "result",
  "ticker": "AAPL",
  "analysis": { ... },
  "market_data": { ... },
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
    "pe_ratio": 32.4
  },
  "technicals": {
    "1H": { "rsi": 54.2, "macd": 0.12, "macd_signal": 0.09, "macd_hist": 0.03,
            "ema20": 210.8, "ema50": 209.1, "ema200": 198.4,
            "bb_upper": 214.2, "bb_lower": 205.8, "stoch_k": 62.1, "stoch_d": 58.4,
            "recommendation": "BUY" },
    "4H": { ... },
    "1D": { ... }
  },
  "exchange": "NASDAQ",
  "errors": []
}
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

Recent analysis-log entries across **all tickers**, newest first. Shown in the Dashboard's
**Analysis History** panel; clicking a row opens the saved analysis in the Explorer tab.

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
      "analysis_json": { "trend": "bullish", "confidence": 82, ... },
      "market_snapshot": { "price": 134.5, ... },
      "created_at": "2026-08-09T15:10:00Z"
    }
  ]
}
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
