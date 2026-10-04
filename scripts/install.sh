#!/usr/bin/env bash
set -euo pipefail
PROFILE=core
DIRECTORY="${HOME}/stackpilot"
DOMAIN=""
EMAIL=""
CONFIGURE_ONLY=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?Missing profile}"; shift 2 ;;
    --directory) DIRECTORY="${2:?Missing directory}"; shift 2 ;;
    --domain) DOMAIN="${2:?Missing domain}"; shift 2 ;;
    --email) EMAIL="${2:?Missing email}"; shift 2 ;;
    --configure-only) CONFIGURE_ONLY=true; shift ;;
    --help|-h) echo 'Usage: install.sh [--profile base|core|full|monitoring] [--directory PATH] [--domain HOST --email EMAIL] [--configure-only]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
PYTHON_RUNNER="${STACKPILOT_SETUP_PYTHON:-python3}"
for tool in git docker "$PYTHON_RUNNER"; do
  command -v "$tool" >/dev/null || { echo "Install $tool before running this installer." >&2; exit 1; }
done
"$PYTHON_RUNNER" -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ is required"'
docker info >/dev/null
docker compose version >/dev/null
if [ -f docker-compose.yml ] && [ -d stackpilot-cli ]; then DIRECTORY="$PWD"; fi
if [ ! -d "$DIRECTORY" ]; then git clone https://github.com/AdityaRoy999/StackPilot.git "$DIRECTORY"; fi
cd "$DIRECTORY"
[ -f docker-compose.yml ] && [ -d stackpilot-cli ] || { echo 'Destination is not a StackPilot checkout.' >&2; exit 1; }
if ! "$PYTHON_RUNNER" -m venv .stackpilot-venv; then
  echo 'Could not create the CLI environment. On Ubuntu/Debian, install python3-venv for your Python version, then run this installer again.' >&2
  exit 1
fi
.stackpilot-venv/bin/python -m pip install --disable-pip-version-check ./stackpilot-cli
ARGS=(init --yes --workspace "$PWD" --profile "$PROFILE")
if [ -n "$DOMAIN" ]; then ARGS+=(--domain "$DOMAIN" --email "$EMAIL"); fi
.stackpilot-venv/bin/stackpilot "${ARGS[@]}"
if [ "$CONFIGURE_ONLY" = false ]; then .stackpilot-venv/bin/stackpilot up --profile "$PROFILE" --build; fi
echo "CLI installed at $DIRECTORY/.stackpilot-venv/bin/stackpilot"
echo 'Open the dashboard and configure your AI provider in Settings. Existing .env credentials are preserved.'
