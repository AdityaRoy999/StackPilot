# Quick Start

This page gets DOKSCP running locally with Docker Compose.

## Requirements

- Docker Desktop or Docker Engine with Compose.
- A working Docker daemon.
- Optional: Kubernetes access through a kubeconfig if you want local Kubernetes deployments.
- Optional: NVIDIA NIM or OpenAI-compatible API key for AI features.

## Configure Environment

Create `.env`:

```bash
cp production.env.template .env
```

For local development, these are the important values:

```bash
DB_USER=dokscp_admin
DB_PASSWORD=replace-with-a-local-password
DB_NAME=dokscp_platform
JWT_SECRET=replace-with-at-least-48-random-characters
TOKEN_ENCRYPTION_KEY=replace-with-at-least-48-random-characters
CORS_ALLOWED_ORIGIN=http://localhost:3000
FRONTEND_PUBLIC_URL=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:8090
DOKSCP_AI_ENABLED=true
```

To enable NVIDIA NIM:

```bash
DOKSCP_AI_PROVIDER=nvidia_nim
NVIDIA_API_KEY=your-key
NVIDIA_NIM_FAST_MODEL=meta/llama-3.1-8b-instruct
NVIDIA_NIM_THINKING_MODEL=meta/llama-3.1-70b-instruct
```

To use an OpenAI-compatible provider:

```bash
DOKSCP_AI_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=https://your-provider.example.com/v1
OPENAI_COMPATIBLE_API_KEY=your-key
OPENAI_COMPATIBLE_MODEL=your-model
```

## Start

```bash
docker compose up --build
```

Open:

- Dashboard: [http://localhost:3000](http://localhost:3000)
- Backend health: [http://localhost:8090/api/v1/health](http://localhost:8090/api/v1/health)
- Grafana: [http://localhost:3001](http://localhost:3001)
- Prometheus: [http://localhost:9090](http://localhost:9090)

## First Deployment

1. Sign up or sign in.
2. Create a project from GitHub, SSH, or a host-mounted local folder.
3. Create a deployment.
4. Trigger a build.
5. Watch logs in Deployments or Logging and Monitoring.
6. Open the runtime URL when the deployment reaches `running`.

## Stop

```bash
docker compose down
```

To remove volumes:

```bash
docker compose down -v
```

Only remove volumes when you are comfortable deleting local database and observability state.
