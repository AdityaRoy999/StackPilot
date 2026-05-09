# Docker and Compose

DOKSCP ships with separate images for backend, frontend, AI service, and MCP.

## Backend Image

`Dockerfile` builds the C++ Drogon backend and worker into `dokscp-platform`.

It includes:

- Drogon runtime and build tooling.
- `kubectl`.
- Docker CLI for local Docker builds.
- Redis CLI for the job queue.
- OpenSSH and `sshpass` for saved remote hosts.
- Health check on `/api/v1/health`.

The backend container needs access to the Docker socket when local Docker builds are enabled:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Only run this on trusted infrastructure.

For local Docker deployments, DOKSCP starts a container from the built image, publishes the configured container port on an ephemeral localhost port, stores the runtime as `local_docker`, and returns a browser-previewable URL such as `http://localhost:60806`. Runtime health for this mode is based on Docker container state so it works even when the backend itself is running inside a container.

## Frontend Image

`frontend/Dockerfile` uses a standalone Next.js build on Node 24 Alpine. The runtime image runs as a non-root `nextjs` user and exposes port `3000`.

## AI Service Image

`ai-service/Dockerfile` uses Python 3.12 slim, installs the FastAPI dependencies, runs as non-root `dokscp`, and exposes port `8010`.

## MCP Image

`mcp-server/Dockerfile` packages the MCP server for environments where you want a containerized MCP process. Most desktop IDEs can also run it directly with Node.

## Local Compose

```bash
docker compose up --build
```

Local compose exposes dashboard, backend, AI service, Grafana, Prometheus, Loki, Redis, and PostgreSQL ports.

## Production Compose

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Production compose adds Caddy and serves the app through a single HTTPS domain.

## Rebuild After Renaming

The container names now use `dokscp-*`. Stop existing project containers before starting the renamed stack:

```bash
docker compose down
docker compose -f docker-compose.prod.yml down
docker ps -a --format '{{.Names}}' | grep '^dokscp-' || true
```

Remove stale containers manually only after verifying they are not serving live traffic.
