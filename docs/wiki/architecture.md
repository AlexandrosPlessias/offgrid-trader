# Architecture

System design for **MarketSage** — a local, zero-cost AI stock monitor.

---

## Pipeline

Every analysis (scheduled or ad-hoc) flows through the same steps:

```mermaid
flowchart LR
    A[Ticker symbol] --> B[yfinance\nprice · volume · fundamentals]
    A --> C[yfinance OHLCV\n1H · 4H · 1D]
    C --> D[ta library\nRSI · MACD · EMA\nBB · Stoch]
    B & D --> E[Prompt builder\nassembles market dict]
    E --> F[Local Ollama\nqwen2.5:14b]
    F --> G[AI JSON\ntrend · signals · confidence\nentry · stop · target]
    D & G --> H[Rule-based detection\n4 checks]
    H --> I[Confidence scoring\nmerge + filter]
    I --> J[SQLite\nanalysis_log · signals]
    I --> K[Alert dispatch\nemail · Telegram]
```

### Steps in detail

| Step | Module | What happens |
|---|---|---|
| 1. Fetch | `backend/data.py` — `fetch_yfinance()` | OHLCV, fundamentals, 20-day averages from yfinance |
| 2. Indicators | `backend/data.py` — `compute_indicators()` | Downloads OHLCV (1y@1h, 2y@1d), resamples to 4H, computes RSI/MACD/EMA/BB/Stoch locally via the `ta` library |
| 3. Prompt | `backend/analysis.py` — `build_prompt()` | All indicator data (+ optional Finnhub headlines) assembled into a structured text prompt |
| 4. AI | `backend/analysis.py` — `call_ollama()` | Prompt sent to local Ollama over `/api/chat`; response parsed from JSON |
| 5. Detect | `backend/opportunities.py` — `detect_opportunities()` | 4 rule-based checks run on market data + AI output; candidates merged and scored |
| 6. Persist | `backend/database.py` | `save_analysis()` stores the full analysis log; `save_signal()` stores each actionable signal |
| 7. Alert | `backend/alerts.py` | Confidence-gated dispatch to email (Gmail SMTP), Slack webhook, Telegram bot |

---

## Opportunity detection rules

Four independent checks — any combination can fire:

| Rule | Condition | Signal direction |
|---|---|---|
| **AI signal** | Model returns `long`/`short` with confidence ≥ floor | As returned |
| **RSI extreme** | RSI < 30 or > 70 on 2+ of 1H / 4H / 1D | oversold → long · overbought → short |
| **MACD crossover** | MACD above/below signal on both 1D and 4H | above → long · below → short |
| **Volume spike** | Volume ≥ `VOLUME_SPIKE_MULTIPLIER`× avg AND day move ≥ `SIGNIFICANT_MOVE_PCT` | direction from price move |

Multiple matching rules for the same ticker are merged: the type is determined by
majority vote and the confidence score is boosted by each additional agreement.
Only signals at or above `CONFIDENCE_FLOOR` (default: 65) are stored and alerted.

---

## SSE streaming

The `POST /analyze/stream` endpoint exposes the same pipeline as an async SSE stream.

```
Client                                  Backend
  |                                        |
  |-- POST /analyze/stream --------------->|
  |                                        |-- fetch_yfinance()
  |<-- data: {step:fetch, status:running} -|
  |                                        |   (completes)
  |<-- data: {step:fetch, status:done}  ---|
  |                                        |-- call_ollama()
  |<-- data: {step:analyze,status:running}-|
  |                                        |   (completes ~14s)
  |<-- data: {step:analyze, status:done} --|
  |                                        |-- detect_opportunities()
  |<-- data: {step:detect, status:running}-|
  |<-- data: {step:detect, status:done}  --|
  |                                        |-- save_analysis() + save_signal()
  |<-- data: {type:result, ...full payload}|
```

nginx must have `proxy_buffering off` on the `/api/` location block — without this,
nginx buffers the response and the client sees nothing until the stream ends.

---

## Docker services

```
┌─────────────────── ai-shared network ──────────────────────┐
│                                                             │
│  ┌──────────────────────┐   ┌──────────────────────────┐  │
│  │  ollama              │   │  portainer               │  │
│  │  :11434 (internal)   │   │  :9000 → host:9000       │  │
│  └──────────────────────┘   └──────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────── offgrid-net (internal) ─────────────────────────┐
│                                                                  │
│  ┌────────────────┐      ┌────────────────┐                    │
│  │  backend       │      │  frontend      │                    │
│  │  FastAPI :8000 │      │  nginx :5173   │                    │
│  │  → host:8010   │      │  → host:5174   │                    │
│  └────────┬───────┘      └────────┬───────┘                    │
│           │                       │                             │
│  ┌────────┴───────┐      proxies /api/* → backend:8000         │
│  │  aspire-offgrid│      proxies /docs   → backend:8000        │
│  │  :18889        │                                             │
│  │  → host:18889  │                                             │
│  └────────────────┘                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Both networks connect to `ollama` — the backend talks to it at `http://ollama:11434`.

### Shared infrastructure (`docker-compose.infra.yml`)

| Service | Purpose | Port |
|---|---|---|
| `ollama` | Local LLM server | 11434 (internal) |
| `portainer` | Container management UI | 9000 |
| `ollama-pull` | One-shot model download on first run | — |

### App stack (`docker-compose.yml`)

| Service | Purpose | Port |
|---|---|---|
| `backend` | FastAPI API server | 8010 (→ internal 8000) |
| `frontend` | nginx serving built Vite/React app | 5174 (→ internal 5173) |
| `aspire-offgrid` | OpenTelemetry collector + Aspire dashboard | 18889 |

---

## Data persistence

| What | Path | Notes |
|---|---|---|
| Signals + analysis log | `./data/offgrid_trader.db` | SQLite; bind-mounted; survives `docker compose down` |
| App settings (watchlist overrides, alerts toggle) | same DB, `app_settings` table | Key-value store; runtime-mutable without restart |
| Ollama model weights | `ollama_models` Docker volume | Shared with other AI projects; never re-downloaded |
| Portainer config | `portainer_data` Docker volume | Shared |

---

## Configuration

All configuration is via `.env` (copied from `.env.example`). Key variables:

| Variable | Default | Notes |
|---|---|---|
| `WATCHLIST` | `AAPL,MSFT,NVDA,TSLA,AMD,SPY` | Comma-separated tickers; overridable at runtime via UI |
| `SCAN_INTERVAL_MINUTES` | `15` | Minutes between scans while market is open |
| `CONFIDENCE_FLOOR` | `65` | Minimum 0–100 score to be actionable |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model tag; `qwen2.5:14b` recommended on 16+ GB RAM |
| `ALERTS_SEND_ENABLED` | `false` | Can also be toggled at runtime from the UI |
| `FINNHUB_API_KEY` | *(unset)* | Optional — enables recent news headlines in AI prompts |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (auto in Docker) | Set to `http://aspire-offgrid:18889` in Compose |

See `.env.example` for the full list including SMTP, Slack, and Telegram credentials.
