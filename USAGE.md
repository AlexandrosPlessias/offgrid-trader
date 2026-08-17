# Usage Guide

Day-to-day operation of **MarketSage**. First-time install is in
[SETUP.md](SETUP.md).

> ⚠️ **Not financial advice.** For educational/research use only.

---

## 1. Quick start

**First time?** Use the bootstrap script — it handles everything:

```bash
bash scripts/setup_wsl.sh     # WSL2 / Ubuntu
bash scripts/setup_macos.sh   # macOS
```

**Subsequent runs** (model already downloaded, image already built):

```bash
# ── Step 1: start Docker ────────────────────────────────────────────────────
# Docker is not auto-started. Run once per session before anything else.
#
# WSL2:
sudo service docker start
#
# macOS:
open -a Docker          # wait for the menu-bar icon to stop animating (~10 s)

# ── Step 2: start shared infra + MarketSage ─────────────────────────────────
# macOS only: ensure native Ollama is running first (Metal GPU)
ollama serve &          # skip if already running

./start-infra.sh        # start shared Ollama proxy + Portainer (idempotent)
docker compose up -d    # start MarketSage in the background
```

**When you are done — free up resources:**

```bash
# Stop MarketSage only (Ollama and Portainer keep running):
docker compose down

# Stop everything (MarketSage + Ollama + Portainer):
docker compose down
docker compose -f docker-compose.infra.yml down

# WSL2 — stop Docker entirely (frees RAM until next session):
sudo service docker stop

# macOS — quit Docker Desktop from the menu-bar icon (or):
osascript -e 'quit app "Docker Desktop"'
```

**Other common commands:**

```bash
docker compose up          # start in foreground — see live logs (Ctrl+C stops)
docker compose up -d       # start detached — runs in background, prompt returns
docker compose up --build  # rebuild images after a code change, then start
docker compose down        # stop MarketSage (Ollama/Portainer keep running)
```

Subsequent runs skip the ~9 GB model download because the weights persist in
the `ollama_models` named volume, so the stack is ready in under a minute.

---

## 2. Service URLs

| URL | Service | Purpose |
|---|---|---|
| http://localhost:5174 | React UI | Dashboard · Analysis Explorer · Learn (glossary + education) |
| http://localhost:8010/docs | Backend API | OpenAPI docs — try all endpoints interactively |
| http://localhost:8010/health | Backend API | Liveness + scheduler status |
| http://localhost:18889 | Aspire | Traces, metrics, structured logs (MarketSage only) |
| http://localhost:9000 | Portainer | Container management UI — logs, stats, console |

The `ollama` container is internal-only (not published to the host); the backend
reaches it at `http://ollama:11434` on the `ai-shared` network.

---

## 3. Day-to-day commands

### Stopping the stack

```bash
# Stop MarketSage only (Ollama and Portainer keep running):
docker compose down

# Stop the shared infra (Ollama + Portainer + ai-shared network):
docker compose -f docker-compose.infra.yml down

# Stop everything on the machine at once:
docker stop $(docker ps -q)
```

> `docker compose down` removes the MarketSage containers but **not** the
> `ollama_models` volume — model weights are preserved.

### Restarting

```bash
# Start shared infra first, then the app:
./start-infra.sh
docker compose up -d
```

### Other useful commands

```bash
# Stream logs for all services:
docker compose logs -f

# Stream logs for one service:
docker compose logs -f backend
docker compose logs -f ollama

# Apply an .env change (recreates the container so new env is read):
docker compose up -d backend

# Restart the backend process without re-reading .env (e.g. to clear state):
docker compose restart backend

# Rebuild and restart the backend (after a code change):
docker compose up --build backend

# Check container health / status:
docker compose ps
```

> ⚠️ **`.env` changes need `docker compose up -d backend`, not `restart`.**
> Values from `env_file` are injected only when the container is **created**.
> `docker compose restart` reuses the existing container, so it keeps the old
> environment — your edit won't take effect until you recreate it with
> `docker compose up -d backend`.

---

