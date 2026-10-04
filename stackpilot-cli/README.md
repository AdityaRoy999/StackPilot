# StackPilot CLI

Version 1.1.0. Configure a StackPilot installation, manage containers and deployments, and use authenticated AI workflows from your terminal.

```bash
python -m pip install ./stackpilot-cli
stackpilot init
stackpilot up --profile core --build
stackpilot auth login
```

Python 3.10+ is required. Use a virtual environment; `scripts/install.sh` and `scripts/install.ps1` create one automatically. Run from a StackPilot checkout, or pass `stackpilot init --workspace /path/to/StackPilot`. The checkout is remembered for later lifecycle commands.

| Command | Purpose |
| --- | --- |
| `init [--yes] [--profile core]` | Generate private secrets and configure the checkout; preserve existing `.env` |
| `init --domain HOST --email EMAIL` | Configure a fresh HTTPS server installation |
| `doctor` | Inspect Docker, services and host resources |
| `up --profile base/core/full/monitoring --build` | Build and start selected services |
| `down` | Stop services while preserving volumes |
| `restart [service]` | Restart only the selected service, without tearing down the stack |
| `status`, `logs -f [service]` | Inspect container state and logs |
| `auth login/register/me/logout` | Manage authenticated backend access |
| `project list/create/delete` | Manage projects |
| `env list PROJECT_ID` | Inspect environments |
| `deploy trigger/list/logs` | Queue builds and inspect deployments |
| `cluster list` | Inspect managed clusters |
| `chat [--session-id ID] [--sandbox local/remote/host]` | Chat in a persisted, owned backend session |
| `test URL [--depth 2] [--sandbox remote] [--open]` | Test safe workflows and request approval for specific critical steps |

AI requests use the authenticated backend, not an administrator service token read from `.env`. Browser permissions resume only the exact signed action that was reviewed. A denied or stale approval does not dispatch the action. A remote or host browser must already be configured in the platform. Test depth is a requested limit, not a guarantee that every route or behavior will be covered.

Profiles map to actual Compose profiles: `base` has no extra profiles, `core` enables `ai` and `browser`, `full` enables `full`, and `monitoring` enables `full` plus `monitoring`. Production Compose uses the same feature profiles and keeps monitoring optional.

Configure AI credentials in dashboard Settings, or use interactive `init` for a fresh installation. Config and authentication live under `~/.stackpilot/`. `down --volumes` deletes persistent data and is intended for disposable environments.

Run deterministic tests without Docker or external services:

```bash
PYTHONPATH=stackpilot-cli python -m unittest discover -s stackpilot-cli/tests
```
