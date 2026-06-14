# MCP and IDE Agents

StackPilot provides an MCP server so IDE agents can perform real deployments through audited platform APIs.

## Recommended Tools

- `STACKPILOT_health`
- `STACKPILOT_verify_auth`
- `STACKPILOT_inspect_local_project`
- `STACKPILOT_deploy_current_project`
- `STACKPILOT_deploy_local_project`
- `STACKPILOT_deploy_github_repo`
- `STACKPILOT_get_deployment_status`
- `STACKPILOT_get_deployment_logs`
- `STACKPILOT_trigger_redeploy`
- `STACKPILOT_delete_deployment`

Backward-compatible generic aliases are also available, such as `deploy_github_repo` and `get_deployment_status`.

## Environment

Generate an MCP token in the dashboard, then configure your IDE MCP process:

```bash
STACKPILOT_MCP_TOKEN=STACKPILOT_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
STACKPILOT_API_URL=http://localhost:8090/api/v1
STACKPILOT_FRONTEND_URL=http://localhost:3000
STACKPILOT_PROJECT_PATH=/absolute/path/to/current/project
```

## Direct Node Run

```bash
cd mcp-server
npm install
STACKPILOT_MCP_TOKEN=... node src/index.js
```

## Container Run

```bash
docker build -t stackpilot-mcp ./mcp-server
docker run --rm -i \
  -e STACKPILOT_MCP_TOKEN=... \
  -e STACKPILOT_API_URL=http://host.docker.internal:8090/api/v1 \
  -v "$PWD:/workspace:ro" \
  stackpilot-mcp
```

## How Agents Should Use It

When a user says "deploy my current project", the IDE agent should not:

- Manually create a Dockerfile.
- Manually copy files with SCP.
- Manually run remote shell commands.
- Manually create a Kubernetes manifest.

It should call `STACKPILOT_deploy_current_project`. That tool packages source, uploads the artifact, creates or updates the StackPilot project, queues the deployment, polls status, and returns the preview URL.

## Smoke Test

```bash
cd mcp-server
npm run smoke
```

The smoke test checks tool registration and backend connectivity. A full deployment test needs a running backend and valid MCP token.
