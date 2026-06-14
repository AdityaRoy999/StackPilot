# StackPilot

StackPilot is a self-hosted application delivery cockpit for turning GitHub repositories, SSH/VPS folders, local folders, and application templates into running Docker or Kubernetes deployments. It includes a Next.js dashboard, a C++ Drogon backend, a Python AI service, PostgreSQL, Redis, Docker build orchestration, Kubernetes runtime management, MCP tools for IDE agents, and an observability stack.

Use it when you want one platform to create projects, build containers, deploy applications, inspect logs, manage runtimes, monitor services, and use an AI agent to help diagnose or operate deployments.

## Features

- Create projects from GitHub, SSH/VPS paths, local folders, or built-in application templates.
- Deploy common applications such as databases, object storage, monitoring tools, and Docker Compose stacks.
- Build and run projects with Docker Compose.
- Deploy to local Docker, remote Docker, local Kubernetes, or remote Kubernetes.
- Manage project environment variables, secrets, deployments, logs, runtime status, and cleanup.
- Use the AI Agent to explain failures, create application projects, and help with deployment operations.
- Use MCP tools from IDE agents such as Codex, Claude Code, VS Code, and other MCP-capable clients.
- Observe services with Prometheus, Grafana, Loki, Promtail, and cAdvisor.

## Required Tools

Install these before running StackPilot locally:

| Tool | Required | Notes |
| --- | --- | --- |
| Git | Yes | Used to clone the repository and work with GitHub projects. |
| Docker Desktop | Yes | Required for local containers, images, networks, and volumes. |
| Docker Compose v2 | Yes | Included with Docker Desktop. Check with `docker compose version`. |
| Node.js 20+ | Optional | Only needed when developing the frontend outside Docker. |
| npm | Optional | Comes with Node.js. Used for frontend development. |
| CMake | Optional | Only needed when building the C++ backend outside Docker. |
| C++ compiler | Optional | Use Visual Studio Build Tools on Windows or GCC/Clang on Linux. |
| Python 3.12+ | Optional | Only needed when running the AI service outside Docker. |
| kubectl | Optional | Required only for Kubernetes deployments. |
| Kubernetes cluster | Optional | Use Docker-only mode if you do not want Kubernetes. |

For most users, **Git + Docker Desktop** is enough.

## Quick Start

Clone the repository:

```bash
git clone <your-repo-url>
cd StackPilot
```

Create a local environment file:

```bash
cp production.env.template .env
```

On Windows PowerShell:

```powershell
Copy-Item production.env.template .env
```

Edit `.env` and set at least these values:

```env
STACKPILOT_ENV=development
STACKPILOT_DOMAIN=localhost

DB_USER=stackpilot_admin
DB_PASSWORD=replace-with-a-local-password
DB_NAME=stackpilot_platform

JWT_SECRET=replace-with-at-least-48-random-characters
TOKEN_ENCRYPTION_KEY=replace-with-at-least-48-random-characters
GRAFANA_ADMIN_PASSWORD=replace-with-a-local-grafana-password

CORS_ALLOWED_ORIGIN=http://localhost:3000
FRONTEND_PUBLIC_URL=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:8090
NEXT_PUBLIC_API_BASE_URL=http://localhost:8090/api/v1
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8090

STACKPILOT_REQUIRE_HTTPS=false
STACKPILOT_TRUST_PROXY_HEADERS=false
```

Start the app:

```bash
docker compose up -d --build
```

Open the dashboard:

