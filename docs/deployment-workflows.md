# Deployment Workflows

StackPilot supports several source and runtime paths.

The dashboard uses the [guided project setup](project-setup.md). New projects
start with one production environment and the repository default branch. CI and
automatic deploys are opt-in; existing required-CI policies also gate manual
deploys and retries. The worker pins an immutable commit before build or CI.
Variable-triggered rebuilds retain the source revision and environment context.

An environment can map `develop` to local services and `main` to hosted services.
Keep the same variable names in the application and save the corresponding
values under each environment. The executor overlays project variables,
environment variables, project credentials, then environment credentials. Runtime
placement is independent: an app running in local Docker can use a hosted API
or database.

During recovery the agent receives the selected environment/branch/commit,
configured branch mappings, variable names and scopes, and dotenv key inventory.
Values stay with the executor. `check_service_connection` accepts variable and
credential-key references and returns a private read-only probe result. Relative
API paths and local/private service names require verification in the deployment
network; remote database TCP reachability does not prove authentication. Recovery
can edit or create source/configuration, run the preserved acceptance checks, and
rebuild that same deployment. It must preserve persistent production service links
instead of silently substituting empty local databases.

## GitHub Repository

1. Create a project with `source_type=github`.
2. Select the repository and optional credentials.
3. Create a deployment.
4. Trigger build.
5. StackPilot clones, builds, stores logs, and deploys.

Private repositories require either a connected GitHub account or a project token with clone access. Password authentication is not supported by GitHub for Git operations.

## SSH Source Path

Use this when the source already exists on a saved server.

1. Save an SSH, Tailscale, or Headscale connection.
2. Create a project from SSH source.
3. Choose local build or remote-host execution.
4. StackPilot reads the source and runs the configured build path.

## Host-Mounted Local Source

Local source projects must live under the allowed local source root mounted into the backend container. This prevents arbitrary laptop paths from being read by the backend.

## MCP Source Artifact

This is the production path for IDE agents.

1. IDE agent calls `STACKPILOT_deploy_current_project`.
2. MCP inspects the workspace.
3. MCP stages files using ignore rules.
4. MCP creates a tar archive and checksum.
5. MCP uploads the artifact to StackPilot.
6. Backend creates an artifact-backed deployment.
7. Worker extracts the artifact locally or on the remote host.
8. Worker builds and deploys.
9. MCP returns the deployment status and preview URL.

## No Dockerfile Projects

If a project does not contain a Dockerfile, StackPilot tries deterministic generators first. It detects common stacks such as static HTML, Node, Python, FastAPI, and other known shapes. When deterministic generation is not enough, AI Dockerfile planning can analyze the source tree and generate a plan.

## Frontends with hosted backend and database services

A repository can contain backend source and a local Compose development stack
while its production frontend connects to an existing hosted API and database.
StackPilot preserves that production arrangement.

For a Vite repository with a root `vercel.json` declaring the production build,
output directory, and literal HTTPS API rewrites, the planner selects the
frontend build. It translates `/api/:path*` rewrites into an HTTPS proxy in the
frontend runtime, including streamed responses, and preserves SPA navigation.
Public project variables such as `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` reach the selected frontend directory at build
time. Private runtime credentials are excluded from the browser build.

The development Compose file remains in the source, but is not launched by this
frontend recipe. Recovery verifies the original production frontend build and
the resulting runtime. A declared Render health route is also checked through
the new frontend proxy. It does not recreate the already hosted database or run
unrelated acceptance suites for the external backend source.

An explicit `stackpilot.json` remains authoritative. Its `deployment_mode` can
be `auto` (the existing default), `dockerfile`, or `compose`. A user-supplied
Dockerfile is not silently replaced. Unsupported production rewrite expressions
or shell commands require an explicit deployment recipe; they are not discarded.

## Single Script and Multi Script Projects

For single-file or multi-file projects, StackPilot packages the whole selected source root. The Dockerfile planner chooses the entrypoint based on detected files, dependency manifests, imports, common server frameworks, and port hints.

## Remote Host Deployment

For a prompt such as "deploy my project to nedway", the IDE agent should call MCP with `vps_connection_name=nedway`. StackPilot resolves the saved connection, uploads the artifact, extracts it on that host, builds remotely, deploys there, and returns the runtime URL.

## Headscale Servers

Headscale is supported through the same SSH-over-tailnet model as Tailscale. The StackPilot backend machine must already be joined to your Headscale tailnet and able to run:

```bash
ssh user@100.x.y.z
```

or:

```bash
ssh user@server-name.your-tailnet.ts.net
```

After that works from the backend host, save the server in **Settings -> Remote Connections -> Headscale SSH**. StackPilot stores the host, username, and connection type, but it does not store a password or private key for Headscale. Builds and deployments then reuse the backend machine's authenticated Headscale/Tailscale SSH session.
