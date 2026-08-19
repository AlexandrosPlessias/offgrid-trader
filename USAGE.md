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

**Subsequent runs** (model already downloaded, images already built):

```bash
make infra    # start Docker (WSL2) + Ollama + Portainer
make up       # start MarketSage
```

`make infra` detects WSL2 automatically — it starts the Docker service, waits
until the daemon is ready, then launches the shared Ollama + Portainer stack.
On macOS it skips the service step and goes straight to the containers.

**When you are done:**

```bash
make down     # stop MarketSage + Ollama + Portainer + Docker service (WSL2)
```

On WSL2 `make down` gracefully stops all containers and then calls
`sudo service docker stop` so Docker's RAM footprint is freed until the next
session.

---

## 2. Makefile reference

Every interaction goes through `make`. The compose files live in `infra/`; the
Makefile handles the path so you never have to type `-f infra/docker-compose.yml`.

| Command | What it does |
|---|---|
| `make infra` | Start Docker service (WSL2) → Ollama + Portainer (auto-detects GPU) |
| `make up` | Start MarketSage in the background (requires `make infra` first) |
| `make build` | Rebuild images then start — use after any code change |
| `make down` | Stop MarketSage + shared infra + Docker service (WSL2) |
| `make logs` | Tail logs for all MarketSage services |
| `make smoke` | Run offline smoke tests inside the backend container |
| `make lint` | Local quality gate on the host: ruff → flake8 → black → smoke (no Docker needed) |
| `make shell-backend` | Open a bash shell inside the running backend container |

`make up` and `make build` both print a URL table when the stack is ready:

```
  ┌─────────────────────────────────────────────────────────────┐
  │  MarketSage — running                                       │
  ├──────────────────┬──────────────────────────────────────────┤
  │  Frontend (UI)   │  http://localhost:5174                   │
  │  Backend API     │  http://localhost:8010                   │
  │  API Docs        │  http://localhost:8010/docs              │
  │  Aspire          │  http://localhost:18889                  │
  │  Portainer       │  http://localhost:9000                   │
  └──────────────────┴──────────────────────────────────────────┘
```

### After editing `.env`

```bash
make up      # recreates the backend container so new env values are read
             # (a plain `restart` keeps the old environment)
```

### After a code change

```bash
make build   # rebuilds images and restarts all services
```

### Check container status

```bash
docker compose -f infra/docker-compose.yml ps
# Containers are named: offgrid-trader-backend-1, offgrid-trader-frontend-1, offgrid-trader-aspire-1
```

---

## 3. Service URLs

| URL | Service | Purpose |
|---|---|---|
| http://localhost:5174 | React UI | Dashboard · Explorer · Learn · Settings |
| http://localhost:8010 | Backend API | REST API root |
| http://localhost:8010/docs | Backend API | OpenAPI interactive docs |
| http://localhost:8010/health | Backend API | Liveness + scheduler status |
| http://localhost:18889 | Aspire | Traces, metrics, structured logs |
| http://localhost:9000 | Portainer | Container management UI |

`ollama` is internal-only — the backend reaches it at `http://ollama:11434`.

---

## 4. API endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/analyze` | On-demand analysis for any ticker |
| POST | `/analyze/stream` | Same pipeline via SSE (step · retry · memory · skill_error · result events) |
| GET | `/market-data/{ticker}` | Raw market-data dict (price, fundamentals, balance sheet, macro, indicators, news) |
| GET | `/market-data/{ticker}/history` | OHLCV + volume history (`?period=3mo&interval=1d`) |
| POST | `/webhook/tradingview` | Receive a TradingView Pro alert → background scan |
| GET | `/signals` | Recent stored signals (`?ticker=&limit=`) |
| DELETE | `/signals/{id}` | Delete a stored signal by id |
| GET | `/analysis` | Recent analysis-log entries (`?limit=`) |
| DELETE | `/analysis/{id}` | Delete an analysis-log entry by id |
| GET | `/analysis/{ticker}` | Analysis-log history for a single ticker |
| GET | `/watchlist` | Watchlist + scheduler status + alerts toggle |
| POST | `/watchlist` | Add ticker (`{"ticker": "GOOGL"}`) |
| DELETE | `/watchlist/{ticker}` | Remove ticker |
| GET | `/settings` | Current effective settings (env + DB overrides) |
| POST | `/settings/alerts` | Toggle alert dispatch (`{"enabled": true/false}`) |
| POST | `/settings/scheduler` | Start/stop auto-scan (`{"running": true/false}`); persists across restarts |
| POST | `/settings/scan-interval` | Change scan cadence (`{"minutes": 60}`) |
| POST | `/settings/ollama` | Override Ollama model and/or timeout at runtime |
| POST | `/data/reset` | Clear all signals and analysis history (settings preserved) |
| GET | `/health` | Liveness + config summary |

