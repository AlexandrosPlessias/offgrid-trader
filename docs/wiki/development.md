# Development Guide

Local development workflow for **MarketSage** — editor setup, linting, testing, and Docker naming conventions.

---

## VS Code setup

Two config files are committed to the repo so the team gets a consistent experience out of the box.

### [`.vscode/extensions.json`](https://github.com/AlexandrosPlessias/offgrid-trader/blob/main/.vscode/extensions.json)

Open the repo in VS Code and you'll get a prompt to install the recommended extensions:

| Extension | ID | Purpose |
|---|---|---|
| Python | `ms-python.python` | IntelliSense, debugger, test runner |
| Black Formatter | `ms-python.black-formatter` | Auto-format on save |
| Flake8 | `ms-python.flake8` | Inline style + bugbear warnings |
| Ruff | `charliermarsh.ruff` | Fast linter (replaces many Flake8 plugins inline) |
| Even Better TOML | `tamasfe.even-better-toml` | `pyproject.toml` support |
| Docker | `ms-azuretools.vscode-docker` | Compose file editing + container explorer |
| GitLens | `eamodio.gitlens` | Enhanced Git history and blame |

Install all at once via the VS Code command palette:
> **Extensions: Show Recommended Extensions** → Install All

### [`.vscode/settings.json`](https://github.com/AlexandrosPlessias/offgrid-trader/blob/main/.vscode/settings.json)

Key settings applied automatically when you open the repo:

| Setting | Value | Why |
|---|---|---|
| Default formatter | Black | Consistent formatting; no arguments needed |
| Format on save | `true` | Code is always Black-formatted before commit |
| Black line length | `100` | Project standard (80 is the soft guide, 100 is the hard limit) |
| Flake8 max line length | `100` | Matches Black |
| Flake8 ignore | `E203, W503` | E203 conflicts with Black slice formatting; W503 is superseded by W504 |
| Flake8 select | `B, S` | Bugbear (B) + Bandit security (S) plugins |
| Ruff select | `E,W,F,B,S,I,C90,UP,RUF` | All meaningful rule families |
| Ruff ignore | `E203` | Same Black-compat exclusion |
| Pylance type checking | `basic` | Catches undefined names and unused imports at edit time |
| Rulers | 80 (faint white) · 100 (red tint) | Visual guides — soft limit at 80, hard limit at 100 |

The two ruler lines give you an at-a-glance measure of line length without blocking anything:
- **80-char ruler** — faint white: aim to stay under this; shorter lines are easier to review
- **100-char ruler** — red tint: the formatter will enforce this; crossing it causes a CI failure

---

## Local quality gate — `make lint`

`make lint` runs on the **host machine** (no Docker needed). It installs everything into `.venv/` and runs four checks in order:

```bash
make lint
```

### What it runs

```
── Setup: virtual environment ──────────────────────
  ✓ venv ready → /home/.../offgrid-trader/.venv

── Setup: pip install tests/lint/requirements.dev.txt ──
  ✓ dev requirements installed

── Ruff ────────────────────────────────────────────
  → ruff check backend/ tests/ --select=E,W,F,B,S,I,C90,UP,RUF ...
  ✓ Ruff passed

── Flake8 ──────────────────────────────────────────
  → flake8 backend/ tests/ --max-line-length=100 ...
  ✓ Flake8 passed

── Black ───────────────────────────────────────────
  → black --check --diff --line-length 100 backend/ tests/
  ✓ Black passed

── Smoke tests ─────────────────────────────────────
  → python tests/smoke/smoke_test.py
  ✓ Smoke tests passed

═══════════════════════════════════════
  All checks passed ✓
```

All steps always run even if an earlier step fails — failures are collected and shown in a final summary. Exit code is 0 only if all four pass.

### Rule families and CodeQL equivalents

| Tool | Rules | CodeQL equivalent |
|---|---|---|
| Ruff F401 | unused imports | `py/unused-import` |
| Ruff F821 | undefined names | `py/undefined-name` |
| Ruff B904 | `raise` without `from` | `py/reraise-without-cause` |
| Ruff S110 | `try/except/pass` | `py/empty-except` |
| Ruff S105/S106 | hardcoded credentials | `py/clear-text-logging-sensitive-data` |
| Ruff UP | pyupgrade modern idioms | CodeQL quality notes |
| Ruff C90 | complexity | `py/too-many-statements` |
| Ruff RUF001/RUF002 | ambiguous Unicode | — |
| Flake8-Bugbear B008 | function call in default arg | — |
| Flake8-Bandit S | security patterns | multiple CodeQL security queries |

