# Setup Guide

First-time setup for **MarketSage**. After this, see
[USAGE.md](USAGE.md) for day-to-day operation.

The entire stack runs in Docker — no Python venv required.
On **macOS**, native Ollama is used so inference runs on Apple Metal GPU (Docker containers
cannot access it). On Windows/Linux, Ollama runs inside Docker.
It is fully **local and zero-cost**: market data comes from free sources
(yfinance + ta library for indicators) and the AI runs on a local Ollama
`qwen2.5:14b` model. No paid or cloud APIs are required.

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

### Windows / WSL2

| Requirement | Notes |
|---|---|
| **Docker Desktop** | Enable WSL2 integration: Settings → Resources → WSL Integration → turn on your Ubuntu distro |
| **WSL2 + Ubuntu** | 22.04 or 24.04 (`wsl --install -d Ubuntu` from PowerShell) |
| **RAM** | 8 GB minimum; 16 GB recommended for `qwen2.5:14b` |
| **Disk** | ~12 GB free (model weights + Docker images in named volume) |
| **NVIDIA GPU** *(recommended)* | NVIDIA Container Toolkit for fast inference — see GPU section below |
| **git** | To clone the repo (run inside WSL, not PowerShell) |

### macOS

| Requirement | Notes |
|---|---|
| **Docker Desktop for Mac** | Intel or Apple Silicon; allocate ≥12 GB RAM in Settings → Resources |
| **Ollama (native)** | Install from https://ollama.com/download — must be running before `make infra`. The infra script proxies Docker to the native Ollama so inference runs on Apple Metal GPU |
| **RAM** | 8 GB minimum; 16 GB recommended for `qwen2.5:14b` |
| **Disk** | ~6 GB free (`qwen2.5:7b` weights stored in `~/.ollama` by native Ollama) |
| **git** | Xcode Command Line Tools (`xcode-select --install`) or Homebrew git |

> **Why native Ollama on macOS?** Docker containers cannot access Apple Metal GPU, so
> inference would run on CPU inside Docker (very slow). Running Ollama natively gives
> full Metal acceleration; the infra stack's `ollama-proxy` routes the backend's
> requests transparently to `http://host.docker.internal:11434`.

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
3. **Restart Docker so the `nvidia` runtime is registered** — this step is easy
   to miss and is the usual cause of silent CPU fallback:
   ```bash
   sudo service docker restart
   ```
4. Verify the runtime is registered and the GPU is reachable:
   ```bash
   docker info | grep -i runtime          # should list 'nvidia'
   docker run --rm --gpus all ubuntu nvidia-smi   # should print your GPU
   ```