## 4. API endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/analyze` | On-demand analysis for any ticker |
| POST | `/analyze/stream` | Same pipeline, streamed via SSE (step events + final result) |
| GET | `/market-data/{ticker}` | Raw market-data dict (price, fundamentals, balance sheet, macro, indicators, news) |
| GET | `/market-data/{ticker}/history` | OHLCV + volume history (`?period=3mo&interval=1d`) |
| POST | `/webhook/tradingview` | Receive a TradingView Pro alert → background scan |
| GET | `/signals` | Recent stored signals (`?ticker=&limit=`) |
| DELETE | `/signals/{id}` | Delete a stored signal by id |
| GET | `/analysis` | Recent analysis-log entries across all tickers (`?limit=`) |
| DELETE | `/analysis/{id}` | Delete an analysis-log entry by id |
| GET | `/analysis/{ticker}` | Analysis-log history for a single ticker |
| GET | `/watchlist` | Watchlist + scheduler status + alerts toggle |
| POST | `/watchlist` | Add ticker (`{"ticker": "GOOGL"}`) — persisted in SQLite |
| DELETE | `/watchlist/{ticker}` | Remove ticker — persisted in SQLite |
| GET | `/settings` | Current effective settings (env + DB overrides) |
| POST | `/settings/alerts` | Toggle alert dispatch (`{"enabled": true/false}`) |
| POST | `/settings/scheduler` | Start/stop auto-scan (`{"running": true/false}`); state persists across restarts |
| POST | `/settings/scan-interval` | Change scan cadence (`{"minutes": 60}`) |
| POST | `/settings/ollama` | Override Ollama model and/or timeout at runtime |
| POST | `/data/reset` | Clear all signals and analysis history (app settings preserved) |
| GET | `/health` | Liveness + config summary |

Full reference with request/response shapes: [docs/wiki/api.md](docs/wiki/api.md).

### UI pages

The React UI has four tabs (Dashboard, Explorer, Learn) plus a Settings panel (⚙ gear icon in the header):

- **Dashboard** — watchlist management and recent signals table (collapsible filters: side, confidence, ticker; per-row delete)
- **Explorer** — ad-hoc analysis as a full-page walkthrough: live pipeline stepper, price snapshot, 3-month history chart, RSI/MACD/EMA charts, AI reasoning, raw indicator table, and a collapsible **Analysis History** panel (re-open any saved run; per-row delete)
- **Learn** — in-app wiki: pipeline overview, technical indicators, fundamentals/macro/balance-sheet context, opportunity detection rules, trading glossary, and further reading links. All sections are collapsible; click a title in the sidebar to expand it.
- **Settings** (⚙) — Scheduler toggle + scan interval, alerts toggle, Ollama model/timeout override, and a data-reset button (clears signals + analysis history; preserves settings)

### Examples

```bash
# Analyse a single ticker on demand:
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "NVDA"}'

# Analyse and also fire alerts for actionable signals:
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "NVDA", "send_alerts": true}'

# Recent signals (all tickers):
curl "http://localhost:8010/signals?limit=20"

# Recent signals for one ticker:
curl "http://localhost:8010/signals?ticker=AAPL&limit=10"

# Analysis history for a ticker:
curl http://localhost:8010/analysis/AAPL

# Watchlist + scheduler status:
curl http://localhost:8010/watchlist
```

### TradingView webhook

Point a TradingView Pro alert at `http://<your-host>:8010/webhook/tradingview`
with a JSON message body:

```json
{ "ticker": "{{ticker}}", "action": "buy", "price": {{close}} }
```

The backend accepts the payload and runs the analysis in the background.

---

## 5. The scheduler

The backend runs an async, **market-hours-aware** loop (Mon–Fri, 9:30–16:00 ET).
While the market is open it scans every ticker in `WATCHLIST` every
`SCAN_INTERVAL_MINUTES`: fetch data → AI analysis → detect opportunities → save
→ alert. Outside market hours it sleeps.

**Auto-scan is off by default.** Enable it from the Settings page (⚙ gear in the header) or via the API:

```bash
# Turn on auto-scan:
curl -X POST http://localhost:8010/settings/scheduler \
  -H "Content-Type: application/json" \
  -d '{"running": true}'

# Turn off auto-scan:
curl -X POST http://localhost:8010/settings/scheduler \
  -H "Content-Type: application/json" \
  -d '{"running": false}'
```

