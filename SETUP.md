# Setup Guide

First-time setup for **offgrid-trader**. After this, see
[USAGE.md](USAGE.md) for day-to-day operation.

The entire stack runs in Docker — no Python venv and no native Ollama required.
It is fully **local and zero-cost**: market data comes from free sources
(yfinance, tradingview-ta) and the AI runs on a local Ollama `qwen2.5:14b`
model. No paid or cloud APIs are used.

> ⚠️ **Not financial advice.** For educational/research use only.

---

## 0. One-command bootstrap (recommended)

If you just want to get running, use the bootstrap script for your platform —
it handles steps 1–5 below automatically:

```bash
# WSL2 / Ubuntu:
bash scripts/setup_wsl.sh

# macOS (Intel or Apple Silicon):
bash scripts/setup_macos.sh
```

The script checks Docker, creates `.env` from `.env.example` if missing, starts
shared infrastructure, and launches the full stack. Skip to [section 6](#6-verify)
to verify the result.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Docker Desktop** | Enable WSL2 integration: Settings → Resources → WSL Integration → turn on your Ubuntu distro |
| **WSL2 + Ubuntu** | 22.04 or 24.04 (`wsl --install -d Ubuntu` from PowerShell) |
| **RAM** | 16 GB minimum (`qwen2.5:14b` ≈ 9 GB resident) |
| **Disk** | ~15 GB free (model weights + images) |
| **NVIDIA GPU** *(recommended)* | With the NVIDIA Container Toolkit for fast inference. CPU-only works too — see [section 5](#5-first-run) |
| **git** | To clone the repo |

### GPU support in WSL2 (recommended)

`qwen2.5:14b` is large; a GPU makes analysis fast. To use your NVIDIA GPU from
Docker inside WSL2:

1. Install the latest **NVIDIA driver for WSL** on Windows (from nvidia.com).
2. Install the **NVIDIA Container Toolkit** in your WSL2 distro:
   ```bash
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
     sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
     sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
     sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
   sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   ```
3. Verify: `docker run --rm --gpus all ubuntu nvidia-smi` should print your GPU.

**No GPU?** Skip this — use the CPU override in [section 5](#5-first-run).

---

## 2. WSL2 filesystem: work on ext4, not `/mnt/c`

> **Skip this if you cloned into your WSL home (`~/…`).** From the repo root run
> `df -T . | awk 'NR==2{print $2}'` — if the output is `ext4` you're on the fast path.

When the repo lives under `/mnt/c/` (any Windows path), every file read/write
crosses the 9p bridge between the Linux kernel and Windows. For Docker build
contexts and Python imports this is 10–50× slower than native ext4.

```bash
df -T . | awk 'NR==2{print $2}'
# Expected: ext4
# Bad:      9p  or  drvfs   -> re-clone into ~ (see below)
```

If you're on `9p`/`drvfs`, re-clone into your WSL home:

```bash
cd ~
git clone <your-remote-url> offgrid-trader
cd offgrid-trader
```

---

## 3. Clone the repo

```bash
git clone <your-remote-url> offgrid-trader
cd offgrid-trader
```

---

## 4. Configuration

The only file you need to create is `.env`, which holds your watchlist,
thresholds, and optional alert credentials. Infrastructure URLs (the Ollama
address) are wired automatically by Compose.

```bash
cp .env.example .env
```

Then open `.env` and adjust as needed. Everything has a working default; the
table below highlights the values you'll most likely change:

| Variable | Required | Purpose |
|---|---|---|
| `WATCHLIST` | No | Comma-separated tickers to monitor (default: `AAPL,MSFT,NVDA,TSLA,AMD,SPY`) |
| `SCAN_INTERVAL_MINUTES` | No | How often to scan while the market is open (default: `15`) |
| `CONFIDENCE_FLOOR` | No | Minimum confidence (0–100) to store/alert on a signal (default: `65`) |
| `OLLAMA_MODEL` | No | Local model tag (default: `qwen2.5:14b`) |
| `EMAIL_ENABLED` | No | `true` to send Gmail alerts (needs the SMTP vars below) |
| `SMTP_USERNAME` / `SMTP_APP_PASSWORD` | If email on | Gmail address + **App Password** (not your account password) |
| `EMAIL_TO` | If email on | Recipient address |
| `SLACK_ENABLED` | No | `true` to send Slack alerts |
| `SLACK_WEBHOOK_URL` | If Slack on | Slack Incoming Webhook URL |
| `TELEGRAM_ENABLED` | No | `true` to send Telegram alerts |
| `TELEGRAM_BOT_TOKEN` | If Telegram on | Token from BotFather (see below) |
| `TELEGRAM_CHAT_ID` | If Telegram on | Your chat or group ID (see below) |

> `OLLAMA_HOST` is overridden to `http://ollama:11434` by Compose, so leave the
> `.env` value as-is — inside Docker the app talks to the `ollama` container.

### Optional: Gmail alerts

1. Enable 2-Step Verification on your Google account.
2. Create an **App Password**: https://myaccount.google.com/apppasswords
3. In `.env` set `EMAIL_ENABLED=true`, `SMTP_USERNAME`, `SMTP_APP_PASSWORD`,
   `EMAIL_FROM`, `EMAIL_TO`.

### Optional: Slack alerts

1. Create an Incoming Webhook: https://api.slack.com/messaging/webhooks
2. In `.env` set `SLACK_ENABLED=true` and `SLACK_WEBHOOK_URL=<url>`.

### Optional: Telegram alerts

**Step 1 — Create a bot via BotFather**

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts (choose a name and a username ending in `bot`).
3. BotFather replies with a **token** like `123456789:AAF...`. Copy it — this is your `TELEGRAM_BOT_TOKEN`.

**Step 2 — Get your Chat ID**

1. Start a conversation with your new bot (search for its username and press **Start**).
2. Send any message to it (e.g. `hello`).
3. Open this URL in your browser, replacing `<TOKEN>` with your bot token:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. In the JSON response, find `"chat":{"id": 123456789}` — that number is your `TELEGRAM_CHAT_ID`.

> **Group chats:** add the bot to the group, send a message mentioning it, then
> call `getUpdates` — the `id` will be a negative number (e.g. `-987654321`).

**Step 3 — Configure `.env`**

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456789:AAF...
TELEGRAM_CHAT_ID=123456789
```

Restart the backend: `docker compose restart backend`.
Trigger a test alert via the React UI or `curl` to confirm delivery.

> `.env` is gitignored and `.dockerignore` prevents it from being baked into
> images — Compose passes it at runtime via `env_file:`.

---

## 5. First run

### Step 1 — Start shared infrastructure (Ollama + Portainer)

Ollama and Portainer live in a shared stack so they can be reused by other
local AI projects (e.g. `insurance-agent-rag-poc`) without running duplicates.

```bash
./start-infra.sh
```

The script auto-detects whether an NVIDIA GPU is available and applies the GPU
override automatically. It is **idempotent** — if another project already
started the shared stack, it detects the running containers and exits
immediately without touching anything.

You can also run it manually if needed:

```bash
# CPU-only (macOS, no GPU)
docker compose -f docker-compose.infra.yml up -d

# GPU explicit
docker compose -f docker-compose.infra.yml \
               -f docker-compose.override.gpu.yml up -d
```

> **First-time model download:** `ollama-pull` will download `qwen2.5:14b`
> (~9 GB) plus the insurance-poc models. This takes 15–30 minutes on first run.
> Weights persist in a named Docker volume and are never re-downloaded.

### Step 2 — Start offgrid-trader

```bash
# GPU
docker compose up --build

# CPU-only (Ollama already running without GPU from Step 1)
docker compose up --build
```

### What happens on first run

| Phase | What | Approx time |
|---|---|---|
| Infra start (`docker-compose.infra.yml`) | Ollama starts, models download | 15–30 min first time, <30 s after |
| Image build (`docker compose up --build`) | Docker builds `backend` + `frontend` | 1–3 min |
| Backend start | FastAPI comes up, DB initialises, scheduler starts | < 30 s |

**Total first-run time: 20–35 minutes.** Subsequent runs start in under a
minute — see [USAGE.md](USAGE.md).

---

## 6. Verify

Once the `ollama-pull` container has exited `0` and `backend` is healthy:

```bash
curl http://localhost:8010/health
```

Expected: `{"status":"ok",...}`.

| URL | What |
|---|---|
| http://localhost:8010/health | Liveness + config summary |
| http://localhost:8010/docs | FastAPI OpenAPI docs (try `/analyze` here) |
| http://localhost:5174 | React monitoring UI |
| http://localhost:18889 | Aspire dashboard — traces, metrics, structured logs |
| http://localhost:9000 | Portainer (shared — also shows insurance-poc containers) |

Run an on-demand analysis:

```bash
curl -X POST http://localhost:8010/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "AAPL"}'
```

---

## 7. Smoke test (optional)

Verify the backend logic is wired correctly without touching live APIs:

```bash
# Inside the running backend container (no extra installs needed):
docker compose exec backend python tests/smoke_test.py
```

All checks should print `PASS`. The final line will read:

```
SMOKE TEST PASSED — all checks green
```

To run locally instead (requires dev deps):

```bash
pip install -r requirements/dev.txt
python tests/smoke_test.py
```

---

## 8. Troubleshooting setup

| Symptom | Fix |
|---|---|
| `could not select device driver "nvidia"` | No GPU / toolkit. Run `./start-infra.sh --cpu` to start Ollama in CPU mode, then `docker compose up --build` normally |
| `env file .env not found` | You skipped `cp .env.example .env`. Create it (section 4) |
| `ollama-pull` stalls or errors | Download interrupted — `docker compose restart ollama-pull`. Already-downloaded weights are kept in the volume |
| `backend` keeps restarting | Check `docker compose logs backend`. Usually it's waiting on `ollama-pull` to finish the model download |
| Port already in use (8010 / 9000 / 18889) | Find the owner: `ss -tlnp \| grep :<port>` — stop it or change the host port in `docker-compose.yml` |
| `address already in use` on 11434 | A native Ollama is running. This stack does not publish 11434, so a native Ollama is harmless — but stop it with `pkill ollama` if you want the container to own the GPU |
| Docker OOM — container killed | Raise Docker Desktop memory: Settings → Resources → Memory (12 GB recommended for the 14b model) |
| `permission denied` on `data/` | WSL2 bind-mount issue. `chmod -R 777 data` or move the repo to ext4 (section 2) |
| First inference very slow | Cold start — Ollama loads the model into RAM on the first request; later calls are fast. On CPU, consider a smaller model |
