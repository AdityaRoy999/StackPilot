# DOKSCP

**DOKSCP** stands for **Developer Operations Kubernetes Source Control Platform**.

DOKSCP is a self-hosted deployment control plane for developers who want a local, GitHub, or IDE-based project to become a running Docker or Kubernetes deployment without stitching together scripts by hand. It combines a C++ Drogon backend, a Next.js dashboard, a Python AI agent service, PostgreSQL, Redis workers, Docker builds, Kubernetes runtime management, MCP tools for IDE agents, and an observability stack.

## What Changed Recently

UI-wise, the project is now branded as DOKSCP across the dashboard, browser metadata, package metadata, Docker containers, and operational docs. The dashboard work already includes the AI Agent workspace, command-style chat input, DOKSCP logging and monitoring terminology, recent failure explanation flows, MCP integration settings, and provider/model configuration.

Logic-wise, the platform now has a production-grade source artifact path for MCP local deployments, authoritative project deletion cleanup, environment-aware branch deployments, GitHub branch discovery during project creation, GitHub webhook processing, CI-gated promotion with a no-check grace path, exact commit checkout, superseded-commit handling, and Docker/Kubernetes cleanup through a shared service. Local IDE agents should use the DOKSCP MCP tools instead of manually copying files, writing ad hoc Dockerfiles, or SSHing into a host by themselves.

## Core Capabilities

- Create projects from GitHub repositories, saved SSH paths, host-mounted local folders, or immutable MCP-uploaded source artifacts.
- Build Docker images with deterministic generators first and AI-assisted Dockerfile planning when deterministic detection is not enough.
- Deploy to local Docker with a `localhost` preview URL, local Kubernetes, remote Docker, or remote Kubernetes.
- Delete projects and deployments with runtime cleanup for pods, services, ingress, containers, images, jobs, and workspaces.
- Use the DOKSCP AI Agent for diagnostics, build planning, deployment reasoning, and failure explanations.
- Use MCP tools from Codex, Claude Code, VS Code, Antigravity, or any MCP-capable IDE.
- Map project environments to Git branches such as `dev` and `main`, with separate environment variables and runtime URLs per environment.
- Receive GitHub App or repository push webhooks, map commits to environments, and gate production deployments on GitHub Checks.
- Monitor runtime health with Prometheus, Grafana, Loki, Promtail, and cAdvisor.

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
- [Extreme Test Cases](docs/extreme-test-cases.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)

## Local Development

1. Copy the production template or use your existing local `.env`.

```bash
cp production.env.template .env
```

2. Set at least these values:

```bash
DB_USER=dokscp_admin
DB_PASSWORD=replace-with-a-local-password
DB_NAME=dokscp_platform
JWT_SECRET=replace-with-at-least-48-random-characters
TOKEN_ENCRYPTION_KEY=replace-with-at-least-48-random-characters
CORS_ALLOWED_ORIGIN=http://localhost:3000
FRONTEND_PUBLIC_URL=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:8090
```

3. Start the stack.

```bash
docker compose up --build
```

4. Open the dashboard:

[http://localhost:3000](http://localhost:3000)

The backend API is available at [http://localhost:8090/api/v1](http://localhost:8090/api/v1).

## Production

Use `docker-compose.prod.yml` behind Caddy:

```bash
cp production.env.template .env
docker compose -f docker-compose.prod.yml up -d --build
```

Set `DOKSCP_DOMAIN`, `ACME_EMAIL`, strong secrets, OAuth credentials if needed, Kubernetes settings, and AI provider keys before exposing the platform publicly.

## Repository Layout

```text
.
|-- src/                 C++ Drogon backend and worker services
|-- frontend/            Next.js dashboard
|-- ai-service/          FastAPI AI provider bridge and agent helper service
|-- mcp-server/          MCP server for IDE agents
|-- sql/migrations/      PostgreSQL schema migrations
|-- observability/       Prometheus, Grafana, Loki, and Promtail config
|-- docs/                GitHub-facing documentation
|-- Dockerfile           Backend image
|-- docker-compose.yml   Local stack
`-- docker-compose.prod.yml
```

## Security Baseline

DOKSCP is an operations platform. Treat it like infrastructure.

- Never commit `.env`, kubeconfigs, private keys, GitHub PATs, AI provider keys, or MCP tokens.
- Use a long random `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY`.
- Keep `GITHUB_WEBHOOK_SECRET` set in production.
- Expose production only through HTTPS.
- Restrict Docker socket access to trusted hosts.
- Use least-privilege SSH users for remote hosts.
- Rotate MCP tokens if an IDE config is copied or leaked.

See [Security](docs/security.md) for the full model.

## GitHub App and Webhooks

For auto deploy on push, DOKSCP needs a public backend URL and a shared webhook secret:

```bash
BACKEND_PUBLIC_URL=https://api.your-domain.example
GITHUB_WEBHOOK_SECRET=replace-with-a-long-random-secret
```

Recommended production mode is a GitHub App. Create the App, set its webhook URL to:

```text
https://api.your-domain.example/api/v1/github/webhooks
```

and enable:

```bash
GITHUB_APP_WEBHOOK_MODE=true
```

Then install the App on the repositories or organization DOKSCP may deploy.

Repository webhooks are still supported as a fallback when `GITHUB_APP_WEBHOOK_MODE=false`:

- Payload URL: `https://api.your-domain.example/api/v1/github/webhooks`
- Content type: `application/json`
- Secret: same as `GITHUB_WEBHOOK_SECRET`
- Events: `push`, `check_run`, and `check_suite`

See [GitHub App Integration](docs/github-app.md) for the App permissions and installation flow.

Localhost cannot receive GitHub webhooks directly; use a public HTTPS reverse proxy or tunnel for development testing.

## License

Add your preferred license before publishing this repository.
