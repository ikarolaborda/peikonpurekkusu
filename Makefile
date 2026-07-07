# peikonpurekkusu — one-command ecosystem control
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help up down reset logs ps smoke seed infra keys env build

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "✓ created .env from .env.example")

keys: ## Generate dev ES256 signing keys into secrets/
	@bash scripts/gen-keys.sh

up: env keys ## Build and start the full ecosystem (one command)
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  peikonpurekkusu is starting."
	@echo "  App:               http://app.localhost:$${HTTP_PORT:-8088}"
	@echo "  API:               http://api.localhost:$${HTTP_PORT:-8088}"
	@echo "  Traefik dashboard: http://traefik.localhost:$${HTTP_PORT:-8088}  (admin / peikon-dev)"
	@echo ""
	@echo "  make logs   — follow logs"
	@echo "  make smoke  — run the end-to-end smoke test"

infra: env keys ## Start only infrastructure (DBs, Kafka, Redis, Traefik, registry)
	$(COMPOSE) up -d traefik kafka kafka-init apicurio-registry schemas-init \
		redis-session redis-cache \
		users-db account-db payment-db transaction-db fraud-db notification-db audit-db

down: ## Stop everything (keeps data volumes)
	$(COMPOSE) down --remove-orphans

reset: ## Stop everything and DELETE all data volumes
	$(COMPOSE) down --remove-orphans --volumes
	@echo "✓ stack stopped, volumes removed"

logs: ## Follow logs of all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status
	$(COMPOSE) ps

build: ## Rebuild all images
	$(COMPOSE) build

seed: ## Load demo data
	@bash scripts/seed.sh

smoke: ## End-to-end smoke test (login → payment → notification)
	@bash scripts/smoke.sh
