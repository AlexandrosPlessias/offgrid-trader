#!/usr/bin/env bash
# tests/lint/dev_check.sh — local quality gate
#
# Runs on the HOST machine (not inside Docker).
# Called via:  make lint   OR   bash tests/lint/dev_check.sh
#
# Steps:
#   1. Create .venv at the repo root if absent
#   2. pip install from tests/lint/requirements.dev.txt
#   3. Ruff        — fast linter (F/B/S/I/UP/RUF rules → approximates several CodeQL checks)
#   4. Flake8      — classic style + bugbear (B) + bandit (S) plugins
#   5. Black       — format check only, no files modified
#   6. Pytest      — smoke tests (offline, no Docker needed)
#
# Exits 0 only if every step passes; non-zero otherwise.
# All steps always run — failures are collected and shown in a final summary.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # tests/lint/
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"                      # repo root
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
PIP="$VENV/bin/pip"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

hdr()  { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; }

# ── 1. Virtual environment ────────────────────────────────────────────────────
hdr "Setup: virtual environment"
if [ ! -f "$PY" ]; then
    echo "  Creating .venv at $VENV …"
    python3 -m venv "$VENV"
fi
ok "venv ready → $VENV"

# ── 2. Install dev requirements ───────────────────────────────────────────────
hdr "Setup: pip install tests/lint/requirements.dev.txt"
if "$PIP" install -q --upgrade pip && \
   "$PIP" install -r "$SCRIPT_DIR/requirements.dev.txt"; then
    ok "dev requirements installed"
else
    err "pip install failed — check the output above"
    exit 1
fi

cd "$ROOT"

# ── Tool runner ───────────────────────────────────────────────────────────────
# Runs a command without aborting on failure — collects all results first.
FAILED=()
run() {
    local label="$1"; shift
    hdr "$label"
    if "$@"; then
        ok "$label passed"
    else
        err "$label FAILED"
        FAILED+=("$label")
    fi
}

# ── 3. Ruff ───────────────────────────────────────────────────────────────────
# Rule families → CodeQL equivalents:
#   F401          → py/unused-import
#   F841          → py/unused-local-variable
#   B018          → py/ineffectual-statement  (stray `...` outside stubs)
#   B007          → py/unused-local-variable  (loop variable unused)
#   S110          → py/empty-except           (try/except/pass)
#   S105/S106     → py/clear-text-logging-sensitive-data
#   E711/E712     → py/comparison-of-identical-expressions
#   UP (pyupgrade)→ modern Python idioms (avoids CodeQL quality notes)
#   I (isort)     → import ordering
run "Ruff" "$VENV/bin/ruff" check backend/ tests/ \
    --select=E,W,F,B,S,I,C90,UP,RUF \
    --ignore=E203,S101,S311 \
    --line-length=100 \
    --output-format=concise

# ── 4. Flake8 + plugins ───────────────────────────────────────────────────────
# Plugins in requirements.dev.txt:
#   flake8-bugbear → B018 ineffectual stmt, B007 unused loop var, B904 raise-from
#   flake8-bandit  → S110 empty-except, S105/S106 hardcoded credentials
run "Flake8" "$VENV/bin/flake8" backend/ tests/ \
    --max-line-length=100 \
    --extend-ignore=E203,W503 \
    --extend-select=B,S \
    --per-file-ignores="tests/*.py:S101,S311,B backend/main.py:B008"

# ── 5. Black (format check only — no files rewritten) ────────────────────────
run "Black" "$VENV/bin/black" --check --diff --line-length 100 backend/ tests/

# ── 6. Smoke tests ────────────────────────────────────────────────────────────
# smoke_test.py uses sys.exit() directly (not pytest fixtures) so we run it
# as a plain Python script. All backend runtime deps must be in the venv
# (included via -r ../../requirements/backend.txt in requirements.dev.txt).
run "Smoke tests" "$PY" tests/smoke/smoke_test.py

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════${NC}"
if [ "${#FAILED[@]}" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}  All checks passed ✓${NC}"
    exit 0
else
    echo -e "${RED}${BOLD}  Failed: ${FAILED[*]}${NC}"
    echo -e "${DIM}  Fix the issues above, then re-run:  make lint${NC}"
    exit 1
fi
