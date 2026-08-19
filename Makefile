# offgrid-trader — convenience targets for Docker Compose.
# All compose files live in infra/; the build context is the project root.
#
# Typical session (WSL2):
#   make infra      ← starts Docker service + Ollama + Portainer
#   make up         ← starts MarketSage
#   ...use the app...
#   make down       ← stops everything + Docker service

COMPOSE       := docker compose -f infra/docker-compose.yml
INFRA_COMPOSE := docker compose -f infra/docker-compose.infra.yml

.PHONY: up down build logs infra shell-backend smoke lint

# ── Helper: print useful URLs after the stack starts ─────────────────────────
define print_urls
	@echo ""
	@echo "  ┌─────────────────────────────────────────────────────────────┐"
	@echo "  │  MarketSage — running                                       │"
	@echo "  ├──────────────────┬──────────────────────────────────────────┤"
	@echo "  │  Frontend (UI)   │  http://localhost:5174                   │"
	@echo "  │  Backend API     │  http://localhost:8010                   │"
	@echo "  │  API Docs        │  http://localhost:8010/docs              │"
	@echo "  │  Aspire          │  http://localhost:18889                  │"
	@echo "  │  Portainer       │  http://localhost:9000                   │"
	@echo "  └──────────────────┴──────────────────────────────────────────┘"
	@echo ""
endef

# ── Helper: start Docker service on WSL2 / Linux if not already running ──────
define docker_start
	@if uname -r 2>/dev/null | grep -qi microsoft; then \
	  if ! docker info > /dev/null 2>&1; then \
	    echo "→ Starting Docker service (WSL2)..."; \
	    sudo service docker start; \
	    echo "→ Waiting for Docker to be ready..."; \
	    until docker info > /dev/null 2>&1; do sleep 1; printf "."; done; \
	    echo ""; \
	    echo "✓ Docker is running"; \
	  else \
	    echo "✓ Docker already running"; \
	  fi \
	fi
endef

# ── Helper: stop Docker service on WSL2 / Linux ──────────────────────────────
define docker_stop
	@if uname -r 2>/dev/null | grep -qi microsoft; then \
	  echo "→ Stopping Docker service (WSL2)..."; \
	  sudo service docker stop; \
	  echo "✓ Docker stopped — RAM freed"; \
	fi
endef

## Start Docker (WSL2), then shared infra: Ollama + Portainer (auto-detects GPU)
infra:
	$(call docker_start)
	bash infra/start-infra.sh

## Start MarketSage services (backend + frontend + aspire). Run `make infra` first.
up:
	$(COMPOSE) up -d
	$(call print_urls)

## Rebuild images then start (use after any code change)
build:
	$(COMPOSE) up --build -d
	$(call print_urls)

## Stop MarketSage; optionally stop shared infra + Docker service (WSL2)
down:
	-$(COMPOSE) down
	@printf "Stop shared infra (Ollama + Portainer)? [y/N] " && read ans && \
	case "$$ans" in \
	  [yY]*) \
	    docker compose -f infra/docker-compose.infra.yml down; \
	    if uname -r 2>/dev/null | grep -qi microsoft; then \
	      echo "→ Stopping Docker service (WSL2)..."; \
	      sudo service docker stop; \
	      echo "✓ Docker stopped — RAM freed"; \
	    fi \
	  ;; \
	  *) echo "Shared infra left running." ;; \
	esac

## Tail logs for all MarketSage services
logs:
	$(COMPOSE) logs -f

## Open a bash shell inside the running backend container
shell-backend:
	$(COMPOSE) exec backend bash

## Run offline smoke tests inside the backend container
smoke:
	$(COMPOSE) exec backend python tests/smoke/smoke_test.py

## Run local quality gate: venv setup → ruff → flake8 → black --check → pytest
## Runs on the HOST (no Docker needed) — mirrors what CodeQL checks on the PR.
## Deps auto-installed from tests/lint/requirements.dev.txt into .venv
lint:
	@bash tests/lint/dev_check.sh
