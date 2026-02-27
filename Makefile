# =============================================================================
# MCP Proxy — Makefile
# =============================================================================
# Usage:
#   make              → show this help
#   make install      → install dependencies
#   make dev          → start dev server (hot-reload, demo config)
#   make test         → run all 102 tests
#   make demo         → run the interactive end-to-end demo
#   make ci           → full CI pipeline (install → typecheck → test)
#
# All port/path defaults can be overridden inline:
#   make dev PORT=4000
#   make dev MCP_CONFIG_PATH=config/tools.yaml
#   make demo DEMO_PORT=4321
# =============================================================================

# ── Tool paths ────────────────────────────────────────────────────────────────
NODE     := node
NPM      := npm
TSX      := npx tsx
VITEST   := npx vitest

# ── Runtime defaults (all overridable from the command line) ──────────────────
PORT             ?= 3000
DEMO_PORT        ?= 3001
MCP_CONFIG_PATH  ?= config/demo.yaml
PROXY_API_KEY    ?=

# ── Output directories ────────────────────────────────────────────────────────
DIST_DIR      := dist
COVERAGE_DIR  := coverage

# ── ANSI colour codes (no-op when output is not a terminal) ──────────────────
BOLD   := \033[1m
DIM    := \033[2m
GREEN  := \033[0;32m
CYAN   := \033[0;36m
YELLOW := \033[0;33m
RED    := \033[0;31m
RESET  := \033[0m

# =============================================================================
# Meta
# =============================================================================

.DEFAULT_GOAL := help
.PHONY: help

## help : Show this help message (default target)
help:
	@echo ""
	@printf "$(BOLD)$(CYAN)  MCP Proxy$(RESET)  —  available targets\n"
	@echo ""
	@printf "$(BOLD)  %-22s  %s$(RESET)\n" "Target" "Description"
	@printf "  %-22s  %s\n"   "──────────────────────" "──────────────────────────────────────────────"
	@awk 'BEGIN { FS=":.*##" } \
	     /^## / { section=$$0; sub(/^## /,"",section); printf "\n$(DIM)  %s$(RESET)\n", section } \
	     /^[a-zA-Z_-]+:.*?##/ { printf "  $(CYAN)%-22s$(RESET) %s\n", $$1, $$2 }' \
	     $(MAKEFILE_LIST)
	@echo ""

# =============================================================================
## Setup
# =============================================================================

.PHONY: install

## install : Install all npm dependencies
install: ## Install all npm dependencies
	@printf "$(BOLD)Installing dependencies…$(RESET)\n"
	$(NPM) install
	@printf "$(GREEN)✓ Dependencies installed$(RESET)\n"

# =============================================================================
## Development
# =============================================================================

.PHONY: dev dev-auth

## dev : Start dev server with hot-reload  (MCP_CONFIG_PATH, PORT)
dev: ## Start dev server with hot-reload  (MCP_CONFIG_PATH, PORT)
	@printf "$(BOLD)Starting dev server$(RESET)  config=$(YELLOW)$(MCP_CONFIG_PATH)$(RESET)  port=$(YELLOW)$(PORT)$(RESET)\n"
	PORT=$(PORT) MCP_CONFIG_PATH=$(MCP_CONFIG_PATH) $(TSX) watch src/local.ts

## dev-auth : Start dev server with PROXY_API_KEY=dev-secret
dev-auth: ## Start dev server with PROXY_API_KEY=dev-secret
	@printf "$(BOLD)Starting dev server$(RESET)  auth=$(YELLOW)ENABLED$(RESET)  port=$(YELLOW)$(PORT)$(RESET)\n"
	PORT=$(PORT) MCP_CONFIG_PATH=$(MCP_CONFIG_PATH) PROXY_API_KEY=dev-secret $(TSX) watch src/local.ts

# =============================================================================
## Build
# =============================================================================

.PHONY: build clean

## build : Compile TypeScript → dist/
build: ## Compile TypeScript → dist/
	@printf "$(BOLD)Compiling TypeScript…$(RESET)\n"
	$(NPM) run build
	@printf "$(GREEN)✓ Build complete  →  $(DIST_DIR)/$(RESET)\n"

## clean : Remove dist/, coverage/, and temp files
clean: ## Remove dist/, coverage/, and temp files
	@printf "$(BOLD)Cleaning…$(RESET)\n"
	rm -rf $(DIST_DIR) $(COVERAGE_DIR) .nyc_output
	find . -name "*.tsbuildinfo" -delete 2>/dev/null || true
	@printf "$(GREEN)✓ Cleaned$(RESET)\n"

# =============================================================================
## Production
# =============================================================================

.PHONY: start start-auth

## start : Build then start the production server  (PORT, MCP_CONFIG_PATH)
start: build ## Build then start the production server  (PORT, MCP_CONFIG_PATH)
	@printf "$(BOLD)Starting production server$(RESET)  port=$(YELLOW)$(PORT)$(RESET)\n"
	PORT=$(PORT) MCP_CONFIG_PATH=$(MCP_CONFIG_PATH) $(NODE) $(DIST_DIR)/local.js

## start-auth : Build then start with PROXY_API_KEY  (must export PROXY_API_KEY first)
start-auth: build ## Build then start with PROXY_API_KEY  (must export PROXY_API_KEY first)
	@if [ -z "$$PROXY_API_KEY" ]; then \
	  printf "$(RED)✗ PROXY_API_KEY is not set. Export it first:$(RESET)\n"; \
	  printf "  $(YELLOW)export PROXY_API_KEY=your-secret && make start-auth$(RESET)\n"; \
	  exit 1; \
	fi
	@printf "$(BOLD)Starting production server$(RESET)  auth=$(YELLOW)ENABLED$(RESET)  port=$(YELLOW)$(PORT)$(RESET)\n"
	PORT=$(PORT) MCP_CONFIG_PATH=$(MCP_CONFIG_PATH) $(NODE) $(DIST_DIR)/local.js

# =============================================================================
## Testing
# =============================================================================

.PHONY: test test-unit test-e2e test-watch test-coverage

## test : Run the full test suite (unit + E2E)
test: ## Run the full test suite (unit + E2E)
	@printf "$(BOLD)Running all tests…$(RESET)\n"
	$(VITEST) run --reporter=verbose

## test-unit : Run unit tests only  (tests/unit/)
test-unit: ## Run unit tests only  (tests/unit/)
	@printf "$(BOLD)Running unit tests…$(RESET)\n"
	$(VITEST) run --reporter=verbose tests/unit

## test-e2e : Run E2E tests only  (tests/e2e/)
test-e2e: ## Run E2E tests only  (tests/e2e/)
	@printf "$(BOLD)Running E2E tests…$(RESET)\n"
	$(VITEST) run --reporter=verbose tests/e2e

## test-watch : Run tests in interactive watch mode
test-watch: ## Run tests in interactive watch mode
	$(VITEST)

## test-coverage : Run tests and generate an HTML coverage report
test-coverage: ## Run tests and generate an HTML coverage report
	@printf "$(BOLD)Running tests with coverage…$(RESET)\n"
	$(VITEST) run --coverage
	@printf "$(GREEN)✓ Coverage report  →  $(COVERAGE_DIR)/$(RESET)\n"

# =============================================================================
## Type Checking
# =============================================================================

.PHONY: typecheck

## typecheck : Check TypeScript types without emitting files
typecheck: ## Check TypeScript types without emitting files
	@printf "$(BOLD)Type-checking…$(RESET)\n"
	$(NPM) run typecheck
	@printf "$(GREEN)✓ No type errors$(RESET)\n"

# =============================================================================
## Demo
# =============================================================================

.PHONY: demo demo-auth

## demo : Run the interactive end-to-end demo  (real APIs, no auth)
demo: ## Run the interactive end-to-end demo  (real APIs, no auth)
	@printf "$(BOLD)Running E2E demo$(RESET)  config=$(YELLOW)$(MCP_CONFIG_PATH)$(RESET)  port=$(YELLOW)$(DEMO_PORT)$(RESET)\n"
	PORT=$(DEMO_PORT) $(NODE) scripts/demo.mjs

## demo-auth : Same as demo but with PROXY_API_KEY=demo-key-123
demo-auth: ## Same as demo but with PROXY_API_KEY=demo-key-123
	@printf "$(BOLD)Running E2E demo$(RESET)  auth=$(YELLOW)ENABLED$(RESET)  port=$(YELLOW)$(DEMO_PORT)$(RESET)\n"
	PORT=$(DEMO_PORT) PROXY_API_KEY=demo-key-123 $(NODE) scripts/demo.mjs

# =============================================================================
## Deployment
# =============================================================================

.PHONY: deploy deploy-dry

## deploy : Build and deploy to AWS Lambda via Serverless Framework
deploy: ## Build and deploy to AWS Lambda via Serverless Framework
	@printf "$(BOLD)Building and deploying to AWS Lambda…$(RESET)\n"
	@if [ -z "$$AWS_PROFILE" ] && [ -z "$$AWS_ACCESS_KEY_ID" ]; then \
	  printf "$(YELLOW)⚠  No AWS credentials detected. Set AWS_PROFILE or AWS_ACCESS_KEY_ID.$(RESET)\n"; \
	fi
	$(NPM) run deploy
	@printf "$(GREEN)✓ Deployed$(RESET)\n"

## deploy-dry : Show what Serverless would deploy without actually deploying
deploy-dry: build ## Show what Serverless would deploy without actually deploying
	npx serverless package

# =============================================================================
## CI / Composite targets
# =============================================================================

.PHONY: ci check all

## ci : Full CI pipeline — install → typecheck → test
ci: install typecheck test ## Full CI pipeline — install → typecheck → test
	@echo ""
	@printf "$(BOLD)$(GREEN)  ✓ CI pipeline passed$(RESET)\n"
	@echo ""

## check : Typecheck + full test suite (no install)
check: typecheck test ## Typecheck + full test suite (no install)
	@printf "$(GREEN)✓ All checks passed$(RESET)\n"

## all : Clean, install, build, typecheck, and test
all: clean install build typecheck test ## Clean, install, build, typecheck, and test
	@echo ""
	@printf "$(BOLD)$(GREEN)  ✓ Full pipeline complete$(RESET)\n"
	@echo ""
