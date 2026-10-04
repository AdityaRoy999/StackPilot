# Production self-hosting

Use a Linux server with Docker Compose v2.20+, Git and Python 3.10+. Point the hostname at the server and allow inbound TCP 80/443 for Caddy. Keep SSH limited to authorized administrators. Allocate resources for the platform, concurrent Chromium sessions, builds and deployed applications; there is no fixed RAM guarantee.

## Fresh installation

```bash
git clone https://github.com/AdityaRoy999/StackPilot.git
cd StackPilot
bash scripts/install.sh --profile core --domain stackpilot.example.com --email admin@example.com
```

For manual installation:

```bash
python scripts/configure.py --domain stackpilot.example.com --email admin@example.com
docker compose -f docker-compose.prod.yml --profile ai --profile browser up -d --build
```

The generator selects same-origin API URLs, HTTPS requirements, proxy trust and first-user registration. Required secrets are random and generated locally. Sign up for the first account promptly, then configure provider connections and models in Settings. Additional registration follows the configured invitation policy.

Optional production profiles match local feature profiles: `ai`, `browser`, `search`, `full`, `monitoring`, `remote`. The CLI's `core` translates into `ai` plus `browser`; `monitoring` translates into `full` plus `monitoring`. Enable monitoring explicitly rather than booting it for every install.

## Trust boundaries

Caddy is the public entry point. Keep PostgreSQL, Redis, AI APIs, browser debugging, streaming control and Docker sockets private. Browser and native worker services are privileged infrastructure: an operator with Docker socket access can affect the host. Use a dedicated host or appropriate isolation for untrusted repositories.

Only trust forwarded headers from your controlled reverse proxy. Keep TLS, ownership checks and scoped approvals enabled. Pair remote phones through the platform, and revoke devices when access is no longer needed. Native workers and remote browser workers require their own credentials and configured endpoints.

For Kubernetes, supply an authorized cluster and kubeconfig deliberately. The default local stack no longer mounts a Windows-specific home directory into Linux. `kubectl` is downloaded during the image build from a pinned upstream release and verified against its published SHA-256; set the `KUBECTL_VERSION` build argument when a different cluster-compatible version is required.

## Backups and upgrades

Back up PostgreSQL, application volumes, source artifacts and `.env` separately. Keep the original encryption key with your protected backup: replacing it can make stored provider credentials unreadable. Test restoration in a disposable environment.

Before upgrades, read migration changes and back up the installation. Pull the reviewed commit, rebuild the selected services, and verify login, deployments, AI and browser access. Do not overwrite `.env`, reset volumes or prune active deployment images as part of an upgrade.

```bash
git pull --ff-only
docker compose -f docker-compose.prod.yml --profile ai --profile browser up -d --build
docker compose -f docker-compose.prod.yml ps
```

## Release checks

Require green CI and a smoke test for the features your installation uses. Verify persistent data across restarts, queue recovery, logs, resource limits, certificate renewal, and provider failures. Real hardware and external provider qualification are separate from deterministic CI. The deferred [completion plan](stackpilot-completion-plan.md) lists remaining support and qualification work; this guide does not certify every workload or a high-availability deployment.
