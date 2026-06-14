# Extreme Test Cases

This checklist is meant for smoke testing and manual hardening before calling a StackPilot install production-ready.

## Project Creation

- Create a GitHub project with default environments. Expect `development -> dev` and `production -> main`.
- Create a GitHub project with custom branches such as `staging` and `release`. Expect duplicate names or duplicate branches to be rejected.
- Create a project where production requires CI and development does not. Expect the policy to be visible on the project detail page.
- Create a remote-host GitHub project without a remote connection. Expect project creation to fail clearly.
- Create a local source project and try to map a remote-host environment. Expect rejection and guidance to use the MCP artifact path.

## GitHub Webhooks

- Push to an unmapped branch. Expect no deployment.
- Push to `dev` with auto deploy enabled. Expect one deployment for the development environment.
- Push to `main` with production auto deploy disabled. Expect no deployment.
- Enable production auto deploy and push to `main`. Expect a production deployment candidate.
- Send a webhook with an invalid `X-Hub-Signature-256`. Expect `401`.
- Replay the same GitHub delivery id and commit. Expect no duplicate deployment.
- Push three commits quickly to the same branch. Expect older queued or blocked deployments to become `superseded`.

## CI/CD Gates

- Push to a CI-required branch. Expect deployment status `blocked` and CI status `pending`.
- Send a successful `check_suite` for that commit. Expect status `pending` and a queued build.
- Send a failed `check_suite` or failed `check_run`. Expect status `failed_ci`, no build, and no live replacement.
- Send a successful `check_run` before the aggregate `check_suite`. Expect StackPilot to keep waiting for `check_suite`.
- Send CI events for a commit from another repository. Expect no deployment update.

## Build Promotion and Cleanup

- Deploy commit A successfully. Expect it to become the environment current deployment.
- Deploy commit B successfully with cleanup enabled. Expect commit B to become current and commit A to become `retired`.
- Deploy commit B with cleanup disabled. Expect commit A to remain available in history and runtime cleanup not to be forced.
- Push commit C while commit B is still building. Expect B to be cleaned as `superseded` if it finishes after C becomes the newer candidate.
- Make commit C fail to build. Expect commit B or the last good deployment to remain current.
- Confirm cleanup removes Kubernetes deployment, service, ingress, remote Docker container, Docker image, remote workspace, and local build workspace where applicable.

## Runtime Targets

- Build a GitHub repo to local Docker. Expect image build and `built` or `running` status based on runtime type.
- Build a GitHub repo to local Kubernetes. Expect namespace resources and preview URL.
- Build a GitHub repo to remote Docker. Expect remote container and preview URL.
- Build a GitHub repo to remote Kubernetes. Expect temporary Docker container cleanup before Kubernetes deployment.
- Delete a project with no active jobs. Expect all deployments cleaned before the project row is deleted.
- Delete a project with running jobs. Expect deletion to be blocked instead of leaving orphaned resources.

## MCP and Local IDE Deployments

- From an MCP client, deploy a local FastAPI project. Expect source artifact upload, backend-audited build, and preview URL.
- Deploy a local static HTML folder with no Dockerfile. Expect deterministic or AI-assisted Dockerfile generation and a preview URL.
- Deploy a multi-file Python project with requirements. Expect project inspection, generated Dockerfile, build logs, and runtime health.
- Try to deploy a local project to a named remote host. Expect the MCP tool to use source artifacts instead of direct untracked SCP.

## Security and Failure Modes

- Use an expired GitHub OAuth token. Expect repo listing or build clone to fail with actionable auth messaging.
- Use a private GitHub repo without `repo` scope. Expect clone failure without leaking tokens in logs.
- Disable Docker on the target host. Expect build/runtime failure with Docker daemon diagnostics.
- Use an invalid Kubernetes context. Expect Kubernetes deployment failure and no current deployment replacement.
- Remove the old runtime manually before cleanup. Expect cleanup to be idempotent or report the missing resource clearly.
- Restart the backend while a job is running. Expect interrupted jobs to be recovered or failed safely.
- Restart Redis. Expect durable database jobs to remain claimable.
- Send webhook traffic above the API rate limit. Expect rate limiting except for trusted webhook behavior configured in production.

## UI Verification

- The create project dialog must show environment branch mapping, auto deploy, CI gate, and cleanup policy.
- The project detail page must show current deployment, branch, commit, CI status, trigger source, and preview URL.
- Failed CI must be distinguishable from build failure.
- Superseded and retired deployments must remain in history for audit.
- The dashboard must not show old legacy branding.
