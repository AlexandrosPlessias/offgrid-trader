# Usage Guide

Day-to-day operation of **offgrid-trader**. First-time install is in
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
# macOS only: ensure native Ollama is running (uses Metal GPU)
ollama serve &   # skip if already running

./start-infra.sh      # start shared Ollama proxy + Portainer (idempotent)
docker compose up     # start offgrid-trader
```

**Other common commands:**

```bash
docker compose up -d          # run detached (background)
docker compose up --build     # rebuild images after a code change
docker compose down           # stop offgrid-trader (Ollama/Portainer keep running)
```

Subsequent runs skip the ~9 GB model download because the weights persist in
the `ollama_models` named volume, so the stack is ready in under a minute.

---

## 2. Service URLs

| URL | Service | Purpose |
|---|---|---|
| http://localhost:5174 | React UI | Monitoring dashboard + on-demand analysis |
| http://localhost:8010/docs | Backend API | OpenAPI docs — run `/analyze` interactively |
| http://localhost:8010/health | Backend API | Liveness + scheduler status |
| http://localhost:18889 | Aspire | Traces, metrics, structured logs (offgrid-trader only) |
| http://localhost:9000 | Portainer | Container management UI — logs, stats, console |

The `ollama` container is internal-only (not published to the host); the backend
reaches it at `http://ollama:11434` on the `ai-shared` network.

---

## 3. Day-to-day commands

### Stopping the stack

```bash
# Stop offgrid-trader only (Ollama and Portainer keep running):
docker compose down

# Stop the shared infra (Ollama + Portainer + ai-shared network):
docker compose -f docker-compose.infra.yml down

# Stop everything on the machine at once:
docker stop $(docker ps -q)
```

> `docker compose down` removes the offgrid-trader containers but **not** the
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

# Restart the backend (e.g. after editing .env):
docker compose restart backend

# Rebuild and restart the backend (after a code change):
docker compose up --build backend

# Check container health / status:
docker compose ps
```

> Config in `.env` is read at container start. After editing `.env`, run
> `docker compose restart backend` (or `docker compose up -d backend`) to apply.

---

## 4. API endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/analyze` | On-demand analysis for any ticker |
| POST | `/webhook/tradingview` | Receive a TradingView Pro alert → background scan |
| GET | `/signals` | Recent stored signals (`?ticker=&limit=`) |
| GET | `/analysis/{ticker}` | Analysis-log history for a ticker |
| GET | `/watchlist` | Watchlist + scheduler status |
| GET | `/health` | Liveness + config summary |

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

```bash
# See what the scheduler is doing:
docker compose logs -f backend | grep scheduler

# Confirm state (running / market_open / last_run):
curl http://localhost:8010/watchlist
```

To change the watchlist or cadence, edit `WATCHLIST` / `SCAN_INTERVAL_MINUTES`
in `.env` and `docker compose restart backend`.

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

### Wipe the signals/analysis database

```bash
docker compose down
rm -f data/offgrid_trader.db
docker compose up -d
```

The backend recreates the schema on the next start.

### Re-pull / reset the model weights

Only if you want a completely clean slate (re-downloads ~9 GB). The volume is
shared — this also affects other projects using the same Ollama instance:

```bash
docker compose -f docker-compose.infra.yml down
docker volume rm ollama_models
./start-infra.sh
```

---

## 11. Adjusting log verbosity

The backend logs to stdout. Follow them with:

```bash
docker compose logs -f backend
```

To reduce Ollama request timeouts on slow CPU inference, raise `OLLAMA_TIMEOUT`
in `.env`, then `docker compose restart backend`.

---

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `backend` unhealthy / restarting | `docker compose logs backend`. Most often it's still waiting on `ollama-pull` to finish the model download |
| `/analyze` returns an Ollama error | Model not ready yet, or Ollama container down. Check `docker compose exec ollama ollama list` and `docker compose ps` |
| Analysis is very slow | On CPU the 14b model is slow — first call also pays a cold-start cost. Use a smaller `OLLAMA_MODEL` in `.env`, or run with a GPU |
| No signals ever stored | Expected outside market hours, or when confidence is below `CONFIDENCE_FLOOR`. Lower the floor in `.env` to see more |
| Alerts not sending | Confirm `EMAIL_ENABLED`/`SLACK_ENABLED=true` and credentials are set; only signals ≥ `CONFIDENCE_FLOOR` fire. Check `docker compose logs backend` for send errors |
| Port already in use (8010 / 5174 / 9000) | Stop the conflicting process (`ss -tlnp \| grep :<port>`) or change the host port in `docker-compose.yml` |
| `could not select device driver "nvidia"` | Run `./start-infra.sh --cpu` then `docker compose up --build` |
| Data changes not persisting | Ensure the `./data` bind mount exists and is writable (`chmod -R 777 data` on WSL2) |
| yfinance / tradingview errors in logs | Transient upstream/network issues — the scan continues; problems are collected in each result's `errors` list |
