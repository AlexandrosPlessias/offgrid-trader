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
command -v node   >/dev/null 2>&1 || fail "node not found. Install Node.js first."

# Resolve a direct (non-npx) vercel binary so the Vercel MCP plugin cannot
# intercept the call and cause a freeze.  Prefer a globally-installed binary;
# install one if absent.
if command -v vercel >/dev/null 2>&1; then
  VERCEL="vercel"
else
  info "vercel not found globally — installing (one-time)..."
  npm install -g vercel --silent
  VERCEL="vercel"
fi

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

# Vercel CLI v39+ no longer reads the stored session token automatically when
# running non-interactively.  Preference order:
#   1. VERCEL_TOKEN env var (a long-lived API token from vercel.com/account/tokens)
#   2. CLI session token written by `vercel login` (short-lived; may expire)
# If the stored session token is expired the script fails with clear instructions
# rather than a cryptic "token not valid" error from the Vercel CLI.
if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  AUTH_FILE="${HOME}/.local/share/com.vercel.cli/auth.json"
  if [[ -f "$AUTH_FILE" ]]; then
    VERCEL_TOKEN=$(python3 -c "import json,sys; print(json.load(open('${AUTH_FILE}'))['token'])")
    # Validate expiry stored in auth.json.
    # Vercel CLI writes expiresAt as epoch-seconds (9–10 digits).
    # Older/broken installs sometimes wrote epoch-milliseconds (13 digits).
    # Detect by magnitude: values < 1e12 are seconds, otherwise milliseconds.
    # A zero or missing expiresAt is treated as already-expired.
    EXPIRED=$(python3 -c "
import json, time
d = json.load(open('${AUTH_FILE}'))
raw = d.get('expiresAt', 0)
exp = raw if raw < 1e12 else raw / 1000   # auto-detect seconds vs ms
print('yes' if exp < time.time() else 'no')
")
    if [[ "$EXPIRED" == "yes" ]]; then
      echo
      echo -e "${RED}✗ Vercel session token has expired.${NC}"
      echo "  Fix (choose one):"
      echo "  a) Re-authenticate:  vercel login"
      echo "     Then re-run:      make deploy"
      echo "  b) Create a permanent API token at https://vercel.com/account/tokens"
      echo "     Then export it:   export VERCEL_TOKEN=<your-token>"
      echo "     Then re-run:      make deploy"
      exit 1
    fi
    export VERCEL_TOKEN
    info "Using Vercel session token from ${AUTH_FILE}"
  else
    fail "No VERCEL_TOKEN env var and no saved Vercel auth at ${AUTH_FILE}. Run: vercel login"
  fi
fi

# Validate the token works before attempting the full deploy.
if ! "$VERCEL" whoami --token="$VERCEL_TOKEN" &>/dev/null; then
  echo -e "${RED}✗ Vercel token rejected by the API.${NC}"
  echo "  Run 'vercel login' to refresh your session, or set VERCEL_TOKEN to a"
  echo "  long-lived API token from https://vercel.com/account/tokens"
  exit 1
fi

cd frontend
# Two-step local deploy:
#   1. Pull production env vars (VITE_API_URL etc.) so the build on Vercel's
#      side picks up the right values — fast, never hangs.
#   2. Deploy source to Vercel — Vercel builds on their infrastructure,
#      which avoids running `vercel build` locally (that step runs npm install
#      inside Vercel's wrapper and frequently freezes on developer machines).
# The GHA workflow uses the pull→build→deploy-prebuilt pattern because GitHub
# Actions runners are clean and fast; locally the simpler pull→deploy is fine.
"$VERCEL" pull --yes --environment=production --token="$VERCEL_TOKEN"
DEPLOY_URL=$("$VERCEL" deploy --prod --token="$VERCEL_TOKEN" 2>&1 | grep -o 'https://[^ ]*\.vercel\.app' | tail -1)
cd ..
FRONTEND_URL="${DEPLOY_URL:-https://offgrid-trader.vercel.app}"
ok "Frontend deployed → ${FRONTEND_URL}"

echo
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deployment complete ✓${NC}"
echo -e "${GREEN}  Backend  → https://${FLY_APP}.fly.dev${NC}"
echo -e "${GREEN}  Frontend → ${FRONTEND_URL}${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
