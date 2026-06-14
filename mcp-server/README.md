# StackPilot MCP Server

The StackPilot MCP server is a stdio Model Context Protocol bridge for IDE agents. It lets tools such as VS Code agents, Antigravity, Claude Code, Cursor, Codex, Claude Desktop, and Gemini CLI deploy projects into StackPilot without opening the dashboard.

## What the IDE should call

For local code, agents should call:

```text
STACKPILOT_deploy_local_project
```

Use this tool when the user says things like:

```text
Deploy my current project to StackPilot.
Deploy this FastAPI server.
Deploy the local app and give me the preview link.
```

The tool stages the local workspace into the host `local-projects` folder, creates an StackPilot project with `source_type=local`, triggers the normal build worker, deploys to local Kubernetes by default, waits for completion, and returns the deployment id plus preview URL when available.

## Required environment

```json
{
  "mcpServers": {
    "stackpilot-platform": {
      "command": "node",
      "args": ["/absolute/path/to/StackPilot/mcp-server/src/index.js"],
      "env": {
        "STACKPILOT_MCP_TOKEN": "STACKPILOT_mcp_xxx",
        "STACKPILOT_API_URL": "http://localhost:8090/api/v1",
        "STACKPILOT_FRONTEND_URL": "http://localhost:3000",
        "STACKPILOT_LOCAL_PROJECTS_HOST_ROOT": "/absolute/path/to/StackPilot/local-projects",
        "STACKPILOT_LOCAL_PROJECTS_CONTAINER_ROOT": "/app/local-projects"
      }
    }
  }
}
```

Generate `STACKPILOT_MCP_TOKEN` in the StackPilot dashboard under Settings > MCP Integrations.

## Local project staging

The backend container can only read folders mounted under `/app/local-projects`. The MCP server makes arbitrary IDE projects deployable by copying the requested local project into:

```text
/absolute/path/to/StackPilot/local-projects
```

It does not copy common generated or sensitive folders such as `.git`, `node_modules`, `.venv`, `.env`, `dist`, `build`, and `uploads`.

## Smoke tests

Protocol and health smoke test:

```powershell
cd "/absolute/path/to/StackPilot/mcp-server"
npm run smoke
```

Authenticated smoke test:

```powershell
$env:STACKPILOT_MCP_TOKEN = "STACKPILOT_mcp_xxx"
npm run smoke
```

Dry-run a local project through the MCP tool:

```powershell
$env:STACKPILOT_MCP_TOKEN = "STACKPILOT_mcp_xxx"
$env:STACKPILOT_MCP_SMOKE_PROJECT = "C:\path\to\your\project"
npm run smoke
```

Actually deploy that smoke project:

```powershell
$env:STACKPILOT_MCP_TOKEN = "STACKPILOT_mcp_xxx"
$env:STACKPILOT_MCP_SMOKE_PROJECT = "C:\path\to\your\project"
$env:STACKPILOT_MCP_SMOKE_DEPLOY = "1"
npm run smoke
```