Full reference with request/response shapes: [docs/wiki/api.md](docs/wiki/api.md).

### UI pages

- **Dashboard** — watchlist management, recent signals table with filters (side, confidence, ticker), per-row delete
- **Explorer** — ad-hoc analysis: live pipeline stepper, price snapshot, 3-month chart, RSI/MACD/EMA charts, AI reasoning, raw indicator table, collapsible Analysis History panel
- **Learn** — in-app wiki: pipeline, indicators, fundamentals/macro/balance sheet, opportunity rules, trading glossary, further reading
- **Settings** (⚙) — scheduler toggle + interval, alerts toggle, Ollama model/timeout override, data-reset button

### curl examples

```bash
# On-demand analysis:
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "NVDA"}'

# With alerts:
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "NVDA", "send_alerts": true}'

# Recent signals:
curl "http://localhost:8010/signals?limit=20"
curl "http://localhost:8010/signals?ticker=AAPL&limit=10"

# Analysis history:
curl http://localhost:8010/analysis/AAPL

# Watchlist + scheduler state:
curl http://localhost:8010/watchlist
```

### TradingView webhook

Point a TradingView Pro alert at `http://<your-host>:8010/webhook/tradingview`:

```json
{ "ticker": "{{ticker}}", "action": "buy", "price": {{close}} }
```

---

## 5. The scheduler

The backend runs an async, **market-hours-aware** scan loop (Mon–Fri 9:30–16:00 ET)
via the **Orchestrator** — it sorts tickers by scan staleness and caps concurrency
at 3 to avoid overloading Ollama.

**Auto-scan is off by default.** Enable from the Settings page (⚙) or via API:

```bash
curl -X POST http://localhost:8010/settings/scheduler \
  -H "Content-Type: application/json" \
  -d '{"running": true}'
```

State is persisted to SQLite and survives `make down` + `make up`.

```bash
# Watch scheduler activity:
make logs 2>&1 | grep scheduler

# Confirm current state (running / market_open / last_run):
curl http://localhost:8010/watchlist
```

To change the watchlist, edit `WATCHLIST` in `.env` then `make up`.
To change scan interval without restarting:

```bash
curl -X POST http://localhost:8010/settings/scan-interval \
  -H "Content-Type: application/json" \
  -d '{"minutes": 60}'
```

---

## 6. Container management (Portainer)

Open **http://localhost:9000**. On first visit, set an admin password.

From Portainer: view live logs, CPU/memory stats, open a shell, start/stop
containers — without the CLI.

---

## 7. Data & persistence

| What | Where | Notes |
|---|---|---|
| Signals | `./data/offgrid_trader.db` — `signals` table | Bind-mounted; survives `make down` |
| Analysis log | same DB, `analysis_log` table | Includes `analysis_json`, `market_snapshot`, `opportunities_json` (all detected scores), `actionable_json` (above-floor scores) |
| Ticker memory | same DB, `ticker_memory` table | Per-ticker prior context (signal, confidence, RSI streak, price trend); 48h TTL |
| Ollama model weights | `ollama_models` named volume | Pulled once; shared with other AI projects |
| Portainer config | `portainer_data` named volume | |

```bash
# Inspect row counts — open a container shell then run:
make shell-backend
python -m backend.database
exit

# Or query SQLite directly from the host:
sqlite3 data/offgrid_trader.db \
  "SELECT ticker, type, confidence, source, timestamp FROM signals ORDER BY id DESC LIMIT 10;"
```

---

## 8. Running modules manually

Open a shell in the backend container, then run any module without the Docker prefix:

```bash
make shell-backend

# Inside the container:
python -m backend.config                  # resolved config (secrets masked)
python -m backend.data AAPL               # fetch unified market data
python -m backend.analysis AAPL           # data → Ollama → parsed analysis
python -m backend.opportunities AAPL      # full detection for one ticker
python -m backend.scheduler               # one-shot watchlist scan (no alerts)
exit
```

Verify Ollama has the model (shared infra stack):

```bash
docker exec ollama ollama list
```

---

## 9. Smoke test

Run the offline smoke test — no live Ollama, yfinance, or SMTP calls:

