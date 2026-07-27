#!/usr/bin/env bash
# start-infra.sh — start shared AI infrastructure (Ollama + Portainer).
#
# Auto-detects NVIDIA GPU support and applies the GPU override when available.
# Safe to run repeatedly — already-running containers are left untouched.
#
# Usage:
#   ./start-infra.sh          # auto-detect (recommended)
#   ./start-infra.sh --gpu    # force GPU
#   ./start-infra.sh --cpu    # force CPU

set -euo pipefail

INFRA=docker-compose.infra.yml
GPU_OVERRIDE=docker-compose.override.gpu.yml

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
if [ "$USE_GPU" = "true" ]; then
  echo "[ai-shared] NVIDIA GPU detected — starting Ollama with GPU support"
  docker compose -f "$INFRA" -f "$GPU_OVERRIDE" up -d
else
  echo "[ai-shared] No NVIDIA GPU — starting Ollama in CPU mode"
  docker compose -f "$INFRA" up -d
fi
