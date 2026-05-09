# GitHub App Integration

DOKSCP supports two GitHub automation modes:

- OAuth plus repository webhooks: DOKSCP signs a user in with GitHub and attempts to create a webhook on each repository that has auto deploy enabled.
- GitHub App webhooks: one GitHub App sends `push`, `check_run`, and `check_suite` events to DOKSCP for every repository where the App is installed.

The GitHub App model is the recommended production path because users install DOKSCP once and choose the repositories it may access. DOKSCP does not need to create a separate repository webhook for every project.

## Required Public URL

GitHub must reach your backend over HTTPS.

For local development without a domain, a static ngrok domain works:

```bash
ngrok http 8090 --url=your-static-domain.ngrok-free.dev
```

Then set:

```env
BACKEND_PUBLIC_URL=https://your-static-domain.ngrok-free.dev
GITHUB_WEBHOOK_SECRET=replace-with-a-long-random-secret
GITHUB_APP_WEBHOOK_MODE=true
```

## Create the GitHub App

In GitHub:

1. Open `Settings`.
2. Open `Developer settings`.
3. Open `GitHub Apps`.
4. Select `New GitHub App`.
5. Set `GitHub App name` to `DOKSCP`.
6. Set `Homepage URL` to your frontend URL.
7. Set `Webhook URL` to:

```text
https://your-domain-or-ngrok-url/api/v1/github/webhooks
```

8. Set `Webhook secret` to the same value as `GITHUB_WEBHOOK_SECRET`.

## Permissions

Use the minimum permissions needed for deployment automation:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read-only | Required by GitHub Apps |
| Contents | Read-only | Clone/read repository source |
| Checks | Read-only | Receive and inspect CI results |
| Commit statuses | Read-only | Support status-based CI workflows |
| Actions | Read-only | Inspect workflow/check context |
| Pull requests | Read-only | Future preview and PR deployment support |

Subscribe to these webhook events:

- `Push`
- `Check run`
- `Check suite`
- `Installation`
- `Installation repositories`

## Environment Variables

```env
GITHUB_APP_WEBHOOK_MODE=true
GITHUB_APP_NAME=DOKSCP
GITHUB_APP_SLUG=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY_PATH=
GITHUB_APP_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=
```

`GITHUB_APP_WEBHOOK_MODE=true` tells DOKSCP not to create repo-level webhooks. Push and check events are expected to arrive through the central GitHub App webhook.

The private key fields are reserved for installation-token support. The current webhook automation path does not need the private key to receive push/check events, but installation tokens are needed when DOKSCP should clone private repositories using the GitHub App identity instead of a user OAuth token or PAT.

## Install the App

After creating the App:

1. Click `Install App`.
2. Choose your account or organization.
3. Select all repositories or only the repositories DOKSCP may deploy.
4. Save.

GitHub sends an `installation` webhook to DOKSCP. DOKSCP stores the installation and selected repositories in:

- `github_app_installations`
- `github_app_repositories`

## How Auto Deploy Works

When a commit is pushed:

1. GitHub sends a `push` webhook to `/api/v1/github/webhooks`.
2. DOKSCP verifies `X-Hub-Signature-256`.
3. DOKSCP matches `repository.full_name` plus branch to project environments.
4. If the environment does not require CI, DOKSCP queues the deployment immediately.
5. If the environment requires CI, DOKSCP creates a blocked deployment and waits for `check_suite` or `check_run`.
6. On CI success, DOKSCP queues the deployment.
7. On CI failure, DOKSCP marks the candidate `failed_ci` and keeps the previous runtime alive.

## OAuth Still Has a Role

GitHub App webhooks replace per-repository webhook setup. OAuth can still be useful for user login and showing a user's GitHub identity inside DOKSCP.

For the cleanest production setup:

- Use GitHub App installation for repository events and repository access.
- Use OAuth only for signing users into DOKSCP.
- Avoid broad OAuth scopes such as `admin:repo_hook` once all repos use the GitHub App path.

## Local Smoke Test

With ngrok running:

```bash
curl -H "User-Agent: GitHub-Hookshot/test" \
  https://your-static-domain.ngrok-free.dev/api/v1/health
```

Expected result:

```json
{"service":"dokscp-backend","status":"ok"}
```

Then use the GitHub App settings page to redeliver the `ping` event. DOKSCP should return `200` with:

```json
{"message":"GitHub webhook ping received"}
```
