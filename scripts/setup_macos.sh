#!/usr/bin/env bash
# macOS bootstrap for offgrid-trader.
# Run from anywhere:  bash scripts/setup_macos.sh
#
# Ollama runs natively on macOS to use Apple Metal GPU.
# Docker Compose proxies to it via host.docker.internal.
# Prerequisites: Docker Desktop for Mac (Apple Silicon or Intel), 8 GB RAM, 10 GB free disk.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================================"
echo "  offgrid-trader — macOS bootstrap"
echo "============================================================"
echo

# ── 1. Verify Docker is reachable ─────────────────────────────────────────────
echo "[1/4] Checking Docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' not found." >&2
  echo "  Install Docker Desktop for Mac from https://www.docker.com/products/docker-desktop" >&2
  echo "  Or via Homebrew:  brew install --cask docker" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "  Docker daemon not running — attempting to start Docker Desktop..."
  open /Applications/Docker.app 2>/dev/null || true
  echo "  Waiting up to 60 s for daemon..."
  for _ in $(seq 1 30); do
    sleep 2
    docker info >/dev/null 2>&1 && break || true
  done
  if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker daemon did not start. Open Docker Desktop manually and rerun." >&2
    exit 1
  fi
fi
echo "  Docker $(docker --version | awk '{print $3}' | tr -d ',') — daemon reachable."

# ── 2. Verify native Ollama is installed and running ───────────────────────────
echo "[2/4] Checking native Ollama..."
if ! command -v ollama >/dev/null 2>&1; then
  echo "  Ollama not found. Installing via Homebrew..."
  brew install ollama
fi
if ! pgrep -x ollama >/dev/null 2>&1; then
  echo "  Starting native Ollama (uses Apple Metal GPU)..."
  ollama serve &>/dev/null &
  sleep 3
fi
echo "  Ollama running natively (Metal GPU)."

# ── 3. Verify .env exists ────────────────────────────────────────────────────
echo "[3/4] Checking .env..."
ENV_FILE="$REPO_ROOT/.env"
EXAMPLE_FILE="$REPO_ROOT/.env.example"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$EXAMPLE_FILE" ]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "  Created .env from .env.example."
    echo "  Review .env and adjust WATCHLIST, alert credentials, etc. before use."
  else
    echo "ERROR: .env not found and no .env.example to copy from." >&2
    exit 1
  fi
else
  echo "  .env already exists."
fi

# ── 4. Build + start the stack ────────────────────────────────────────────────
echo "[4/4] Starting shared infra then project services..."
echo "  On macOS, models are pulled by native Ollama into ~/.ollama (~5 GB for qwen2.5:7b)."
echo "  If not yet pulled, the first run will download them — may take 5–15 min."
echo
cd "$REPO_ROOT"

# start-infra.sh auto-detects macOS and applies the Mac override automatically.
./start-infra.sh
docker compose up --build

echo
echo "============================================================"
echo "  Stack running."
echo "============================================================"
echo "  React UI    → http://localhost:5174"
echo "  Backend API → http://localhost:8010"
echo "  Logs        → http://localhost:18889  (Aspire dashboard)"
echo "  Portainer   → http://localhost:9000"
echo
echo "  Stop:  docker compose down"
echo "  Logs:  docker compose logs -f <service>"
echo
