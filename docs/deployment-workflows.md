# Deployment Workflows

DOKSCP supports several source and runtime paths.

## GitHub Repository

1. Create a project with `source_type=github`.
2. Select the repository and optional credentials.
3. Create a deployment.
4. Trigger build.
5. DOKSCP clones, builds, stores logs, and deploys.

Private repositories require either a connected GitHub account or a project token with clone access. Password authentication is not supported by GitHub for Git operations.

## SSH Source Path

Use this when the source already exists on a saved server.

1. Save an SSH, Tailscale, or Headscale connection.
2. Create a project from SSH source.
3. Choose local build or remote-host execution.
4. DOKSCP reads the source and runs the configured build path.

## Host-Mounted Local Source

Local source projects must live under the allowed local source root mounted into the backend container. This prevents arbitrary laptop paths from being read by the backend.

## MCP Source Artifact

This is the production path for IDE agents.

1. IDE agent calls `dokscp_deploy_current_project`.
2. MCP inspects the workspace.
3. MCP stages files using ignore rules.
4. MCP creates a tar archive and checksum.
5. MCP uploads the artifact to DOKSCP.
6. Backend creates an artifact-backed deployment.
7. Worker extracts the artifact locally or on the remote host.
8. Worker builds and deploys.
9. MCP returns the deployment status and preview URL.

## No Dockerfile Projects

If a project does not contain a Dockerfile, DOKSCP tries deterministic generators first. It detects common stacks such as static HTML, Node, Python, FastAPI, and other known shapes. When deterministic generation is not enough, AI Dockerfile planning can analyze the source tree and generate a plan.

## Single Script and Multi Script Projects

For single-file or multi-file projects, DOKSCP packages the whole selected source root. The Dockerfile planner chooses the entrypoint based on detected files, dependency manifests, imports, common server frameworks, and port hints.

## Remote Host Deployment

For a prompt such as "deploy my project to nedway", the IDE agent should call MCP with `vps_connection_name=nedway`. DOKSCP resolves the saved connection, uploads the artifact, extracts it on that host, builds remotely, deploys there, and returns the runtime URL.

## Headscale Servers

Headscale is supported through the same SSH-over-tailnet model as Tailscale. The DOKSCP backend machine must already be joined to your Headscale tailnet and able to run:

```bash
ssh user@100.x.y.z
```

or:

```bash
ssh user@server-name.your-tailnet.ts.net
```

After that works from the backend host, save the server in **Settings -> Remote Connections -> Headscale SSH**. DOKSCP stores the host, username, and connection type, but it does not store a password or private key for Headscale. Builds and deployments then reuse the backend machine's authenticated Headscale/Tailscale SSH session.
