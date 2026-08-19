#!/usr/bin/env bash
# start-infra.sh — start shared AI infrastructure (Ollama + Portainer).
#
# Auto-detects NVIDIA GPU support and applies the GPU override when available.
# Safe to run repeatedly — already-running containers are left untouched.
#
# Usage (from the project root or from infra/):
#   make infra                # recommended
#   bash infra/start-infra.sh
#   bash infra/start-infra.sh --gpu    # force GPU
#   bash infra/start-infra.sh --cpu    # force CPU

set -euo pipefail

# Resolve paths relative to this script — works from any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$SCRIPT_DIR/docker-compose.infra.yml"
GPU_OVERRIDE="$SCRIPT_DIR/docker-compose.override.gpu.yml"
MAC_OVERRIDE="$SCRIPT_DIR/docker-compose.override.mac.yml"

# ── macOS detection ──────────────────────────────────────────────────────────
is_mac() { [[ "$(uname -s)" == "Darwin" ]]; }

# ── GPU detection ─────────────────────────────────────────────────────────────
detect_gpu() {
  # 1. nvidia-smi available and functional on the host (WSL2 / Linux)
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
    return 0
  fi
  # 2. NVIDIA runtime registered with Docker (covers cases where nvidia-smi
  #    is not on PATH but the Container Toolkit is installed)
  if docker info 2>/dev/null | grep -qi "nvidia"; then
    return 0
  fi
  return 1
}

# ── Argument handling ─────────────────────────────────────────────────────────
USE_GPU=""
for arg in "$@"; do
  case "$arg" in
    --gpu) USE_GPU=true ;;
    --cpu) USE_GPU=false ;;
  esac
done

if [ -z "$USE_GPU" ]; then
  if detect_gpu; then
    USE_GPU=true
  else
    USE_GPU=false
  fi
fi

# ── Launch ────────────────────────────────────────────────────────────────────
if is_mac; then
  # On macOS, Docker containers can't access Apple Metal GPU.
  # Proxy to native Ollama (which uses Metal) instead.
  if ! pgrep -x ollama >/dev/null 2>&1; then
    echo "[ai-shared] Starting native Ollama (required for Metal GPU on macOS)..."
    OLLAMA_ORIGINS="*" ollama serve &>/dev/null &
    sleep 2
  fi
  echo "[ai-shared] macOS — using native Ollama proxy (Metal GPU)"
  docker compose -f "$INFRA" -f "$MAC_OVERRIDE" up -d
elif [ "$USE_GPU" = "true" ]; then
  echo "[ai-shared] NVIDIA GPU detected — starting Ollama with GPU support"
  docker compose -f "$INFRA" -f "$GPU_OVERRIDE" up -d
else
  echo "[ai-shared] No NVIDIA GPU — starting Ollama in CPU mode"
  docker compose -f "$INFRA" up -d
fi
