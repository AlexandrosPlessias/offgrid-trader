#!/usr/bin/env bash
# scripts/cloud-deploy/deploy.sh — go live
#
# Deploys backend (Fly.io) and frontend (Vercel) to production in sequence.
#
# Usage:
#   make deploy                              # recommended
#   bash scripts/cloud-deploy/deploy.sh     # direct
#
# Prerequisites (one-time setup — see docs/wiki/cloud-hosting.md):
#   flyctl auth login          (or set FLY_API_TOKEN in environment)
#   vercel login
#   cd frontend && npx vercel link
#   npx vercel env add VITE_API_URL production   # set to https://<app>.fly.dev
#
# Must be run from the repo root (where fly.toml lives).
set -euo pipefail

FLY_APP="offgrid-trader"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
fail()  { echo -e "${RED}✗ $*${NC}"; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
command -v flyctl >/dev/null 2>&1 || fail "flyctl not found. Install: curl -L https://fly.io/install.sh | sh"
command -v npx    >/dev/null 2>&1 || fail "npx not found. Install Node.js first."
npx vercel --version >/dev/null 2>&1 || fail "vercel package unavailable via npx. Run: npm install -g vercel"

[[ -f fly.toml ]] || fail "fly.toml not found — run this script from the repo root."
[[ -f frontend/.vercel/project.json ]] || fail "frontend/.vercel/project.json not found. Run: cd frontend && npx vercel link"

# ── 1. Backend → Fly.io ───────────────────────────────────────────────────────
echo
info "Deploying backend → Fly.io (app: ${FLY_APP})"
flyctl deploy --remote-only -a "$FLY_APP"
ok "Backend deployed → https://${FLY_APP}.fly.dev"

# ── Quick health check ────────────────────────────────────────────────────────
info "Checking backend health..."
for i in 1 2 3 4 5; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://${FLY_APP}.fly.dev/health" || true)
    if [[ "$STATUS" == "200" ]]; then
        ok "Backend is healthy (/health → 200)"
        break
    fi
    echo "  attempt $i/5 — got $STATUS, retrying in 5s..."
    sleep 5
done

# ── 2. Frontend → Vercel ──────────────────────────────────────────────────────
echo
info "Deploying frontend → Vercel"
cd frontend
# Vercel CLI prints a hash deployment URL during build; the clean production alias
# (offgrid-trader.vercel.app) is updated automatically once the deploy succeeds.
npx vercel deploy --prod
# Read the production alias from the project — avoids parsing the hash URL from stdout.
PROD_DOMAIN=$(npx vercel alias ls 2>/dev/null \
    | grep -v "^source" \
    | awk '{print $2}' \
    | grep -v "vercel\.app.*vercel\.app" \
    | grep "\.vercel\.app$" \
    | head -1)
cd ..
FRONTEND_URL="https://${PROD_DOMAIN:-offgrid-trader.vercel.app}"
ok "Frontend deployed → ${FRONTEND_URL}"

echo
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deployment complete ✓${NC}"
echo -e "${GREEN}  Backend  → https://${FLY_APP}.fly.dev${NC}"
echo -e "${GREEN}  Frontend → ${FRONTEND_URL}${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
