#!/usr/bin/env bash
# Set all Cloudflare Worker secrets for offgrid-trader-cron.
# Reads ADMIN_TOKEN and BACKEND_PUBLIC_URL from the root .env file.
# Prompts for FLY_API_TOKEN and FLY_APP (not stored in .env).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
ENV_FILE="$ROOT/.env"

cd "$SCRIPT_DIR"

echo ""
echo "=== offgrid-trader-cron — secret setup ==="
echo ""

# ── Load from .env ─────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE"
  exit 1
fi

# Parse key=value lines, ignore comments and blanks.
get_env() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d'=' -f2- | tr -d '\r'
}

ADMIN_TOKEN="$(get_env ADMIN_TOKEN)"
BACKEND_URL="$(get_env BACKEND_PUBLIC_URL | sed 's|/$||')"  # strip trailing slash

# ── Push a secret to Cloudflare ────────────────────────────────────────────────
push_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | npx wrangler secret put "$name"
  echo "  ✓ $name set."
}

# ── ADMIN_TOKEN ────────────────────────────────────────────────────────────────
if [ -n "$ADMIN_TOKEN" ]; then
  echo "▶ ADMIN_TOKEN  (read from .env)"
  push_secret "ADMIN_TOKEN" "$ADMIN_TOKEN"
else
  echo "▶ ADMIN_TOKEN  (not found in .env — enter manually)"
  printf "  Value: "; read -r -s ADMIN_TOKEN; echo ""
  push_secret "ADMIN_TOKEN" "$ADMIN_TOKEN"
fi
echo ""

# ── BACKEND_URL ────────────────────────────────────────────────────────────────
if [ -n "$BACKEND_URL" ]; then
  echo "▶ BACKEND_URL  (read from .env → BACKEND_PUBLIC_URL: $BACKEND_URL)"
  push_secret "BACKEND_URL" "$BACKEND_URL"
else
  echo "▶ BACKEND_URL  (BACKEND_PUBLIC_URL not found in .env — enter manually)"
  printf "  Value (e.g. https://offgrid-trader.fly.dev): "; read -r -s BACKEND_URL; echo ""
  push_secret "BACKEND_URL" "$BACKEND_URL"
fi
echo ""

# ── FLY_API_TOKEN ──────────────────────────────────────────────────────────────
FLY_API_TOKEN="$(get_env CRON_WORKER_FLY_API_TOKEN)"
if [ -n "$FLY_API_TOKEN" ]; then
  echo "▶ FLY_API_TOKEN  (read from .env → CRON_WORKER_FLY_API_TOKEN)"
  push_secret "FLY_API_TOKEN" "$FLY_API_TOKEN"
else
  echo "▶ FLY_API_TOKEN  (CRON_WORKER_FLY_API_TOKEN not found in .env — enter manually)"
  echo "  fly.io app → Settings → Tokens → Create deploy token."
  printf "  Value: "; read -r -s FLY_API_TOKEN; echo ""
  if [ -n "$FLY_API_TOKEN" ]; then
    push_secret "FLY_API_TOKEN" "$FLY_API_TOKEN"
  else
    echo "  ⚠ Skipped (empty)."
  fi
fi
echo ""

# ── FLY_APP ────────────────────────────────────────────────────────────────────
FLY_APP="$(get_env CRON_WORKER_FLY_APP_NAME)"
if [ -n "$FLY_APP" ]; then
  echo "▶ FLY_APP  (read from .env → CRON_WORKER_FLY_APP_NAME: $FLY_APP)"
  push_secret "FLY_APP" "$FLY_APP"
else
  echo "▶ FLY_APP  (CRON_WORKER_FLY_APP_NAME not found in .env — enter manually)"
  printf "  Value [offgrid-trader]: "; read -r FLY_APP; echo ""
  FLY_APP="${FLY_APP:-offgrid-trader}"
  push_secret "FLY_APP" "$FLY_APP"
fi
echo ""

echo "=== All secrets set. Run 'npx wrangler deploy' to deploy. ==="
echo ""
