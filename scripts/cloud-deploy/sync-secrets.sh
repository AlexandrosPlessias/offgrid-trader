#!/usr/bin/env bash
# scripts/cloud-deploy/sync-secrets.sh — push local .env values into Fly.io secrets
#
# Mirrors the runtime config/credentials from your local .env into Fly secrets so
# the cloud app (which never reads your local .env) has the same notification
# channels, API keys, watchlist, thresholds, etc.
#
# Infrastructure variables that Fly / fly.toml must own are EXCLUDED (see DENYLIST)
# so this never clobbers the cloud DB path, CORS origins, Ollama host, or the ntfy
# sidecar URLs.
#
# Usage:
#   make fly-secrets                              # recommended
#   bash scripts/cloud-deploy/sync-secrets.sh     # direct
#   bash scripts/cloud-deploy/sync-secrets.sh --dry-run   # preview keys only
#
# Applies all changes in a single `fly secrets import` (one machine restart).
set -euo pipefail

FLY_APP="offgrid-trader"
ENV_FILE=".env"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}! $*${NC}"; }
fail()  { echo -e "${RED}✗ $*${NC}"; exit 1; }

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

command -v flyctl >/dev/null 2>&1 || fail "flyctl not found. Install: curl -L https://fly.io/install.sh | sh"
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found. Run from the repo root."

# Keys Fly / fly.toml owns — never mirror these from local .env.
DENYLIST="DATABASE_PATH CORS_ORIGINS OLLAMA_HOST OLLAMA_MODEL OLLAMA_TIMEOUT LLM_PROVIDER NTFY_SERVER NTFY_BASE_URL BACKEND_PUBLIC_URL OTEL_EXPORTER_OTLP_ENDPOINT"

is_denied() {
  for d in $DENYLIST; do [[ "$1" == "$d" ]] && return 0; done
  return 1
}

# Build the KEY=VALUE payload from .env, skipping comments, blanks, and denylist.
payload=""
keys=""
while IFS= read -r line || [[ -n "$line" ]]; do
  # strip leading whitespace
  line="${line#"${line%%[![:space:]]*}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  # trim spaces around key
  key="$(echo "$key" | tr -d '[:space:]')"
  is_denied "$key" && continue
  payload+="${line}"$'\n'
  keys+="  • ${key}"$'\n'
done < "$ENV_FILE"

[[ -z "$payload" ]] && fail "No eligible variables found in $ENV_FILE."

echo -e "${CYAN}Will mirror these keys → Fly app '${FLY_APP}':${NC}"
echo -e "$keys"
echo -e "${YELLOW}Excluded (Fly/fly.toml owns): ${DENYLIST}${NC}"

if [[ "$DRY_RUN" == "true" ]]; then
  warn "Dry run — no secrets were set."
  exit 0
fi

info "Importing into Fly secrets (single restart)..."
printf '%s' "$payload" | flyctl secrets import -a "$FLY_APP"
ok "Secrets synced. Fly will restart the machine to apply them."
echo -e "${CYAN}Tip:${NC} verify with  flyctl secrets list -a ${FLY_APP}"
