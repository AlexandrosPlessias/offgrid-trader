#!/usr/bin/env bash
# macOS bootstrap for offgrid-trader.
# Run from anywhere:  bash scripts/setup_macos.sh
#
# All services run in Docker Compose — no Python venv or native Ollama required.
# Prerequisites: Docker Desktop for Mac (Apple Silicon or Intel), 16 GB RAM, 15 GB free disk.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================================"
echo "  offgrid-trader — macOS bootstrap"
echo "============================================================"
echo

# ── 1. Verify Docker is reachable ─────────────────────────────────────────────
echo "[1/3] Checking Docker..."
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

# ── 2. Verify .env exists ──────────────────────────────────────────────────────
echo "[2/3] Checking .env..."
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

# ── 3. Build + start the stack ────────────────────────────────────────────────
echo "[3/3] Starting shared infra then project services..."
echo "  The first run downloads ~9 GB of Ollama models — may take 15–30 min."
echo "  Subsequent runs reuse the 'ollama_models' named volume."
echo
echo "  NOTE: On macOS, Ollama runs in CPU mode inside Docker (no GPU passthrough)."
echo "  For faster inference, install Ollama natively: https://ollama.com"
echo
cd "$REPO_ROOT"

# start-infra.sh auto-detects GPU — on macOS it will always choose CPU mode.
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