[http://localhost:3000](http://localhost:3000)

Useful local URLs:

| Service | URL |
| --- | --- |
| Dashboard | [http://localhost:3000](http://localhost:3000) |
| Backend API | [http://localhost:8090/api/v1](http://localhost:8090/api/v1) |
| Backend health | [http://localhost:8090/api/v1/health](http://localhost:8090/api/v1/health) |
| AI service | `http://127.0.0.1:8010` |
| Grafana | Usually `http://localhost:3001` when enabled/exposed by your Compose config |

View running containers:

```bash
docker compose ps
```

Stop the stack:

```bash
docker compose down
```

Stop and remove local volumes:

```bash
docker compose down -v
```

## First Account

By default, StackPilot is designed so the first user can register and become the initial platform user. After the first account exists, configure invite-based registration or your preferred authentication settings before exposing the platform publicly.

Do not publish a deployment with placeholder secrets such as `change-before-deployment`, `replace-with`, or short test passwords.

## Local Development

Run the full platform with Docker:

```bash
docker compose up -d --build
```

Frontend-only development:

```bash
cd frontend
npm install
npm run dev
```

Frontend checks:

```bash
cd frontend
npm run lint
npm run build
```

AI service local development:

```bash
cd ai-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010
```

Use the Linux/macOS activation command instead of the PowerShell one when not on Windows:

```bash
source .venv/bin/activate
```

Backend local development is easiest through Docker. Native builds require CMake and a C++ compiler.

## Production Deployment

Create production secrets first:

```bash
cp production.env.template .env
```

Or use the helper script:

```bash
./scripts/new-production-env.sh
```

On Windows:

```powershell
.\scripts\new-production-env.ps1
```

Before production, configure:

- `STACKPILOT_DOMAIN`
- `ACME_EMAIL`
- `JWT_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `GRAFANA_ADMIN_PASSWORD`
- `GITHUB_WEBHOOK_SECRET`
- OAuth credentials if using GitHub or Google login
- AI provider keys if using AI features
- Kubernetes or remote Docker settings if deploying outside the local host

Start the production stack:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Production should be served over HTTPS. Do not expose the backend, Docker socket, database, Redis, Prometheus, or internal services directly to the public internet.

## AI Agent

StackPilot includes an AI workspace for deployment help and diagnostics. The agent can explain failed deployments, create application-source projects, and help with operational commands.

Configure an AI provider in the dashboard settings or with environment variables. The exact provider depends on your deployment, but keep provider API keys out of Git.

Example prompts:

```text
Deploy a MySQL database
Create a MinIO object storage application
Diagnose the latest failed deployment
Explain why this runtime is unhealthy
```

## Application Templates

StackPilot can create application-source projects without needing a Git repository. Examples include:

- PostgreSQL
- MySQL
- MariaDB
- Redis
- MinIO
- Grafana
- Prometheus
- NATS

Application templates store configuration in project environment variables and generate a Docker Compose deployment source for the selected app.

## MCP and IDE Agents

The `mcp-server/` package lets IDE agents call StackPilot tools directly. This is useful for workflows where an agent needs to create projects, upload source artifacts, start builds, inspect deployments, or diagnose failures.

See [mcp-server/README.md](mcp-server/README.md) and [docs/mcp-ide-agents.md](docs/mcp-ide-agents.md).

## Repository Layout

```text
.
|-- src/                 C++ Drogon backend and worker services
|-- frontend/            Next.js dashboard
|-- ai-service/          FastAPI AI service
|-- mcp-server/          MCP server for IDE agents
|-- sql/migrations/      PostgreSQL schema migrations
|-- observability/       Prometheus, Grafana, Loki, and Promtail config
|-- docs/                Documentation
|-- scripts/             Setup and helper scripts
|-- Dockerfile           Backend image
|-- docker-compose.yml   Local Docker Compose stack
`-- docker-compose.prod.yml
```

## Common Commands

Build and start:

```bash
docker compose up -d --build
```

Show logs:

```bash
docker compose logs -f
```

Show one service log:

```bash
docker compose logs -f backend
```

Restart one service:

```bash
docker compose restart backend
```

Rebuild one service:

```bash
docker compose up -d --build backend
```

Check containers:

```bash
docker compose ps
```

Clean stopped containers and unused images:

```bash
docker system prune
```

## Troubleshooting

If Docker says a port is already in use, find the process using it:

```bash
sudo ss -tulpn | grep -E ':(80|443|3000|8090)\b'
```

On Windows PowerShell:

```powershell
netstat -ano | findstr ":3000 :8090"
```

If the frontend loads but API requests fail, check:

- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_WS_BASE_URL`
- `BACKEND_PUBLIC_URL`
- `CORS_ALLOWED_ORIGIN`
- `docker compose ps`
- `docker compose logs -f backend`

If registration or login fails, check:

- PostgreSQL is healthy.
- `JWT_SECRET` is set.
- `TOKEN_ENCRYPTION_KEY` is set.
- The backend logs do not show migration errors.

If AI responses do not work, check:

- AI provider key is configured.
- `ai-service` is running.
- The backend can reach the AI service.
- The selected model/provider is valid.

## Documentation

- [Quick Start](docs/quickstart.md)
- [Architecture](docs/architecture.md)
- [Configuration Reference](docs/configuration.md)
- [Docker and Compose](docs/docker.md)
- [Deployment Workflows](docs/deployment-workflows.md)
- [MCP and IDE Agents](docs/mcp-ide-agents.md)
- [AI Agent](docs/ai-agent.md)
- [Environments and CI](docs/environments-ci.md)
- [GitHub App Integration](docs/github-app.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

## Security

StackPilot is an infrastructure platform. Treat it like production operations software.

- Never commit `.env`, kubeconfigs, private keys, GitHub PATs, AI provider keys, OAuth secrets, or MCP tokens.
- Use long random values for `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `GITHUB_WEBHOOK_SECRET`.
- Keep production behind HTTPS.
- Restrict Docker socket access.
- Use least-privilege SSH users for remote hosts.
- Rotate secrets if debug files, terminal logs, or screenshots exposed them.

