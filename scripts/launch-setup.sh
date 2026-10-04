#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
for python_runner in python3 python; do
  if command -v "$python_runner" >/dev/null 2>&1 && "$python_runner" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    exec "$python_runner" setup_server.py
  fi
done
printf '%s\n' 'Install Python 3.10+ from https://www.python.org/downloads/ or your operating system package manager, then reopen this launcher.'
read -r -p 'Press Enter to close.'
exit 1
