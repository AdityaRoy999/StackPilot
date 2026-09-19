#!/usr/bin/env bash
# ==============================================================================
#           🚀 StackPilot Universal Low-Spec Installer for Linux / macOS
#       Deploy Any Web App • Autonomous Healing • Zero-Bloat
# ==============================================================================

set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}=================================================================${NC}"
echo -e "${YELLOW}           🚀 StackPilot Universal Low-Spec Installer            ${NC}"
echo -e "       Deploy Any Web App • Autonomous Healing • Zero-Bloat       "
echo -e "${CYAN}=================================================================${NC}\n"

# 1. Hardware Discovery
echo -e "${CYAN}[*] Discovering system hardware...${NC}"
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || sysctl -n hw.memsize 2>/dev/null | awk '{print $1/1024}' || echo "4194304")
TOTAL_RAM_GB=$(awk "BEGIN {printf \"%.1f\", $TOTAL_RAM_KB / 1024 / 1024}")
CPU_COUNT=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "2")

echo -e "  • Total System RAM : ${GREEN}${TOTAL_RAM_GB} GB${NC}"
echo -e "  • CPU Cores        : ${GREEN}${CPU_COUNT} Cores${NC}\n"

# Check Docker
if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}[-] Docker is not installed. Please install Docker Engine first:${NC}"
    echo -e "    curl -fsSL https://get.docker.com | sh"
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}[-] Docker daemon is not running. Please start Docker service.${NC}"
    exit 1
fi

# Profile Recommendation
if (( $(echo "$TOTAL_RAM_GB <= 3.5" | bc -l 2>/dev/null || [ "$TOTAL_RAM_KB" -lt 3670016 ]) )); then
    RECOMMENDED="lite"
    echo -e "[*] Hardware Recommendation: ${YELLOW}⚡ LITE MODE (< 4GB RAM — Core Deployer only ~180MB RAM)${NC}\n"
else
    RECOMMENDED="standard"
    echo -e "[*] Hardware Recommendation: ${GREEN}💻 STANDARD MODE (Core + AI Assistant + Remote Browser ~600MB RAM)${NC}\n"
fi

if [ -z "$STACKPILOT_PROFILE" ]; then
    echo -e "Select an Installation Profile:"
    echo -e "  [1] ⚡ Lite Mode       - Deployer + DB + Fast UI (~180MB RAM, 2GB laptops / VPS)"
    echo -e "  [2] 💻 Standard Mode   - Lite + AI Assistant + Cloud Browser (~600MB RAM)"
    echo -e "  [3] 🏢 Enterprise Mode - Full Stack + Local Sandbox + Observability (~1.8GB RAM)"
    echo -e "  [4] 🛠️ Custom Selection- Choose exactly which components to run"
    read -rp "Enter choice [1-4] (Default: recommendation): " CHOICE

    case "$CHOICE" in
        1) PROFILE="lite" ;;
        2) PROFILE="standard" ;;
        3) PROFILE="enterprise" ;;
        4) PROFILE="custom" ;;
        *) PROFILE="$RECOMMENDED" ;;
    esac
else
    PROFILE="$STACKPILOT_PROFILE"
fi

COMPOSE_FILE="docker-compose.yml"
PROFILES=()

case "$PROFILE" in
    lite)
        COMPOSE_FILE="docker-compose.lite.yml"
        ;;
    standard)
        PROFILES+=("ai")
        ;;
    enterprise)
        PROFILES+=("ai" "browser" "search" "monitoring")
        ;;
    custom)
        read -rp "Enable AI Chat & Autonomous Healing Assistant? (Y/n): " C_AI
        [[ "$C_AI" != "n" && "$C_AI" != "N" ]] && PROFILES+=("ai")

        read -rp "Enable Local Browser Testing Sandbox? (y/N - 'N' uses Remote AWS): " C_BR
        [[ "$C_BR" == "y" || "$C_BR" == "Y" ]] && PROFILES+=("browser")

        read -rp "Enable Private Search Engine (SearXNG)? (y/N): " C_SR
        [[ "$C_SR" == "y" || "$C_SR" == "Y" ]] && PROFILES+=("search")

        read -rp "Enable Observability Stack (Prometheus/Grafana)? (y/N): " C_MON
        [[ "$C_MON" == "y" || "$C_MON" == "Y" ]] && PROFILES+=("monitoring")
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "Created .env from template."
    else
        cat <<EOF > .env
DB_USER=stackpilot_admin
DB_PASSWORD=dokscp_secret_2026
DB_NAME=stackpilot_platform
JWT_SECRET=stackpilot_$(head -c 16 /dev/urandom | xxd -p)_token
NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8090
EOF
        echo "Created fresh .env file."
    fi
fi

CMD=(docker compose -f "$COMPOSE_FILE")
for p in "${PROFILES[@]}"; do
    CMD+=(--profile "$p")
done
CMD+=(up -d --build)

echo -e "\n${CYAN}[*] Starting StackPilot (${PROFILE} profile)...${NC}"
"${CMD[@]}"

echo -e "\n${GREEN}=================================================================${NC}"
echo -e "${GREEN}           🎉 StackPilot is Successfully Running!               ${NC}"
echo -e "${GREEN}=================================================================${NC}\n"
echo -e "  👉 Frontend Dashboard: ${CYAN}http://localhost:3000${NC}"
echo -e "  👉 Backend API Docs  : ${CYAN}http://localhost:8090/api/v1/health${NC}\n"