```bash
make smoke
```

Expected output ends with:

```
==================================================
SMOKE TEST PASSED — all checks green
```

Run after every significant code change to catch regressions. To run locally
without Docker:

```bash
pip install -r requirements/dev.txt
python tests/smoke_test.py
```

---

## 10. Resetting state

### Clear signals and analysis history (keep settings)

From the **Settings page** (⚙), use **Clear all data**. Or via API:

```bash
curl -X POST http://localhost:8010/data/reset
```

### Wipe the entire database

```bash
make down
rm -f data/offgrid_trader.db
make infra && make up
```

The backend recreates the schema on startup.

### Re-pull model weights

Only if you need a completely clean slate (~9 GB re-download):

```bash
make down
docker volume rm ollama_models
make infra
```

---

## 11. Logs and telemetry

```bash
make logs                       # tail all services
make logs 2>&1 | grep backend   # backend only
```

| Logger | What it logs |
|---|---|
| `backend.data` | `yfinance ▶/◀` fetch, `indicators ▶/◀` per timeframe |
| `backend.analysis` | `ollama ▶/◀` prompt, response, latency |
| `backend.agent` | Skill start/done/retry, memory load/update |
| `backend.scheduler` | Scan loop events, orchestrator dispatch |

All logs forward to **Aspire** at http://localhost:18889 when the OTEL endpoint
is set (automatic in Docker).

To raise the Ollama timeout:

```bash
# Edit .env: OLLAMA_TIMEOUT=300
make up   # recreates the container so the new value is applied
```

---

## 12. Re-capturing documentation screenshots

```bash
# One-time setup:
cd docs/screenshots && npm install && npx playwright install chromium

# Ensure at least one saved analysis exists:
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "AAPL"}'

# Capture all 15 screenshots:
node docs/screenshots/capture.mjs
```

See [docs/screenshots/README.md](docs/screenshots/README.md) for the full
file inventory and troubleshooting.

---

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to Docker daemon` | Docker isn't running. Run `make infra` — it starts the Docker service automatically on WSL2 |
| `make up` fails immediately | Run `make infra` first — Docker needs to be running before `make up` |
| `backend` unhealthy / restarting | `make logs` — most often waiting for `ollama-pull` to finish the model download |
| `/analyze` returns an Ollama error | Model not ready or Ollama down. Check `docker exec ollama ollama list` |
| `Ollama request timed out after 120s` | Model running partly on CPU. **(a)** GPU not reaching container — `docker exec ollama nvidia-smi`; fix with `sudo nvidia-ctk runtime configure --runtime=docker && sudo service docker restart`. **(b)** Model too big for VRAM — `docker exec ollama ollama ps` shows `CPU/GPU` split; pick a smaller model. Edit `.env`, then `make up`. See [SETUP.md §GPU support](SETUP.md#gpu-support-in-wsl2-recommended) |
| Model splits CPU/GPU | `docker exec ollama ollama ps` shows e.g. `70%/30%`. Check VRAM: `docker exec ollama nvidia-smi --query-gpu=memory.total --format=csv,noheader`. Sizes: `qwen2.5:14b` ~10 GB → ≥12 GB VRAM; `qwen2.5:7b` ~4.7 GB → ~6 GB; `qwen2.5:3b` ~3 GB → fits 4 GB fully. Set `OLLAMA_MODEL` in `.env`, run `make up`, confirm `100% GPU` with `docker exec ollama ollama ps` |
| Analysis is very slow | CPU-only + cold start. Use a smaller `OLLAMA_MODEL` or enable GPU passthrough |
| No signals stored | Expected outside market hours or confidence < `CONFIDENCE_FLOOR`. Lower the floor in `.env` to see more |
| Alerts not sending | Confirm `EMAIL_ENABLED=true` and credentials set; only signals ≥ `CONFIDENCE_FLOOR` fire. Check `make logs` |
| Port in use (8010 / 5174 / 9000) | `ss -tlnp \| grep :<port>` to find the owner; change the host port in `infra/docker-compose.yml` |
| `could not select device driver "nvidia"` | `make infra --cpu` (CPU-only Ollama) then `make build` |
| Data changes not persisting | `chmod -R 777 data` (WSL2 bind-mount permission issue) |
| yfinance / indicator errors in logs | Transient network — scan continues; errors in `result.errors` |
| Blank page at http://localhost:5174 | Hard refresh: **Ctrl+Shift+R** (Windows/Linux) or **Cmd+Shift+R** (macOS) |
