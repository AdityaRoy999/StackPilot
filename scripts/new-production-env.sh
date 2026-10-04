#!/usr/bin/env sh
set -eu
if [ "$#" -ne 2 ]; then
  echo "Usage: ./scripts/new-production-env.sh <domain> <email>" >&2
  exit 1
fi
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec python3 "$ROOT_DIR/scripts/configure.py" --domain "$1" --email "$2" --workspace "$ROOT_DIR"