### Dev requirements

[`tests/lint/requirements.dev.txt`](https://github.com/AlexandrosPlessias/offgrid-trader/blob/main/tests/lint/requirements.dev.txt) is the single place to pin linting tool versions:

```
-r ../../requirements/backend.txt   # runtime deps (needed by smoke tests)
pytest>=8.0
pytest-asyncio>=0.23
ruff>=0.4
flake8>=7.0
flake8-bugbear>=24.0
flake8-bandit>=4.1
black>=24.0
```

Deps are installed into `.venv/` at the repo root. The venv is created by the script if absent — you never need to run `python -m venv` manually.

---

## Test layout

```
tests/
├── smoke/
│   └── smoke_test.py        ← offline unit/integration checks (no Docker, no live APIs)
└── lint/
    ├── dev_check.sh          ← the script make lint calls
    └── requirements.dev.txt  ← pinned versions of all dev tools
```

### Smoke tests (`make smoke`)

Run **inside the Docker container** after the stack is up:

```bash
make smoke
# expands to: docker compose -f infra/docker-compose.yml exec backend python tests/smoke/smoke_test.py
```

Checks that modules import, config resolves, DB initialises, and core logic (opportunity detection, memory layer, prompt builder) works end-to-end without touching live APIs.

### Lint tests (`make lint`)

Run on the **host machine** — no Docker needed:

```bash
make lint
# expands to: bash tests/lint/dev_check.sh
```

---

## Docker naming

After renaming the project, all resources are consistently prefixed `offgrid-trader`:

| Resource | Name |
|---|---|
| Project | `offgrid-trader` (set via `name:` in `infra/docker-compose.yml`) |
| Backend image | `offgrid-trader-backend:latest` |
| Frontend image | `offgrid-trader-frontend:latest` |
| Backend container | `offgrid-trader-backend-1` |
| Frontend container | `offgrid-trader-frontend-1` |
| Aspire container | `offgrid-trader-aspire-1` |
| App network | `offgrid-trader_offgrid-net` |
| Shared infra network | `ai-shared` (Ollama + Portainer; managed by `docker-compose.infra.yml`) |

The shared infrastructure (`make infra`) uses its own project name `ai-shared` so Ollama and Portainer are usable by other local AI projects without running duplicates.

### One-time migration note

If you had an older stack running (images named `infra-backend`, network `infra_offgrid-net`):

```bash
make down                                    # stop old stack
docker rm -f infra-backend-1 infra-frontend-1 aspire-offgrid 2>/dev/null || true
make build                                   # build + start with new names
```

---

## Makefile quick reference

```
make infra          start Docker (WSL2) + shared Ollama + Portainer
make up             start MarketSage (backend + frontend + aspire)
make build          rebuild images then start (use after code changes)
make down           stop MarketSage; prompts to also stop shared infra + Docker
make logs           tail logs for all MarketSage services
make smoke          run offline smoke tests inside the backend container
make lint           run local quality gate: ruff → flake8 → black → smoke tests
make shell-backend  open a bash shell inside the running backend container
```

After `make up` or `make build` a URL table is printed automatically:

```
  ┌─────────────────────────────────────────────────────────────┐
  │  MarketSage — running                                       │
  ├──────────────────┬──────────────────────────────────────────┤
  │  Frontend (UI)   │  http://localhost:5174                   │
  │  Backend API     │  http://localhost:8010                   │
  │  API Docs        │  http://localhost:8010/docs              │
  │  Aspire          │  http://localhost:18889                  │
  │  Portainer       │  http://localhost:9000                   │
  └──────────────────┴──────────────────────────────────────────┘
```

---

## PR / CI notes

The CodeQL workflow runs on every PR to `main`. It checks the same rule families that `make lint` approximates locally. Running `make lint` before pushing catches the vast majority of CodeQL findings before they hit the PR.

Security-critical patterns fixed in this codebase:
- **`py/log-injection`** — all ticker strings are sanitised with `.replace("\n","").replace("\r","")` before being passed to `logging.*` calls. CodeQL only recognises the string-literal `.replace()` chain, not compiled-regex substitution.
- **`py/empty-except`** — `try/except/pass` blocks have `# noqa: S110` with an explanatory comment.
