# offgrid-trader — convenience targets for Docker Compose.
# All compose files live in infra/; the build context is the project root.

COMPOSE := docker compose -f infra/docker-compose.yml

.PHONY: up down build logs infra shell-backend smoke

## Start all services (backend + frontend + aspire)
up:
	$(COMPOSE) up -d

## Start with fresh build
build:
	$(COMPOSE) up --build -d

## Stop all services
down:
	$(COMPOSE) down

## Tail logs (all services)
logs:
	$(COMPOSE) logs -f

## Start shared infrastructure (Ollama + Portainer) — auto-detects GPU
infra:
	bash infra/start-infra.sh

## Open a shell in the running backend container
shell-backend:
	$(COMPOSE) exec backend bash

## Run smoke tests inside the backend container
smoke:
	$(COMPOSE) exec backend python tests/smoke_test.py
