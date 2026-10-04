# Quickstart

For a browser-based installation, download the setup ZIP for your platform from the website and open its launcher. Follow the [guided setup](guided-setup.md) instructions to check prerequisites, install, and configure AI without editing `.env`. Terminal installation is also supported:

Install Git, Docker with Compose v2, and Python 3.10+. Start Docker before running the installer. No GPU or cloud account is required for local use.

```bash
git clone https://github.com/AdityaRoy999/StackPilot.git
cd StackPilot
bash scripts/install.sh --profile core
```

Windows:

```powershell
git clone https://github.com/AdityaRoy999/StackPilot.git
Set-Location StackPilot
./scripts/install.ps1 -Profile core
```

The installer creates a private Python environment for the CLI, generates the essential `.env` secrets locally and builds the selected services. Existing `.env` values are preserved. First builds depend on CPU, network and Docker cache; installation is not guaranteed to finish within a fixed time.

Open http://localhost:3000, create an account, and sign in. The first-launch Setup guide lets you save and test an AI provider and model, or skip AI. Connect a repository to create a project, or open AI Agent and select a website target for a browser test. Critical actions require approval of a specific step.

## Service choices

`base` starts dashboard/deployment services. `core` adds AI and a local browser. `full` adds search. `monitoring` adds the observability stack. The old `standard`, `lite` and `enterprise` CLI names map to `core`, `base` and `monitoring` respectively.

For manual setup:

```bash
python scripts/configure.py
docker compose --profile ai --profile browser up -d --build
```

The Docker profile names differ from the installer choices: the CLI translates `core` into `ai` and `browser`; do not use `docker compose --profile core`.

## CLI

```bash
python -m pip install ./stackpilot-cli
stackpilot init --yes --profile core
stackpilot up --profile core --build
stackpilot auth login
stackpilot test https://example.com --sandbox local
```

Use a Python virtual environment when installing the CLI manually. The bootstrap installer creates `.stackpilot-venv` automatically. On Windows its executable is `.stackpilot-venv/Scripts/stackpilot.exe`; on Linux/macOS it is `.stackpilot-venv/bin/stackpilot`.

## Stop and update

`stackpilot down` preserves data volumes. `stackpilot restart ai-service` restarts only the selected service. For official local main-branch installations, run `stackpilot update --check`, then `stackpilot update`. Updates require a clean checkout and a successful PostgreSQL backup, then rebuild and check health. Reopen `stackpilot setup` for the same workflow in a browser. Public HTTPS server updates follow the server maintenance guide. `down --volumes` explicitly deletes persistent volumes and should be used only for disposable installations.

See [configuration](configuration.md) and [production self-hosting](production-self-host.md) for advanced settings and server setup.
