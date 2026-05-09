# Environments and CI

DOKSCP supports project environments that map branches to deployment targets.

## Environment Model

Each project can have environments such as:

- `development` mapped to `dev`
- `production` mapped to `main`

Each environment stores branch, auto-deploy setting, CI requirement, execution mode, remote connection, runtime type, exposure mode, runtime scheme, and current deployment.

Each environment also has its own variable set. Shared project variables are injected into every build first; environment variables are then merged on top, so `production` can use production secrets and `development` can use sandbox values without creating two separate projects.

Project creation now fetches repository branches from GitHub and lets you configure these fields up front with branch selectors instead of typing branch names by hand. If a repository only has one branch, multiple environments may temporarily point at the same branch; only environments with auto deploy enabled will react to pushes.

The default map is:

- `development` -> `dev`, auto deploy enabled, CI optional, cleanup previous runtime after a newer successful build.
- `production` -> `main`, auto deploy disabled by default, CI required, previous runtime kept for rollback unless you enable cleanup.

The cleanup policy is deliberately success-gated: DOKSCP keeps the current environment deployment live while a newer commit is building. Only after the new commit builds and is promoted does it retire the previous deployment, remove runtime resources, remove the Docker image when possible, and clean local or remote build workspaces. Failed builds and failed CI never replace or delete the last good deployment.

## GitHub Push Automation

GitHub sends push events to:

```text
POST /api/v1/github/webhooks
```

DOKSCP verifies `X-Hub-Signature-256` when `GITHUB_WEBHOOK_SECRET` is set. It then matches repository and branch to configured project environments.

If a push targets `dev`, only the environment mapped to `dev` deploys. If a push targets `main`, only the environment mapped to `main` deploys.

The deployment records and checks out the exact pushed commit SHA, not just the branch head. This keeps rebuilds reproducible even if another commit lands while the job is waiting.

## CI Gating

When `require_ci=true`, DOKSCP creates a blocked deployment and waits for GitHub Checks or check suite events.

- Success: mark CI passed and queue deployment.
- Failure, cancellation, or timeout: mark deployment `failed_ci` and do not replace the live environment.
- No check events: after `DOKSCP_CI_NO_CHECKS_GRACE_SECONDS` DOKSCP marks CI `not_required` and continues, so repositories without workflows do not stay blocked forever.

Every deployment records the branch, commit SHA, trigger source, GitHub delivery id, CI status, and CI details so the dashboard can show what commit caused the update.

## Runtime URLs

Environments do not share a single runtime URL. Each environment points at its own current deployment. If both `development` and `production` have been deployed, the project can show two live preview/runtime URLs at the same time. A failed candidate never replaces the current environment pointer, so the previous good URL remains available.

## Superseding Older Commits

If several pushes arrive quickly for the same environment, DOKSCP cancels stale queued or blocked candidates and keeps the newest commit as the active candidate. If an older build completes after a newer candidate arrives, it is marked `superseded` and its runtime/image/workspace are cleaned up instead of being promoted.

This makes GitHub Actions the first CI source of truth. Native DOKSCP pipeline steps can be added later without removing GitHub Checks.

## Webhook Setup

Recommended production setup is the GitHub App model. In that mode, one central GitHub App webhook sends push and check events to DOKSCP for all repositories where the App is installed. Set `GITHUB_APP_WEBHOOK_MODE=true` to prevent DOKSCP from creating per-repository hooks.

See [GitHub App Integration](github-app.md) for the full setup.

When `GITHUB_APP_WEBHOOK_MODE=false`, `BACKEND_PUBLIC_URL` is a public HTTPS URL, `GITHUB_WEBHOOK_SECRET` is set, and the connected GitHub token has repo-hook permission, DOKSCP attempts to register a repository webhook automatically during project creation.

For manual setup, create a GitHub repository webhook:

- Payload URL: `https://your-domain/api/v1/github/webhooks`
- Content type: `application/json`
- Secret: same as `GITHUB_WEBHOOK_SECRET`
- Events: push, check suite, check run

The OAuth flow requests `admin:repo_hook` so DOKSCP can register hooks for OAuth-connected repositories. Existing users may need to reconnect GitHub after upgrading. For production at larger scale, use the GitHub App path because users install DOKSCP once and GitHub sends events centrally.
