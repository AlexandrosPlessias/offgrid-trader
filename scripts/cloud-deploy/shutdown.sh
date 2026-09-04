#!/usr/bin/env bash
# scripts/cloud-deploy/shutdown.sh — take the app offline
#
# Backend  — stops all Fly.io machines (reversible; fly.toml keeps min_machines_running=0
#             so they won't auto-restart; run deploy.sh / make deploy to restore).
# Frontend — removes the current Vercel production deployment (the project and all
#             config are kept; run make deploy to redeploy).
#
# Usage:
#   make shutdown                              # recommended
#   bash scripts/cloud-deploy/shutdown.sh     # direct
#
# Must be run from the repo root.
set -euo pipefail

FLY_APP="offgrid-trader"
VERCEL_PROJECT="offgrid-trader"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
fail()  { echo -e "${RED}✗ $*${NC}"; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
command -v flyctl >/dev/null 2>&1 || fail "flyctl not found. Install: curl -L https://fly.io/install.sh | sh"
command -v npx    >/dev/null 2>&1 || fail "npx not found. Install Node.js first."

# ── Confirm ───────────────────────────────────────────────────────────────────
echo
echo -e "${YELLOW}This will stop the backend and remove the Vercel production deployment.${NC}"
echo -e "${YELLOW}Run deploy.sh to bring everything back online.${NC}"
echo
read -rp "Proceed? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── 1. Stop Fly.io machines ───────────────────────────────────────────────────
echo
info "Stopping all Fly.io machines for app: ${FLY_APP}"
# scale count 0 is the idiomatic way to stop all machines cleanly.
# fly.toml already has min_machines_running = 0, so they won't auto-restart.
flyctl scale count 0 -a "$FLY_APP" --yes 2>&1 || {
    # Fallback: stop each machine individually via jq if scale fails
    warn "scale count 0 failed — trying per-machine stop..."
    flyctl machine list -a "$FLY_APP" --json 2>/dev/null \
        | jq -r '.[].id' \
        | while read -r machine_id; do
            echo "  stopping machine $machine_id..."
            flyctl machine stop "$machine_id" -a "$FLY_APP" || true
        done
}
ok "All backend machines stopped — backend is offline"

# ── 2. Remove Vercel production deployment ────────────────────────────────────
echo
info "Removing Vercel production deployment for project: ${VERCEL_PROJECT}"
# Get the current production deployment URL
PROD_URL=$(npx vercel ls "$VERCEL_PROJECT" --prod 2>/dev/null \
    | grep "https://" | head -1 | awk '{print $1}' || true)

if [[ -n "$PROD_URL" ]]; then
    echo "  removing deployment: $PROD_URL"
    npx vercel remove "$PROD_URL" --yes 2>/dev/null || warn "Could not remove deployment — may need 'npx vercel login'"
    ok "Vercel production deployment removed — frontend is offline"
else
    warn "No production deployment found (may already be offline)"
fi

echo
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Shutdown complete ✓${NC}"
echo -e "${GREEN}  Backend:  offline (Fly machines stopped)${NC}"
echo -e "${GREEN}  Frontend: offline (Vercel deployment removed)${NC}"
echo -e "${GREEN}  To restore: make deploy${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
