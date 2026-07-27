#!/usr/bin/env bash

#
# Common library for EduMind production management scripts.
#

set -euo pipefail

################################################################################
# Directories
################################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# common.sh is located in deploy/prod/scripts/lib/
LIB_DIR="$SCRIPT_DIR"
SCRIPTS_DIR="$(cd "$LIB_DIR/.." && pwd)"
PROD_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROD_DIR/../.." && pwd)"

################################################################################
# Compose configuration
################################################################################

COMPOSE_FILE="$PROD_DIR/docker-compose.prod.yml"
ENV_FILE="$PROD_DIR/.env.prod"

################################################################################
# Colors
################################################################################

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

################################################################################
# Logging
################################################################################

info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

die() {
    error "$*"
    exit 1
}

################################################################################
# Checks
################################################################################

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

check_environment() {
    
    require_command docker
    require_command curl

    [[ -f "$COMPOSE_FILE" ]] \
        || die "Compose file not found: $COMPOSE_FILE"

    [[ -f "$ENV_FILE" ]] \
        || die "Environment file not found: $ENV_FILE"

    docker info >/dev/null 2>&1 \
        || die "Docker daemon is not running."
}

################################################################################
# Docker compose wrapper
################################################################################

compose() {
    docker compose \
        -f "$COMPOSE_FILE" \
        --env-file "$ENV_FILE" \
        "$@"
}

################################################################################
# API endpoints
################################################################################

API_URL="http://localhost:8000"
FRONTEND_URL="http://localhost:8080"

################################################################################
# Health helpers
################################################################################

backend_health() {
    curl -fsS "$API_URL/health"
}

providers() {
    curl -fsS "$API_URL/auth/providers"
}

frontend_health() {
    curl \
        --fail \
        --silent \
        --show-error \
        --head \
        --connect-timeout 3 \
        --max-time 10 \
        "$FRONTEND_URL/login" \
        >/dev/null
}

################################################################################
# Header
################################################################################

print_header() {
    echo
    echo "============================================================"
    echo " EduMind Production Operations"
    echo "============================================================"
    echo
}
