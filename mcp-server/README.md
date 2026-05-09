# DOKSCP MCP Server

The DOKSCP MCP server is a stdio Model Context Protocol bridge for IDE agents. It lets tools such as VS Code agents, Antigravity, Claude Code, Cursor, Codex, Claude Desktop, and Gemini CLI deploy projects into DOKSCP without opening the dashboard.

## What the IDE should call

For local code, agents should call:

```text
dokscp_deploy_local_project
```

Use this tool when the user says things like:

```text
Deploy my current project to DOKSCP.
Deploy this FastAPI server.
Deploy the local app and give me the preview link.
```

The tool stages the local workspace into the host `local-projects` folder, creates an DOKSCP project with `source_type=local`, triggers the normal build worker, deploys to local Kubernetes by default, waits for completion, and returns the deployment id plus preview URL when available.

## Required environment

```json
{
  "mcpServers": {
    "dokscp-platform": {
      "command": "node",
      "args": ["C:/Users/adiro/OneDrive/Desktop/ALL websites/DOKSCP/mcp-server/src/index.js"],
      "env": {
        "DOKSCP_MCP_TOKEN": "dokscp_mcp_xxx",
        "DOKSCP_API_URL": "http://localhost:8090/api/v1",
        "DOKSCP_FRONTEND_URL": "http://localhost:3000",
        "DOKSCP_LOCAL_PROJECTS_HOST_ROOT": "C:/Users/adiro/OneDrive/Desktop/ALL websites/DOKSCP/local-projects",
        "DOKSCP_LOCAL_PROJECTS_CONTAINER_ROOT": "/app/local-projects"
      }
    }
  }
}
```

Generate `DOKSCP_MCP_TOKEN` in the DOKSCP dashboard under Settings > MCP Integrations.

## Local project staging

The backend container can only read folders mounted under `/app/local-projects`. The MCP server makes arbitrary IDE projects deployable by copying the requested local project into:

```text
C:/Users/adiro/OneDrive/Desktop/ALL websites/DOKSCP/local-projects
```

It does not copy common generated or sensitive folders such as `.git`, `node_modules`, `.venv`, `.env`, `dist`, `build`, and `uploads`.

## Smoke tests

Protocol and health smoke test:

```powershell
cd "C:\Users\adiro\OneDrive\Desktop\ALL websites\DOKSCP\mcp-server"
npm run smoke
```

Authenticated smoke test:

```powershell
$env:DOKSCP_MCP_TOKEN = "dokscp_mcp_xxx"
npm run smoke
```

Dry-run a local project through the MCP tool:

```powershell
$env:DOKSCP_MCP_TOKEN = "dokscp_mcp_xxx"
$env:DOKSCP_MCP_SMOKE_PROJECT = "C:\path\to\your\project"
npm run smoke
```

Actually deploy that smoke project:

```powershell
$env:DOKSCP_MCP_TOKEN = "dokscp_mcp_xxx"
$env:DOKSCP_MCP_SMOKE_PROJECT = "C:\path\to\your\project"
$env:DOKSCP_MCP_SMOKE_DEPLOY = "1"
npm run smoke
```
