# Configuration Reference

DOKSCP is configured through environment variables. Local development usually uses `.env`; production should copy `production.env.template`.

## Core

| Variable | Purpose |
| --- | --- |
| `DOKSCP_ENV` | `development` or `production`. |
| `DOKSCP_DOMAIN` | Public production domain used by Caddy and compose. |
| `DOKSCP_CADDY_SITE_ADDRESS` | Caddy site address. Use the real domain for automatic HTTPS. |
| `ACME_EMAIL` | Email used by Caddy for ACME certificate registration. |
| `DOKSCP_HTTP_PORT` / `DOKSCP_HTTPS_PORT` | Host ports mapped to Caddy HTTP/HTTPS. |
| `FRONTEND_PUBLIC_URL` | Public dashboard URL. |
| `BACKEND_PUBLIC_URL` | Public backend URL. |
| `CORS_ALLOWED_ORIGIN` | Comma-separated allowed browser origins. |
| `DOKSCP_REQUIRE_HTTPS` | Enforce HTTPS when proxy headers are trusted. |
| `DOKSCP_TRUST_PROXY_HEADERS` | Trust `X-Forwarded-*` headers from a reverse proxy. |
| `DOKSCP_API_RATE_LIMIT_PER_MINUTE` | API rate limit per client IP. |

## Database

| Variable | Purpose |
| --- | --- |
| `DB_HOST` | PostgreSQL host. |
| `DB_PORT` | PostgreSQL port. |
| `DB_NAME` | Database name. |
| `DB_USER` | Database user. |
| `DB_PASSWORD` | Database password. |

## Security

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Signs authentication JWTs. Use at least 48 random characters. |
| `JWT_EXPIRY_SECONDS` | JWT lifetime. |
| `TOKEN_ENCRYPTION_KEY` | Encrypts stored secrets. Use at least 48 random characters. |
| `GITHUB_WEBHOOK_SECRET` | Verifies GitHub webhook signatures. |
| `GRAFANA_ADMIN_PASSWORD` | Required Grafana admin password for Compose stacks. |

## Build and Source Artifacts

| Variable | Purpose |
| --- | --- |
| `BUILD_WORKSPACE_DIR` | Local build workspace root inside backend container. |
| `SOURCE_ARTIFACT_DIR` | Storage root for MCP-uploaded source archives. |
| `BUILD_MAX_LOG_BYTES` | Bounded log storage size. |
| `BUILD_CLONE_TIMEOUT_SECONDS` | Clone and source preparation timeout. |
| `BUILD_COMMAND_TIMEOUT_SECONDS` | Build command timeout. |
| `BUILD_DOCKER_MEMORY` | Docker build memory limit. |
| `DOKSCP_CI_NO_CHECKS_GRACE_SECONDS` | Grace period before CI-required GitHub pushes continue when no check events arrive. |
| `DOKSCP_LOCAL_PROJECTS_DIR` | Host path mounted into backend for local source projects. |
| `LOCAL_SOURCE_ROOTS` | Allowed source roots inside backend container. |

## AI

| Variable | Purpose |
| --- | --- |
| `DOKSCP_AI_ENABLED` | Enables AI-backed workflows. |
| `DOKSCP_AI_PROVIDER` | `nvidia_nim` or `openai_compatible`. |
| `DOKSCP_AI_MODEL` | Default model override. |
| `DOKSCP_AI_SERVICE_URL` | Backend-to-AI-service URL. |
| `DOKSCP_AI_RATE_LIMIT_PER_MINUTE` | Per-user AI request rate limit. |
| `DOKSCP_AI_MAX_CONTEXT_BYTES` | Backend context budget sent to AI service. |
| `DOKSCP_AI_SERVICE_TIMEOUT_SECONDS` | Backend timeout for AI service calls. |
| `NVIDIA_API_KEY` or `NVIDIA_NIM_API_KEY` | NVIDIA NIM key. |
| `NVIDIA_NIM_BASE_URL` | NIM OpenAI-compatible base URL. |
| `NVIDIA_NIM_FAST_MODEL` | Low-latency model. |
| `NVIDIA_NIM_THINKING_MODEL` | Higher reasoning model. |
| `OPENAI_COMPATIBLE_BASE_URL` | Custom provider base URL. |
| `OPENAI_COMPATIBLE_API_KEY` | Custom provider key. |
| `OPENAI_COMPATIBLE_MODEL` | Custom provider default model. |

## MCP

| Variable | Purpose |
| --- | --- |
| `DOKSCP_MCP_TOKEN` | Token generated in dashboard settings. |
| `DOKSCP_API_URL` | Backend API base, for example `http://localhost:8090/api/v1`. |
| `DOKSCP_FRONTEND_URL` | Dashboard base URL. |
| `DOKSCP_PROJECT_PATH` | Default local project path for IDE agents. |
| `DOKSCP_LOCAL_PROJECTS_HOST_ROOT` | Where MCP stages local projects on the host. |
| `DOKSCP_LOCAL_PROJECTS_CONTAINER_ROOT` | Matching backend-visible path. |
| `DOKSCP_MCP_DEPLOY_WAIT_SECONDS` | How long MCP waits for readiness before returning. |

## Kubernetes

The main variables are `K8S_NAMESPACE`, `K8S_EXPOSURE_MODE`, `K8S_RUNTIME_SCHEME`, ingress class, cert-manager issuer, resource limits, probe paths, and rollout timeout. Production should prefer ingress with TLS and bounded replicas.

## GitHub Webhooks

Auto deploy needs:

| Variable | Purpose |
| --- | --- |
| `BACKEND_PUBLIC_URL` | Public HTTPS backend origin that GitHub can reach. |
| `GITHUB_WEBHOOK_SECRET` | Shared secret used to verify `X-Hub-Signature-256`. |
| `DOKSCP_ALLOW_UNSIGNED_GITHUB_WEBHOOKS` | Development-only escape hatch. Do not enable in production. |

If `BACKEND_PUBLIC_URL` is `localhost`, DOKSCP still lets you create branch environments, but GitHub cannot call back into your machine. Use a public HTTPS domain or a temporary tunnel for webhook smoke tests.
