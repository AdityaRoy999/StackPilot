# Security

StackPilot controls builds, deployments, containers, remote hosts, Kubernetes resources, and provider keys. Operate it as infrastructure.

## Secrets

Never commit:

- `.env`
- kubeconfig files
- private SSH keys
- GitHub PATs
- OAuth secrets
- AI provider keys
- MCP tokens
- database passwords

Use strong random values:

```bash
openssl rand -base64 48
```

The supported installer generates independent database, JWT, encryption, internal AI service, webhook and monitoring secrets on the installation host. It preserves an existing `.env`. AI provider credentials can be added through authenticated dashboard Settings; the public installation website does not collect them.

## Dependency validation

The October 2026 maintenance update upgraded Next.js and removed unused JavaScript dependencies. Both web applications have zero reported production npm advisories in the checked lockfiles. The dashboard's ESLint dependency chain still reports the `braces` denial-of-service advisory ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)); its upstream patch was unavailable during validation. It is development tooling, not a dashboard runtime dependency. Run `npm audit` and `npm audit --omit=dev` when reviewing dependency updates. CI and a clean audit do not replace deployment-specific security review.

## Authentication

Dashboard users authenticate with JWTs. `JWT_SECRET` must be long and unique per deployment. `TOKEN_ENCRYPTION_KEY` encrypts stored provider credentials and must not change unless you plan a key rotation process.

## CSRF and CORS

Browser mutating requests require trusted origins and `X-stackpilot-CSRF`. MCP requests can use `X-stackpilot-MCP`. GitHub webhooks are accepted only on the webhook endpoint and should be signed with `GITHUB_WEBHOOK_SECRET`.

## MCP Tokens

MCP tokens let IDE agents deploy projects. Treat them like API keys.

- Store them in IDE secret config when possible.
- Rotate them if copied into a chat, shell history, or repo.
- Scope future tokens by project or environment when that feature is added.

## Docker Socket

The backend can use `/var/run/docker.sock`. This is powerful. Anyone with write access to that socket can effectively control the host. Run StackPilot only on trusted infrastructure and restrict dashboard access.

## Remote Hosts

Use dedicated remote users for deployment. Avoid using root unless the host is disposable. Give the user only the Docker, Kubernetes, and workspace permissions required.

## GitHub

Prefer GitHub App installation over personal access tokens for production. If you use a PAT, grant only repository read permissions needed for cloning.

## AI Providers

AI logs can contain source snippets, deployment logs, env key names, and operational context. Use providers you trust and keep `STACKPILOT_AI_MAX_CONTEXT_BYTES` bounded.

## Production Checklist

- HTTPS enabled.
- Strong `JWT_SECRET`.
- Strong `TOKEN_ENCRYPTION_KEY`.
- `GITHUB_WEBHOOK_SECRET` set.
- Grafana password changed.
- Docker socket access understood.
- SSH connections use least privilege.
- Backups configured.
- Logs reviewed for accidental secret exposure.
