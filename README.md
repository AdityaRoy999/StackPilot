# StackPilot

[![CI](https://github.com/AdityaRoy999/StackPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/AdityaRoy999/StackPilot/actions/workflows/ci.yml)

Self-hosted application delivery and browser testing. Build repositories, deploy Docker or Kubernetes workloads, inspect runtime health, and use an AI agent to diagnose problems and verify browser workflows.

## Get started

Install **Git, Docker with Compose v2, and Python 3.10+**. Docker Desktop is suitable for Windows and macOS; Linux can use Docker Engine. The first installation builds images and may take several minutes. A GPU is optional.

```bash
git clone https://github.com/AdityaRoy999/StackPilot.git
cd StackPilot
bash scripts/install.sh --profile core
```

On Windows PowerShell:

```powershell
git clone https://github.com/AdityaRoy999/StackPilot.git
Set-Location StackPilot
./scripts/install.ps1 -Profile core
```

Open **http://localhost:3000**, create your account, then connect your AI provider in **Settings**. Required database, encryption, authentication and service secrets are generated on your own computer. The installer preserves an existing `.env`.

Prefer manual Docker setup? No Python packages are needed for configuration:

```bash
python scripts/configure.py
docker compose --profile ai --profile browser up -d --build
```

| Install profile | Services |
| --- | --- |
| `base` | Dashboard, backend, PostgreSQL, Redis and runtime gateway |
| `core` | Base services plus AI and local browser sandbox |
| `full` | Core services plus search |
| `monitoring` | Full platform plus metrics, logs and Grafana |

Resource use depends on builds, concurrent browsers and deployed applications. We do not promise a fixed memory footprint or a guaranteed display frame rate. See [server installation](docs/production-self-host.md) for HTTPS and operational requirements.

## What it does

- Imports GitHub repositories, authorized local folders, SSH sources and application templates.
- Builds and deploys web applications, Compose stacks, services and jobs; supports configured package, interactive and native worker workflows.
- Uses isolated task workspaces and Docker instances for repository inspection and completion, with evidence and release gates.
- Provides browser testing through local, remote and host browser modes, a live viewer, assertions and scoped approval for consequential actions.
- Manages environments, deployment history, logs, runtime metrics, secrets, clusters and remote phone access to the dashboard.
- Offers an authenticated CLI and an MCP server for external development tools.

Repository completion, native workers and advanced runtime combinations require their documented prerequisites. Incomplete requirements, missing credentials, unsupported hardware and failing verification can block a release. **StackPilot cannot guarantee deployment of every repository.** The remaining work is recorded in the [completion plan](docs/stackpilot-completion-plan.md).

## Repository map

| Directory | Purpose |
| --- | --- |
| `src/`, `sql/` | C++ Drogon API, workers and database migrations |
| `frontend/` | Next.js application dashboard |
| `ai-service/` | FastAPI AI orchestration, browser tools and isolated task workflows |
| `deployment-runtime/` | Repository delivery and runtime adapters |
| `browser-sandbox/`, `native-browser/`, `native-worker/` | Browser capture and optional host/native workers |
| `runtime-gateway/`, `remote-gateway/` | Preview routing and paired remote access |
| `stackpilot-cli/` | Python CLI and shared configuration generator |
| `stackpilot web/` | Public website, installation choices and documentation |
| `mcp-server/`, `observability/` | IDE integration and monitoring |
| `scripts/`, `tests/`, `.github/` | Installers, regression tests and CI |
| `docs/` | Current architecture, configuration and operational guides |

Machine credentials, runtime data, caches, probe output and temporary screenshots are ignored. Historical qualification reports remain available in Git history.

## Documentation and development

Start with the [documentation index](docs/README.md), [CLI guide](stackpilot-cli/README.md), [contribution guide](CONTRIBUTING.md) and [test guide](tests/README.md). The public website imports the current repository documentation so installation guidance stays consistent.

CI covers AI regressions, deployment contracts, native worker boundaries, C++ units, dashboard build/tests, website build/tests, CLI setup/contracts, Compose validation and full-stack integration. External provider and real hardware tests require explicit configuration.

Do not expose Docker sockets, browser debugging ports or internal service tokens publicly. Review the [security guide](docs/security.md) before deploying on a server.
