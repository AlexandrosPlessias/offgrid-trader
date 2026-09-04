#!/usr/bin/env bash
# scripts/setup-gh-secrets.sh
#
# Sets all GitHub Actions secrets needed for .github/workflows/deploy.yml.
# Run this once after `fly apps create` and `cd frontend && vercel link`.
#
# Prerequisites (must all be authenticated before running):
#   - flyctl   https://fly.io/docs/flyctl/install/
#   - vercel   npm install -g vercel && vercel login
#   - gh       https://cli.github.com/  (gh auth login)
#   - jq       brew install jq / apt install jq
#
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "Setting GitHub Actions secrets for: $REPO"
echo

# ── Fly.io deploy token ──────────────────────────────────────────────────────
echo "→ Creating Fly.io deploy token (1-year expiry)…"
# --quiet is not available in all flyctl versions; strip the status line with grep instead
FLY_API_TOKEN=$(flyctl tokens create deploy --expiry 8760h 2>/dev/null | grep -v '^[[:space:]]*$' | tail -1)
gh secret set FLY_API_TOKEN --body "$FLY_API_TOKEN" --repo "$REPO"
echo "  ✓ FLY_API_TOKEN"

# ── Vercel project IDs ───────────────────────────────────────────────────────
VERCEL_JSON="frontend/.vercel/project.json"
if [[ ! -f "$VERCEL_JSON" ]]; then
  echo
  echo "ERROR: $VERCEL_JSON not found."
  echo "       Run: cd frontend && npx vercel link"
  exit 1
fi
VERCEL_ORG_ID=$(jq -r '.orgId'     "$VERCEL_JSON")
VERCEL_PROJECT_ID=$(jq -r '.projectId' "$VERCEL_JSON")
gh secret set VERCEL_ORG_ID     --body "$VERCEL_ORG_ID"     --repo "$REPO"
gh secret set VERCEL_PROJECT_ID --body "$VERCEL_PROJECT_ID" --repo "$REPO"
echo "  ✓ VERCEL_ORG_ID / VERCEL_PROJECT_ID"

# ── Vercel personal access token ─────────────────────────────────────────────
echo
echo "Vercel personal access token cannot be read back from the CLI."
echo "Create one at: https://vercel.com/account/tokens"
read -rsp "Paste token here (input hidden): " VERCEL_TOKEN
echo
gh secret set VERCEL_TOKEN --body "$VERCEL_TOKEN" --repo "$REPO"
echo "  ✓ VERCEL_TOKEN"

echo
echo "All secrets set. Verify with:"
echo "  gh secret list --repo $REPO"
