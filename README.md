# MarketSage

**Local, zero-cost AI stock monitor.** FastAPI + Ollama (`qwen2.5:14b`) + SQLite.
Fetches live market data, runs a **local** LLM for technical analysis, detects
trading opportunities with transparent rules, stores signals, and sends alerts
via Gmail SMTP and/or Slack.

Everything runs on your machine. **No paid or cloud APIs are used** — the AI is
a local Ollama model.

> ⚠️ **Not financial advice.** This project is for educational and research
> purposes only. It does not constitute financial, investment, or trading
> advice. Markets are risky; you are solely responsible for any decisions you
> make. Nothing here is a recommendation to buy or sell any security.

---

## Architecture

```
backend/
├── config.py         # settings + thresholds + secrets from env (.env)
├── data.py           # yfinance OHLCV + ta library -> indicators + market dict
├── analysis.py       # prompt -> local Ollama /api/chat -> parsed JSON
├── opportunities.py  # AI output + rule-based checks -> scored signals
├── database.py       # SQLite: signals + analysis_log + app_settings
├── alerts.py         # Gmail SMTP + Slack webhook (confidence-gated)
├── scheduler.py      # async, market-hours-aware scan loop
└── main.py           # FastAPI app (endpoints + CORS + lifespan + SSE streaming)
```

Pipeline per ticker: **fetch data → AI analysis → detect opportunities → save → alert**.
The **Analysis Explorer** UI page shows this pipeline live via Server-Sent Events, with
per-step timing and charts for every indicator.

See [docs/wiki/architecture.md](docs/wiki/architecture.md) for a full pipeline diagram and service map.

---

## Run with Docker (recommended, WSL2)

The whole stack — FastAPI backend, local Ollama (`qwen2.5:14b`), and Portainer —
runs in Docker. No Python venv or native Ollama required.

```bash
cp .env.example .env          # edit watchlist / thresholds / optional alerts

# WSL2 — start Docker first (not auto-started):
sudo service docker start

# macOS — open Docker Desktop first:
open -a Docker

./start-infra.sh              # start shared Ollama + Portainer
docker compose up --build     # build and start MarketSage
```

**When you are done — stop everything to free RAM/GPU:**

```bash
docker compose down
docker compose -f docker-compose.infra.yml down
sudo service docker stop      # WSL2 only
```

Then open the services:

| URL | What |
|---|---|
| http://localhost:5174 | React UI — Dashboard · Analysis Explorer · Learn |
| http://localhost:5174/docs | FastAPI interactive docs (via nginx proxy) |
| http://localhost:8010/docs | FastAPI interactive docs (direct) |
| http://localhost:18889 | Aspire — traces, metrics, structured logs |
| http://localhost:9000 | Portainer — container management |

- **First-time setup (WSL2, GPU, model download):** see **[SETUP.md](SETUP.md)**.
- **Day-to-day operation (subsequent runs, commands, endpoints):** see **[USAGE.md](USAGE.md)**.

The sections below describe running the backend **natively** (without Docker).

---

## Prerequisites

