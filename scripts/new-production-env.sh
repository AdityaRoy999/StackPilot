#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: ./scripts/new-production-env.sh <domain> <email>" >&2
  exit 1
fi

DOMAIN="$1"
EMAIL="$2"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TEMPLATE="$ROOT_DIR/production.env.template"
ENV_FILE="$ROOT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  echo ".env already exists. Move it first if you want to generate a fresh production file." >&2
  exit 1
fi

secret() {
  openssl rand -hex 48
}

sed \
  -e "s/aids.example.com/$DOMAIN/g" \
  -e "s/admin@example.com/$EMAIL/g" \
  -e "s#replace-with-a-long-random-database-password#$(secret)#" \
  -e "s#replace-with-at-least-48-random-characters#$(secret)#" \
  "$TEMPLATE" > "$ENV_FILE"

TOKEN_SECRET="$(secret)"
sed -i "0,/TOKEN_ENCRYPTION_KEY=.*/s//TOKEN_ENCRYPTION_KEY=$TOKEN_SECRET/" "$ENV_FILE"

echo "Created .env for $DOMAIN"