The on/off state is **persisted to SQLite** and survives container restarts — you don't need to touch `.env`.

```bash
# See what the scheduler is doing:
docker compose logs -f backend | grep scheduler

# Confirm state (running / market_open / last_run):
curl http://localhost:8010/watchlist
```

To change the watchlist, edit `WATCHLIST` in `.env` and run `docker compose up -d backend`.
To change the scan interval without restarting, use the Settings page or:

```bash
curl -X POST http://localhost:8010/settings/scan-interval \
  -H "Content-Type: application/json" \
  -d '{"minutes": 60}'
```

---

## 6. Container management (Portainer)

Open **http://localhost:9000**. On first visit Portainer asks you to set an
admin password.

From the Portainer UI you can:
- View live logs for any container (Containers → select → Logs)
- Inspect CPU / memory stats per container (Containers → select → Stats)
- Open a shell inside a container (Containers → select → Console)
- Start / stop / restart containers without the CLI

---

## 7. Data & persistence

| What | Where | Notes |
|---|---|---|
| Signals + analysis log | `./data/offgrid_trader.db` (SQLite) | Bind-mounted into the backend; survives `docker compose down` |
| Ollama model weights | `ollama_models` named volume (shared) | Pulled once; survives restarts; shared with other AI projects |
| Portainer config | `portainer_data` named volume (shared) | |

Inspect the database directly:

```bash
# Row counts:
docker compose exec backend python -m backend.database

# Query signals with sqlite3 from the host (repo root):
sqlite3 data/offgrid_trader.db "SELECT ticker, type, confidence, source, timestamp FROM signals ORDER BY id DESC LIMIT 10;"
```

---

## 8. Running modules manually

Each module is runnable inside the backend container for quick checks:

```bash
docker compose exec backend python -m backend.config          # resolved config (secrets masked)
docker compose exec backend python -m backend.data AAPL       # unified market data
docker compose exec backend python -m backend.analysis AAPL   # data -> Ollama -> parsed analysis
docker compose exec backend python -m backend.opportunities AAPL  # full detection for one ticker
docker compose exec backend python -m backend.scheduler       # one-shot watchlist scan (no alerts)
```

Verify Ollama has the model (Ollama is in the shared infra stack):

```bash
docker exec ollama ollama list
```

---

## 9. Smoke test

Run the offline smoke test to verify all backend logic is wired correctly
(no live Ollama, yfinance, or SMTP calls — everything is mocked):

```bash
docker compose exec backend python tests/smoke_test.py
```

Expected output ends with:

```
==================================================
SMOKE TEST PASSED — all checks green
```

Run after every significant change to catch regressions before they hit the
scheduler. To run locally without Docker:

```bash
pip install -r requirements/dev.txt
python tests/smoke_test.py
```

---

## 10. Resetting state

### Clear signals and analysis history (keep settings)

From the **Settings page** (⚙ gear in the header), use the **Clear all data** button. Or via API:

```bash
curl -X POST http://localhost:8010/data/reset
```

This removes all rows from `signals` and `analysis_log`. Watchlist overrides, scheduler state, scan interval, and Ollama model settings are preserved.

### Wipe the entire database

```bash
docker compose down
rm -f data/offgrid_trader.db
docker compose up -d
```

The backend recreates the schema on the next start. Use this only when you also want to wipe app settings (watchlist, scheduler state, etc.).

### Re-pull / reset the model weights

Only if you want a completely clean slate (re-downloads ~9 GB). The volume is
shared — this also affects other projects using the same Ollama instance:

```bash
docker compose -f docker-compose.infra.yml down
docker volume rm ollama_models
./start-infra.sh
```

---

## 11. Logs and telemetry

The backend logs to stdout. Follow them with:

```bash
docker compose logs -f backend
```

Structured log lines are emitted for every stage of the pipeline:

| Logger | What it logs |
|---|---|
| `backend.data` | `yfinance ▶/◀` fetch (price, change%, vol ratio) and `indicators ▶/◀` per timeframe (RSI, MACD, EMA, recommendation) |
| `backend.analysis` | `ollama ▶/◀` prompt text, response text, and latency |
| `backend.scheduler` | Scan loop events (start, market open/closed, scan results) |

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set (set automatically in Docker), all log lines are
forwarded to **Aspire** at http://localhost:18889. Filter by logger name to trace the full
data-fetch pipeline for any ticker.