- **Python 3.11+** (uses `zoneinfo` from the stdlib)
- **[Ollama](https://ollama.com/)** running locally

### 1. Install and start Ollama

```bash
# Install Ollama (see https://ollama.com/download for your OS)
# Then pull the local model used by this project:
ollama pull qwen2.5:14b

# Make sure the server is running (usually automatic):
ollama serve
```

Ollama listens on `http://localhost:11434` by default, which matches
`OLLAMA_HOST` in `.env.example`.

### 2. Create a virtual environment & install deps

```bash
# Windows (PowerShell)
py -m venv .venv
.\.venv\Scripts\Activate.ps1

# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Configure environment

```bash
cp .env.example .env      # (Windows: copy .env.example .env)
# edit .env: watchlist, thresholds, and optional email/Slack credentials
```

All secrets (SMTP App Password, Slack webhook) live in `.env`, which is
gitignored. Email and Slack are **disabled by default** — set `EMAIL_ENABLED`
/ `SLACK_ENABLED` to `true` and fill in credentials to turn them on.

---

## Run the API

```bash
uvicorn backend.main:app --reload
```

Then open the interactive docs at http://localhost:8000/docs (native uvicorn default port).

The background scheduler starts automatically and scans the watchlist every
`SCAN_INTERVAL_MINUTES` **while the US market is open** (Mon–Fri, 9:30–16:00 ET).

### Endpoints

| Method | Path                          | Description                                        |
|--------|-------------------------------|----------------------------------------------------|
| POST   | `/analyze`                    | On-demand analysis for any ticker.                 |
| POST   | `/analyze/stream`             | Same pipeline, streamed via SSE (step events + result). |
| GET    | `/market-data/{ticker}`       | Raw market-data dict (price, fundamentals, indicators). |
| GET    | `/market-data/{ticker}/history` | OHLCV + volume history (`?period=3mo&interval=1d`). |
| POST   | `/webhook/tradingview`        | Receive a TradingView Pro alert → background scan. |
| GET    | `/signals`                    | Recent stored signals (`?ticker=&limit=`).         |
| DELETE | `/signals/{id}`               | Delete a stored signal by id.                      |
| GET    | `/analysis`                   | Recent analysis-log entries across all tickers (`?limit=`). |
| DELETE | `/analysis/{id}`              | Delete an analysis-log entry by id.                |
| GET    | `/analysis/{ticker}`          | Analysis-log history for a single ticker.          |
| GET    | `/watchlist`                  | Effective watchlist + scheduler + alerts status.   |
| POST   | `/watchlist`                  | Add a ticker (`{"ticker": "GOOGL"}`).              |
| DELETE | `/watchlist/{ticker}`         | Remove a ticker (persisted in SQLite).             |
| POST   | `/settings/alerts`            | Toggle alert dispatch (`{"enabled": true/false}`). |
| GET    | `/health`                     | Liveness + config summary.                         |

Full API reference with request/response shapes and `curl` examples: [docs/wiki/api.md](docs/wiki/api.md).

Example (Docker — use port 8010):

```bash
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "AAPL"}'
```

Example (native uvicorn — port 8000):

```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "AAPL"}'
```

TradingView webhook payload (configure in a TradingView Pro alert):

```json
{ "ticker": "{{ticker}}", "action": "buy", "price": {{close}} }
```

---

## Run modules independently

Each module is runnable for quick manual testing:

```bash
python -m backend.config           # print resolved config (secrets masked)
python -m backend.data AAPL        # fetch unified market data
python -m backend.analysis AAPL    # data -> Ollama -> parsed analysis
python -m backend.opportunities AAPL   # full detection for one ticker
python -m backend.database         # create the DB and print row counts
python -m backend.alerts           # send a demo alert (if channels enabled)
python -m backend.scheduler        # one-shot watchlist scan (no alerts)
```

---

## Opportunity rules

An opportunity is raised when any of the following hold (and merged/scored when
several agree):

- **AI-detected** — the model returns a `long`/`short` setup with confidence ≥
  `CONFIDENCE_FLOOR`.
- **RSI extreme** — RSI oversold/overbought on **2+** of 1H/4H/1D.
- **Volume spike** — volume ≥ `VOLUME_SPIKE_MULTIPLIER`× average **and** the
  day's move ≥ `SIGNIFICANT_MOVE_PCT`.
- **MACD crossover** — MACD above/below its signal on **both** 1D and 4H.

Only signals at or above the confidence floor are stored and alerted.

---

## Data & tooling

- **Market data & indicators:** [yfinance](https://github.com/ranaroussi/yfinance)
  (price, fundamentals, OHLCV) + [ta](https://github.com/bukosabino/ta)
  (RSI, MACD, EMA20/50/200, Bollinger Bands, Stochastic — computed locally, no API key)
- **AI:** local [Ollama](https://ollama.com/) `qwen2.5:14b` via `/api/chat`
- **DB:** SQLite (file at `DATABASE_PATH`)
- **Charts:** [Recharts](https://recharts.org/) (RSI/MACD/EMA/price-history in the frontend)

See [docs/wiki/indicators.md](docs/wiki/indicators.md) for a full indicator reference and [docs/wiki/glossary.md](docs/wiki/glossary.md) for trading terminology.

---

## Disclaimer

This software is provided "as is", without warranty of any kind. It is **not
financial advice** and must not be relied upon for real trading decisions.
