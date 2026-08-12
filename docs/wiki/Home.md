# MarketSage — Wiki Home

**Local, zero-cost AI stock monitor.**
FastAPI · Ollama (`qwen2.5:14b`) · React · SQLite.

Everything runs on your machine — no paid APIs, no cloud AI, no subscription.

> ⚠️ **Not financial advice.** For educational and research use only.

---

## What does it do?

For each ticker in your watchlist (or on demand) the system runs a five-step pipeline:

```
yfinance          → live price, volume, fundamentals
yfinance + ta     → OHLCV history → RSI / MACD / EMA / BB / Stoch (1H · 4H · 1D)
Prompt builder    → assembles the market dict into a structured prompt
Local Ollama      → qwen2.5:14b reasons about the data → JSON output
Rule engine       → 4 deterministic checks → scored, confidence-filtered signals
SQLite            → signals + analysis log persisted locally
Alerts            → optional Gmail SMTP · Telegram bot
```

Results are visible in the React UI (Dashboard · Explorer · Learn) and via the REST API.

---

## Quick navigation

| Page | What's in it |
|---|---|
| [Home](Home.md) | This page |
| [Architecture](architecture.md) | Pipeline diagram, Docker service map, SSE streaming design, data persistence |
| [API Reference](api.md) | All endpoints with full request/response shapes and `curl` examples |
| [Indicators](indicators.md) | RSI, MACD, EMA, Bollinger Bands, Stochastic, Volume ratio — definitions, scales, what the system checks |
| [Glossary](glossary.md) | Alphabetical trading terminology (bullish/bearish, support/resistance, R-multiple, etc.) |

---

## Service URLs (when the stack is running)

| URL | Service |
|---|---|
| http://localhost:5174 | React UI — Dashboard · Analysis Explorer · Learn |
| http://localhost:8010/docs | FastAPI interactive docs (OpenAPI) |
| http://localhost:18889 | Aspire — structured logs, traces, metrics |
| http://localhost:9000 | Portainer — container management |

---

## Key files

```
backend/
├── config.py         — env-driven settings, thresholds, secrets
├── data.py           — yfinance OHLCV + ta library → indicators + market dict
├── analysis.py       — prompt → Ollama /api/chat → parsed JSON
├── opportunities.py  — AI output + 4 rule checks → scored signals
├── database.py       — SQLite: signals, analysis_log, app_settings
├── alerts.py         — Gmail SMTP · Telegram bot (confidence-gated)
├── scheduler.py      — async, market-hours-aware scan loop
└── main.py           — FastAPI: endpoints, SSE streaming, lifespan

frontend/src/
├── App.jsx           — all UI components + custom hooks
└── index.css         — component styles

docker/
├── frontend/nginx.conf  — nginx reverse proxy (SSE buffering off)
└── ...

docs/wiki/            — you are here
```

---

## Getting started

- **First time:** [SETUP.md](../../SETUP.md)
- **Day-to-day commands:** [USAGE.md](../../USAGE.md)
- **Opportunity-detection rules and thresholds:** [Architecture](architecture.md)
- **What RSI/MACD/EMA mean:** [Indicators](indicators.md)
- **Unfamiliar trading terms:** [Glossary](glossary.md)
