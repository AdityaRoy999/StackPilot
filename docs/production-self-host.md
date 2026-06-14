# StackPilot Production Self-Host Guide

This guide is for running StackPilot on a VPS with a real domain. The same code still works locally with the normal `docker-compose.yml`.

## What Production Mode Adds

- Caddy reverse proxy with automatic HTTPS.
- Backend production config validation.
- Secure headers on frontend and API responses.
- HTTPS-required backend mode behind the proxy.
- Cookie-friendly same-domain API routing through `/api`.
- WebSocket routing through `/ws`.
- Coarse API rate limiting.
- Postgres hidden from the public internet.
- A production `.env` template and secret generator.

## VPS Requirements

- Linux VPS with Docker and Docker Compose.
- Ports `80` and `443` open.
- A DNS `A` record pointing your domain to the VPS.
- At least 2 GB RAM for the platform itself. More is needed for builds.

## Setup

1. Clone the repo on the VPS.

   ```bash
   git clone https://github.com/your-org/StackPilot.git
   cd StackPilot
   ```

2. Generate a production `.env`.

   ```bash
   chmod +x scripts/new-production-env.sh
   ./scripts/new-production-env.sh StackPilot.example.com admin@example.com
   ```

   Replace `StackPilot.example.com` with your real domain.

3. Fill OAuth values in `.env` if you want Google/GitHub sign-in.

   GitHub callback URL:

   ```text
   https://YOUR_DOMAIN/api/v1/auth/github/callback
   ```

4. Start production.

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

5. Check health.

   ```bash
   curl https://YOUR_DOMAIN/api/v1/health
   ```

## Local Development

Use the existing local compose file:

```bash
docker compose up -d --build
```

Local mode can keep HTTP, localhost CORS, relaxed rate limits, and your Docker Desktop Kubernetes config.

## Security Notes

StackPilot controls Docker, SSH, env vars, and Kubernetes. Those are powerful permissions. For production:

- Use HTTPS only.
- Use strong random `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `DB_PASSWORD`.
- Keep `.env` private.
- Do not expose Postgres publicly.
- Restrict access to trusted users.
- Use SSH keys/Tailscale where possible.
- Give remote servers least privilege.
- Keep Docker and the OS patched.
- Back up Postgres regularly.

## Kubernetes

For local or single-node testing, NodePort is fine. For a production-like domain, Ingress is better.

If you want StackPilot to control a Kubernetes cluster from the backend container, set:

```env
KUBECONFIG_HOST_PATH=/absolute/path/to/kubeconfig
K8S_EXPOSURE_MODE=ingress
K8S_BASE_DOMAIN=apps.example.com
K8S_INGRESS_CLASS=nginx
```

The production compose file mounts `KUBECONFIG_HOST_PATH` to `/root/.kube/config`.

## Backups

Create a Postgres backup:

```bash
docker exec stackpilot-postgres pg_dump -U "$DB_USER" "$DB_NAME" > stackpilot-backup.sql
```

Restore into a fresh database:

```bash
cat stackpilot-backup.sql | docker exec -i stackpilot-postgres psql -U "$DB_USER" "$DB_NAME"
```

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run automatically when the backend starts.

## Remaining Enterprise Hardening

For a multi-user public SaaS, add these before opening registration broadly:

- full RBAC and admin invite flow
- immutable audit log UI/export
- per-user/project resource quotas
- durable job queue for builds/provisioning
- image scanning/SBOM/signing
- backup scheduler and restore tests
- stricter SSH command approval policies
