# Troubleshooting

## Backend Cannot Start

Check environment:

```bash
docker logs stackpilot-backend
docker compose config
```

Common causes:

- Missing `JWT_SECRET`.
- Missing `TOKEN_ENCRYPTION_KEY`.
- PostgreSQL not healthy.
- Docker socket not mounted.
- Invalid kubeconfig mount.

## GitHub Clone Fails

GitHub no longer supports password authentication for Git operations. Use a connected GitHub account, GitHub App, or token with repository read access.

## MCP Cannot Deploy Current Project

Run:

```bash
STACKPILOT_health
STACKPILOT_verify_auth
STACKPILOT_inspect_local_project
```

Check:

- `STACKPILOT_MCP_TOKEN` is set.
- `STACKPILOT_API_URL` points to `/api/v1`.
- `STACKPILOT_PROJECT_PATH` points to the actual project.
- The backend can write `SOURCE_ARTIFACT_DIR`.
- Remote host name matches a saved SSH connection.

## AI Says Provider Request Failed

Check:

- Provider API key is set.
- Base URL ends in `/v1` for OpenAI-compatible APIs.
- Selected model is available to the key.
- Fast mode uses a low-latency model.
- Timeouts are high enough for thinking mode.

## Deployment Has No URL

The deployment may be built but not running. Check runtime provider:

- `built`: image exists, not deployed.
- `running`: runtime URL should exist.
- `failed`: inspect logs.

For Kubernetes ingress, confirm ingress controller, DNS, cert-manager, and base domain settings.

## Project Delete Fails

Project deletion fails loudly if cleanup fails. Fix the runtime or remote host issue, then retry. This prevents orphaned pods, containers, images, and workspaces.

## Docker Build Cannot Find File

The file may be excluded by `.dockerignore`, missing from the source artifact, or referenced by an incorrect Dockerfile path. Use the recent failure explain action or AI diagnosis to identify the missing path.
