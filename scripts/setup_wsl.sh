#!/usr/bin/env bash
# WSL2 Ubuntu bootstrap for offgrid-trader.
# Run from anywhere:  bash scripts/setup_wsl.sh
#
# All services run in Docker Compose — no Python venv or native Ollama required.
# Prerequisites: Docker Desktop for Windows with WSL2 integration enabled.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================================"
echo "  offgrid-trader — WSL2 bootstrap"
echo "============================================================"
echo

# ── 1. Verify Docker is reachable ─────────────────────────────────────────────
echo "[1/3] Checking Docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' not found." >&2
  echo "  Install Docker Desktop for Windows and enable WSL2 integration:" >&2
  echo "  Settings → Resources → WSL Integration → turn on for this distro" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not reachable." >&2
  echo "  Open Docker Desktop on Windows and wait for the whale icon to settle." >&2
  exit 1
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
cd "$REPO_ROOT"
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