> ⚠️ **If you skip step 3**, containers still *start* (Compose requests a GPU
> device), but the toolkit hook never injects it. Ollama then falls back to
> **CPU**, where `qwen2.5:14b` is so slow that `/analyze` fails with
> **`Ollama request timed out after 120s`**. Inside the container
> `nvidia-smi` reports *"GPU access blocked by the operating system"*. See the
> troubleshooting entry in [section 8](#8-troubleshooting-setup).

**No GPU?** Skip this — use the CPU override in [section 5](#5-first-run), and
set a smaller `OLLAMA_MODEL` (`qwen2.5:7b` or `qwen2.5:3b`) so CPU inference
finishes within the timeout.

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
git clone <your-remote-url> marketsage
cd marketsage
```

---

## 3. Clone the repo

```bash
git clone <your-remote-url> marketsage
cd marketsage
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
| `OLLAMA_MODEL` | No | Local model tag. Match it to your **GPU VRAM** for full-GPU speed: `qwen2.5:3b` (4 GB), `qwen2.5:7b` (~6 GB), `qwen2.5:14b` (≥12 GB). A model bigger than your VRAM still runs but spills to CPU and is much slower (default: `qwen2.5:7b`) |
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

Apply the change: `docker compose up -d backend` (recreates the container so the
new `.env` values are read — a plain `restart` keeps the old environment).
Trigger a test alert via the React UI or `curl` to confirm delivery.

> `.env` is gitignored and `.dockerignore` prevents it from being baked into
> images — Compose passes it at runtime via `env_file:`.

---

## 5. First run

### Step 0 — Make sure Docker is running

Docker is **not started automatically** on either platform. You must bring it
up before running any `docker compose` command.

**WSL2 (Windows):**
```bash
sudo service docker start
```
Run this once per WSL session. You can verify Docker is up with `docker ps`.

**macOS:**
Open **Docker Desktop** from Spotlight or Applications, or from the terminal:
```bash
open -a Docker
```
Wait until the Docker icon in the menu bar stops animating (usually ~10 s).

> **Disable auto-start (save resources when idle):**
>
> *WSL2:* Run once to prevent Docker from starting on every WSL boot:
> ```bash
> sudo systemctl disable docker.service docker.socket
> ```
> Re-enable any time with `sudo systemctl enable docker.service docker.socket`.
>
> *macOS:* Docker Desktop → Settings → General → uncheck
> **"Start Docker Desktop when you log in"**, then quit Docker Desktop.

> **Stopping Docker when done (free up RAM and GPU):**
>
> *WSL2:*
> ```bash
> make down                                               # stop MarketSage
> docker compose -f infra/docker-compose.infra.yml down  # stop Ollama + Portainer
> sudo service docker stop                               # stop Docker daemon
> ```
>
> *macOS:*
> ```bash
> make down
> docker compose -f infra/docker-compose.infra.yml down
> osascript -e 'quit app "Docker Desktop"'              # quit Docker Desktop
> ```

---

### Step 1 — Start shared infrastructure (Ollama + Portainer)

Ollama and Portainer live in a shared stack so they can be reused by other
local AI projects (e.g. `insurance-agent-rag-poc`) without running duplicates.

```bash
make infra
```

The script auto-detects whether an NVIDIA GPU is available and applies the GPU
override automatically. It is **idempotent** — if another project already
started the shared stack, it detects the running containers and exits
immediately without touching anything.

You can also run it manually if needed:

```bash
# macOS (proxies to native Ollama for Metal GPU)
docker compose -f infra/docker-compose.infra.yml \
               -f infra/docker-compose.override.mac.yml up -d

# CPU-only (Windows/Linux, no GPU)
docker compose -f infra/docker-compose.infra.yml up -d

# GPU explicit (Windows/Linux with NVIDIA)
docker compose -f infra/docker-compose.infra.yml \
               -f infra/docker-compose.override.gpu.yml up -d
```

> **First-time model download:** `ollama-pull` will download `qwen2.5:14b`
> (~9 GB) plus the insurance-poc models. This takes 15–30 minutes on first run.
> Weights persist in a named Docker volume and are never re-downloaded.

### Step 2 — Start MarketSage

```bash
make build
```

### What happens on first run

| Phase | What | Approx time |
|---|---|---|
| Infra start (`make infra`) | Ollama starts, models download | 15–30 min first time, <30 s after |
| Image build (`make build`) | Docker builds `backend` + `frontend` | 1–3 min |
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

Verify the backend logic is wired correctly without touching live APIs.
`tests/` is included in the Docker image, so the test runs directly:

```bash
docker compose exec backend python tests/smoke_test.py
```

All checks should print `PASS`. The final line will read:

```
SMOKE TEST PASSED — all checks green
```

To run locally instead (requires dev deps installed in the host environment):

```bash
pip install -r requirements/dev.txt
python tests/smoke_test.py
```

---

## 8. Troubleshooting setup

| Symptom | Fix |
|---|---|
| `Ollama request timed out after 120s` | Inference is running (partly) on **CPU**. Confirm GPU reachability with `docker exec ollama nvidia-smi` (a *"GPU access blocked by the operating system"* error = no GPU), and check the CPU/GPU split with `docker exec ollama ollama ps`. Fix GPU passthrough: `sudo nvidia-ctk runtime configure --runtime=docker && sudo service docker restart`, then check `docker info \| grep -i runtime` lists `nvidia`. If the model is simply too big for your VRAM (see next row), pick a smaller `OLLAMA_MODEL` or raise `OLLAMA_TIMEOUT` in `.env`, then `docker compose up -d backend` |
| GPU present on host but container runs on CPU | The `nvidia` runtime isn't registered with the Docker daemon even though the toolkit is installed. `docker info \| grep -i runtime` won't list `nvidia`. Run `sudo nvidia-ctk runtime configure --runtime=docker && sudo service docker restart`, then `make infra` again |
| Model splits CPU/GPU or won't fit in VRAM | `docker exec ollama ollama ps` shows a `CPU/GPU` split (e.g. `70%/30%`) — the model is larger than your VRAM. Check VRAM with `docker exec ollama nvidia-smi --query-gpu=memory.total --format=csv,noheader`, then choose a model that fits: `qwen2.5:14b` (~10 GB) needs ≥12 GB; `qwen2.5:7b` (~4.7 GB) needs ~6 GB; `qwen2.5:3b` (~3 GB) fits **fully** in a 4 GB GPU. Set `OLLAMA_MODEL` in `.env`, `docker compose up -d backend`, then confirm `100% GPU` via `docker exec ollama ollama ps` |
| `could not select device driver "nvidia"` | No GPU / toolkit. Run `make infra --cpu` to start Ollama in CPU mode, then `docker compose up --build` normally |
| `env file .env not found` | You skipped `cp .env.example .env`. Create it (section 4) |
| `ollama-pull` stalls or errors | Download interrupted — `docker compose restart ollama-pull`. Already-downloaded weights are kept in the volume |
| `backend` keeps restarting | Check `docker compose logs backend`. Usually it's waiting on `ollama-pull` to finish the model download |
| Port already in use (8010 / 9000 / 18889) | Find the owner: `ss -tlnp \| grep :<port>` — stop it or change the host port in `infra/docker-compose.yml` |
| `address already in use` on 11434 | A native Ollama is running. This stack does not publish 11434, so a native Ollama is harmless — but stop it with `pkill ollama` if you want the container to own the GPU |
| Docker OOM — container killed | Raise Docker Desktop memory: Settings → Resources → Memory (12 GB recommended for the 14b model) |
| `permission denied` on `data/` | WSL2 bind-mount issue. `chmod -R 777 data` or move the repo to ext4 (section 2) |
| First inference very slow | Cold start — Ollama loads the model into RAM on the first request; later calls are fast. On CPU, consider a smaller model |
