# MCP and IDE Agents

DOKSCP provides an MCP server so IDE agents can perform real deployments through audited platform APIs.

## Recommended Tools

- `dokscp_health`
- `dokscp_verify_auth`
- `dokscp_inspect_local_project`
- `dokscp_deploy_current_project`
- `dokscp_deploy_local_project`
- `dokscp_deploy_github_repo`
- `dokscp_get_deployment_status`
- `dokscp_get_deployment_logs`
- `dokscp_trigger_redeploy`
- `dokscp_delete_deployment`

Backward-compatible generic aliases are also available, such as `deploy_github_repo` and `get_deployment_status`.

## Environment

Generate an MCP token in the dashboard, then configure your IDE MCP process:

```bash
DOKSCP_MCP_TOKEN=dokscp_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DOKSCP_API_URL=http://localhost:8090/api/v1
DOKSCP_FRONTEND_URL=http://localhost:3000
DOKSCP_PROJECT_PATH=/absolute/path/to/current/project
```

## Direct Node Run

```bash
cd mcp-server
npm install
DOKSCP_MCP_TOKEN=... node src/index.js
```

## Container Run

```bash
docker build -t dokscp-mcp ./mcp-server
docker run --rm -i \
  -e DOKSCP_MCP_TOKEN=... \
  -e DOKSCP_API_URL=http://host.docker.internal:8090/api/v1 \
  -v "$PWD:/workspace:ro" \
  dokscp-mcp
```

## How Agents Should Use It

When a user says "deploy my current project", the IDE agent should not:

- Manually create a Dockerfile.
- Manually copy files with SCP.
- Manually run remote shell commands.
- Manually create a Kubernetes manifest.

It should call `dokscp_deploy_current_project`. That tool packages source, uploads the artifact, creates or updates the DOKSCP project, queues the deployment, polls status, and returns the preview URL.

## Smoke Test

```bash
cd mcp-server
npm run smoke
```

The smoke test checks tool registration and backend connectivity. A full deployment test needs a running backend and valid MCP token.
