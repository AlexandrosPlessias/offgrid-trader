#!/usr/bin/env bash
# start-infra.sh — start shared AI infrastructure (Ollama + Portainer).
#
# Auto-detects NVIDIA GPU support and applies the GPU override when available.
# Auto-detects LLM_PROVIDER from .env: skips Ollama containers (saves RAM/VRAM)
# when provider is set to groq, sambanova, or custom.
# Safe to run repeatedly — already-running containers are left untouched.
#
# Usage (from the project root or from infra/):
#   make infra                   # recommended
#   bash infra/start-infra.sh
#   bash infra/start-infra.sh --gpu          # force GPU
#   bash infra/start-infra.sh --cpu          # force CPU
#   bash infra/start-infra.sh --skip-ollama  # force skip Ollama (cloud LLM)
#   bash infra/start-infra.sh --with-ollama  # force start Ollama even if provider != ollama

set -euo pipefail

# Resolve paths relative to this script — works from any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$SCRIPT_DIR/docker-compose.infra.yml"
GPU_OVERRIDE="$SCRIPT_DIR/docker-compose.override.gpu.yml"
MAC_OVERRIDE="$SCRIPT_DIR/docker-compose.override.mac.yml"
ENV_FILE="$SCRIPT_DIR/../.env"

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

# ── LLM provider detection — auto-skip Ollama for cloud providers ─────────────
LLM_PROVIDER="ollama"
if [[ -f "$ENV_FILE" ]]; then
  _provider=$(grep -E '^LLM_PROVIDER=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 | sed 's/#.*//' | tr -d '"' | tr -d "'" | tr -d ' ')
  [[ -n "$_provider" ]] && LLM_PROVIDER="$_provider"
fi

SKIP_OLLAMA=false
[[ "$LLM_PROVIDER" != "ollama" ]] && SKIP_OLLAMA=true

# ── Argument handling ─────────────────────────────────────────────────────────
USE_GPU=""
for arg in "$@"; do
  case "$arg" in
    --gpu)         USE_GPU=true ;;
    --cpu)         USE_GPU=false ;;
    --skip-ollama) SKIP_OLLAMA=true ;;
    --with-ollama) SKIP_OLLAMA=false ;;
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
if [ "$SKIP_OLLAMA" = "true" ]; then
  # Cloud LLM provider — skip Ollama containers entirely (no GPU memory, no
  # 9 GB model download). Portainer still starts for container management.
  echo "[ai-shared] LLM_PROVIDER=$LLM_PROVIDER — skipping Ollama (saves RAM/VRAM)"
  echo "[ai-shared] To start Ollama anyway: bash infra/start-infra.sh --with-ollama"
  docker compose -f "$INFRA" up -d
  # ^ COMPOSE_PROFILES not set → ollama + ollama-pull are silently skipped
elif is_mac; then
  # On macOS, Docker containers can't access Apple Metal GPU.
  # Proxy to native Ollama (which uses Metal) instead.
  if ! pgrep -x ollama >/dev/null 2>&1; then
    echo "[ai-shared] Starting native Ollama (required for Metal GPU on macOS)..."
    OLLAMA_ORIGINS="*" ollama serve &>/dev/null &
    sleep 2
  fi
  echo "[ai-shared] macOS — using native Ollama proxy (Metal GPU)"
  COMPOSE_PROFILES=ollama docker compose -f "$INFRA" -f "$MAC_OVERRIDE" up -d
elif [ "$USE_GPU" = "true" ]; then
  echo "[ai-shared] NVIDIA GPU detected — starting Ollama with GPU support"
  COMPOSE_PROFILES=ollama docker compose -f "$INFRA" -f "$GPU_OVERRIDE" up -d
else
  echo "[ai-shared] No NVIDIA GPU — starting Ollama in CPU mode"
  COMPOSE_PROFILES=ollama docker compose -f "$INFRA" up -d
fi
