# Docker and Compose

StackPilot ships with separate images for backend, frontend, AI service, and MCP.

## Backend Image

`Dockerfile` builds the C++ Drogon backend and worker into `stackpilot-platform`.

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
group_add:
  - "${DOCKER_SOCKET_GID:-0}"
```

Only run this on trusted infrastructure.

The setup generator detects the socket's numeric group on Linux. For an existing configuration with direct Compose commands, run `export DOCKER_SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)` before starting the backend. Keep the process unprivileged; do not make the Docker socket world-writable.

For local Docker deployments, StackPilot starts a container from the built image, publishes the configured container port on an ephemeral localhost port, stores the runtime as `local_docker`, and returns a browser-previewable URL such as `http://localhost:60806`. Runtime health for this mode is based on Docker container state so it works even when the backend itself is running inside a container.

## Compose to Kubernetes

When a project contains a Compose file, StackPilot now treats it as a multi-service app instead of a single image. The backend runs Compose build, reads `docker compose config --format json`, generates Kubernetes Deployments, Services, Secrets, PVCs, optional HPA/PDB resources, and a public NodePort/Ingress/LoadBalancer route for the selected web-facing service.

For Kubernetes runtime:

- Each Compose stack is deployed into an isolated namespace so internal service DNS names such as `web`, `api`, `redis`, or `db` work like they do in Compose.
- Built images are handed to the local Kubernetes runtime before rollout. Remote Kubernetes attempts kind, minikube, k3s import, then registry handoff.
- Common dependency ports are inferred for images like Redis, Postgres, MySQL, MongoDB, Grafana, Prometheus, and Nginx when Compose does not declare `ports` or `expose`.
- `environment`, `entrypoint`, `command`, `working_dir`, named volumes, and published ports are converted where Kubernetes can represent them safely.
- Deleting the deployment removes the generated workloads, services, storage claims, and the isolated namespace.

Host bind mounts, privileged containers, custom network modes, and exact Compose healthchecks are not blindly copied because those features are host-specific. StackPilot logs warnings and uses portable Kubernetes defaults instead.

## Frontend Image

`frontend/Dockerfile` uses a standalone Next.js build on Node 24 Alpine. The runtime image runs as a non-root `nextjs` user and exposes port `3000`.

## AI Service Image

`ai-service/Dockerfile` uses Python 3.12 slim, installs the FastAPI dependencies, runs as non-root `StackPilot`, and exposes port `8010`.

## MCP Image

`mcp-server/Dockerfile` packages the MCP server for environments where you want a containerized MCP process. Most desktop IDEs can also run it directly with Node.

## Local Compose

```bash
python scripts/configure.py
docker compose --profile ai --profile browser up -d --build
```

The core profiles start the dashboard, backend, AI service and browser. Observability services are enabled separately with `--profile monitoring`.

## Production Compose

```bash
python scripts/configure.py --domain stackpilot.example.com --email admin@example.com
docker compose -f docker-compose.prod.yml --profile ai --profile browser up -d --build
```

Production compose adds Caddy and serves the app through a single HTTPS domain.

## Rebuild After Renaming

The container names now use `stackpilot-*`. Stop existing project containers before starting the renamed stack:

```bash
docker compose down
docker compose -f docker-compose.prod.yml down
docker ps -a --format '{{.Names}}' | grep '^stackpilot-' || true
```

Remove stale containers manually only after verifying they are not serving live traffic.
