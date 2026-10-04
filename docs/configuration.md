# Configuration

You do not need to fill every environment variable. The installers and `stackpilot init` generate a small working configuration; Compose supplies defaults for optional tuning settings.

## Required secrets

The generator creates independent random values for `DB_PASSWORD`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `STACKPILOT_AI_SERVICE_TOKEN`, `GRAFANA_ADMIN_PASSWORD` and `GITHUB_WEBHOOK_SECRET`. Database names, localhost URLs and development access defaults are selected automatically. The generated file is private on POSIX systems and is never committed.

Existing `.env` files are preserved. Do not regenerate or rotate database/encryption keys as part of a routine update: database passwords must match existing volumes, and an encryption-key change affects stored provider credentials. Keep a secure backup of the original configuration.

Setup also detects `DOCKER_SOCKET_GID` on Linux so the unprivileged backend can access Docker. The CLI detects it for older configurations that omit this setting. When running Compose directly with an older `.env`, export `DOCKER_SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)` first. Docker Desktop defaults to group 0. An explicitly configured group is respected.

## AI configuration

After creating an account, open **Settings**, add a provider connection and choose its models. Provider credentials are stored by your own StackPilot backend using its encryption key. The public website does not ask for or upload provider API keys.

Alternatively run `stackpilot init` interactively in a fresh checkout. It can prompt for NVIDIA NIM or an OpenAI-compatible API, including endpoint and model. Keys are entered as masked terminal input. Local compatible servers can use an empty API key. Configure provider access and allowed private-network endpoints deliberately; a container's `localhost` is the container itself.

Advanced AI environment options include `STACKPILOT_AI_PROVIDER`, `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_MODEL`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` and `OPENAI_COMPATIBLE_API_KEY`. Provider costs and model availability depend on the selected service.

## Server installation

```bash
python scripts/configure.py --domain stackpilot.example.com --email admin@example.com
docker compose -f docker-compose.prod.yml up -d --build
```

For a fresh installation, the generator derives public URLs, HTTPS requirements, proxy settings and first-user registration policy from the hostname. Configure DNS and inbound HTTP/HTTPS before starting the production reverse proxy. Domain and email are the only additional required inputs; see the production guide for backups and network boundaries.

## Optional integration settings

Configure GitHub OAuth/App credentials only when enabling those integrations. Kubernetes credentials, SMTP, remote browser workers, ICE/TURN, observability access and native worker tokens are needed only for their respective features. A blank optional variable is not an installation failure.

`production.env.template` is an advanced reference, not the beginner installation form. Copy individual overrides when needed. The CLI stores URLs, selected profile and checkout path in `~/.stackpilot/config.json`; authentication is stored in `~/.stackpilot/auth.json`. Never share either authentication files or `.env`.
