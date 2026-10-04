#!/usr/bin/env bash
# Writes a throwaway .env so the Compose stack can boot in CI.
#
# Every value here is disposable and scoped to a single ephemeral runner. Real
# credentials are never placed in CI: the integration suite only needs the
# stack to start and to *enforce* its rules, not to reach any external service.
#
# The variable list is the set that Compose marks as required (`${VAR:?...}`).
# If a new required variable is added and this script is not updated, the
# config job fails immediately — which is the intended alarm.
set -euo pipefail

cat > .env <<'ENVEOF'
DB_NAME=stackpilot
DB_USER=stackpilot
DB_PASSWORD=ci-postgres-password
JWT_SECRET=ci-jwt-secret-value-at-least-32-characters-long
TOKEN_ENCRYPTION_KEY=ci-token-encryption-key-at-least-32-chars
STACKPILOT_AI_SERVICE_TOKEN=ci-ai-service-token-at-least-32-chars-long
CORS_ALLOWED_ORIGIN=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:8090
FRONTEND_PUBLIC_URL=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1

# Only read by docker-compose.prod.yml, which CI validates but does not run.
STACKPILOT_DOMAIN=ci.invalid
ACME_EMAIL=ci@ci.invalid
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=ci-grafana-password
ENVEOF

echo "Wrote CI .env with $(grep -c '=' .env) variables"