To reduce Ollama request timeouts on slow CPU inference, raise `OLLAMA_TIMEOUT`
in `.env`, then `docker compose up -d backend` (recreates the container so the
new value is applied).

---

## 12. Re-capturing documentation screenshots

The `docs/screenshots/` directory contains 15 viewport screenshots (1440 × 900 px)
captured by a [Playwright](https://playwright.dev) script. Re-run any time the UI
changes:

### One-time setup (per machine)

```bash
cd docs/screenshots
npm install                      # installs playwright npm wrapper (~2 packages)
npx playwright install chromium  # downloads headless Chromium browser (~200 MB)
```

### Capture

```bash
# Requirements: full stack running + at least one saved analysis

# Create a saved analysis if you don't have one yet:
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "AAPL"}'

# Run the capture script:
node docs/screenshots/capture.mjs
```

All 15 PNGs are written to `docs/screenshots/`, existing files are overwritten.
The script prints `✓ <filename>` for each successful shot.

See [docs/screenshots/README.md](docs/screenshots/README.md) for the full file
inventory, script internals, and troubleshooting.

---

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| `backend` unhealthy / restarting | `docker compose logs backend`. Most often it's still waiting on `ollama-pull` to finish the model download |
| `/analyze` returns an Ollama error | Model not ready yet, or Ollama container down. Check `docker compose exec ollama ollama list` and `docker compose ps` |
| `Ollama request timed out after 120s` | The model is running (partly) on **CPU**. Two common causes: **(a)** GPU not reaching the container — verify with `docker exec ollama nvidia-smi` (*"GPU access blocked by the operating system"* = no GPU); register the runtime with `sudo nvidia-ctk runtime configure --runtime=docker && sudo service docker restart`, then check `docker info \| grep -i runtime` lists `nvidia`. **(b)** The model is too big for your VRAM — `docker exec ollama ollama ps` shows a `CPU/GPU` split (e.g. `70%/30%`); pick a model that fits (see next row). Then set `OLLAMA_MODEL` / `OLLAMA_TIMEOUT` in `.env` and `docker compose up -d backend`. See [SETUP.md §GPU support](SETUP.md#gpu-support-in-wsl2-recommended) |
| Model splits across CPU/GPU (`ollama ps` shows e.g. `70%/30%`) | The model doesn't fit in your VRAM. Check total VRAM with `docker exec ollama nvidia-smi --query-gpu=memory.total --format=csv,noheader` and pick a model that fits: `qwen2.5:14b` (~10 GB) needs ≥12 GB; `qwen2.5:7b` (~4.7 GB) needs ~6 GB; `qwen2.5:3b` (~3 GB loaded) fits in 4 GB for **100% GPU**. Set `OLLAMA_MODEL` in `.env`, then `docker compose up -d backend`; confirm with `docker exec ollama ollama ps` (should read `100% GPU`) |
| Analysis is very slow | On CPU the 14b model is slow — first call also pays a cold-start cost. Use a smaller `OLLAMA_MODEL` in `.env`, or run with a GPU |
| No signals ever stored | Expected outside market hours, or when confidence is below `CONFIDENCE_FLOOR`. Lower the floor in `.env` to see more |
| Alerts not sending | Confirm `EMAIL_ENABLED`/`SLACK_ENABLED=true` and credentials are set; only signals ≥ `CONFIDENCE_FLOOR` fire. Check `docker compose logs backend` for send errors |
| Port already in use (8010 / 5174 / 9000) | Stop the conflicting process (`ss -tlnp \| grep :<port>`) or change the host port in `docker-compose.yml` |
| `could not select device driver "nvidia"` | Run `./start-infra.sh --cpu` then `docker compose up --build` |
| Data changes not persisting | Ensure the `./data` bind mount exists and is writable (`chmod -R 777 data` on WSL2) |
| yfinance / indicator errors in logs | Transient upstream/network issues — the scan continues; problems are collected in each result's `errors` list |
