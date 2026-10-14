# StackPilot capability and organization review

Reviewed 13 October 2026 against the current working tree. This is an inventory
of implemented paths and their boundaries, not a new compatibility benchmark.
The review used source inspection and read-only service checks. It did not run
new application deployments, mutate memberships, or test every framework.

## Present position

StackPilot is primarily a self-hosted Linux application delivery platform with
repository repair, browser testing, infrastructure operations, and team
workspaces. Web applications and APIs have the broadest delivery support.
Other workloads use explicit contracts and matching execution adapters.
Recognizing a stack, building an artifact, running it, testing its behavior,
and publishing it are separate capabilities.

At review time the dashboard, backend, AI service, PostgreSQL and Redis reported
healthy container status. Local and remote browser containers were running.
The AI service had an Android worker configured, but its read-only capabilities
request failed with ConnectError. Android device execution was therefore not
available from the current installation during this review. No remote Docker
or Kubernetes target was newly qualified in this review.

## Application and workload matrix

| Application/workload | Implemented delivery path | Boundary |
| --- | --- | --- |
| Static sites | Serve compiled HTML/CSS/JavaScript through a web runtime | Build output and application checks must be valid. |
| Frontend SPAs | Node build/static output, SPA routing, browser render verification | Framework-specific requirements still need correct scripts and dependencies. |
| Server-rendered web apps | Node/Python or other Linux server runtime | Requires the actual start command, port and matching SDK. |
| PWAs | The ordinary web deployment path | Dedicated offline, push-notification and installability qualification is not built into this support claim. |
| REST/HTTP APIs | HTTP health/status/body checks and configurable acceptance | HTTP availability alone does not prove all endpoints or business behavior. |
| Full-stack applications | Local Docker Compose and configured stateless component graphs | Explicit component/primary-service selection may be needed. Production data migration is separate. |
| Frontend with existing hosted API/database | Environment-specific variables and credentials, private connection probes, supported production proxy recipe | Preserve hosted dependencies. Generic provider provisioning and every rewrite syntax are not supported. |
| Monorepositories | Selected component roots and version-2 dependency graph compiled into local Compose | Ambiguous graphs require a contract. Mixed native adapters and declared stateful component promotion are not implemented. |
| Background workers | Process runtime and declared process assertions | They do not receive a fabricated website preview. |
| Finite/batch jobs | Bounded job execution, successful exit and declared output checks | General cron/event scheduling is not established by a finite-job adapter. |
| Interactive CLI apps | Console adapter and explicit input/output scenarios | General rich TUI behavior is not comprehensively qualified. |
| Libraries/packages/build artifacts | Explicit Linux build recipe, required checks, ZIP/output manifest and SHA-256 | No general package-registry publication adapter. |
| TCP/gRPC services | Container process and TCP connectivity lane | Protocol-level business verification needs declared additional checks. |
| Native Android | Gradle-wrapper APK build, discovered unit tests/lint, APK signature verification; local emulator install/launch/native scenarios | Requires a reachable configured worker. Current worker unreachable. One development device/release; no production device fleet or Play publication. |
| Linux desktop apps | X11 application on Xvfb, mapped-window checks, noVNC pointer/keyboard preview; Compose Desktop and explicit portable recipes | Debian/Ubuntu-compatible runtime requirements. Native GUI acceptance is narrower than web browser acceptance. |
| Native Windows apps | Workload recognition/contract | No general isolated native Windows build/run executor. Android worker running on Windows does not provide this capability. |
| macOS/iOS apps | Workload recognition/required-worker contract | No completed matching build/run/signing/publication adapter. |
| Flutter/React Native native apps | Built-in Flutter/Expo web-preview generators; no general qualified native pipeline | Native target builds/packaging are missing. Bare React Native currently falls toward Expo web generation. Web-preview success does not establish native mobile delivery support. |
| ML/data applications | CPU-compatible Linux services/jobs through ordinary container recipes; connect to configured external model providers | No qualified GPU worker fleet, GPU scheduler or arbitrary hardware support. |
| Other languages/frameworks | Existing Dockerfile or explicit Linux build_recipe | Generic execution is conditional on dependencies, entrypoint, OS, outputs and successful verification; not universal automatic support. |

## Language/toolchain paths

The deterministic Linux recipe selector includes Node, Python, Go, Rust, Java,
.NET, Ruby and PHP. It selects versioned SDKs from repository evidence. Java
expects the repository's Maven/Gradle wrapper; Ruby/PHP need an explicit
entrypoint where detection cannot establish it. C/C++ and unusual stacks can
use a supplied Dockerfile or explicit recipe; manifest detection alone is not
an automatic application build adapter.

The Node discovery paths recognize examples including React/Vite, Next.js,
Vue/Nuxt, Angular, Svelte, Gatsby, Express, Fastify and Koa. Python discovery
recognizes FastAPI, Flask, Django, Streamlit, Gradio, Dash, aiohttp, Tornado,
Bottle and Sanic. These are recognized build shapes, not a guarantee for every
version or project. .NET delivery is the Linux-compatible lane. Supplied
Dockerfiles retain authority; the platform does not silently replace them.

## Built-in application templates

The current catalog has 12 top-level templates:

PostgreSQL, MySQL, MariaDB, Redis, MongoDB, RabbitMQ, NATS, MinIO, Grafana,
Prometheus, Adminer and Nginx.

These generate container configurations. Running a database template is not
equivalent to providing a fully managed database service with replication,
point-in-time recovery, upgrades and data-safe rollback.

## Platform features

| Area | Implemented capabilities | Qualification boundary |
| --- | --- | --- |
| Source import | GitHub public/private sources, authorized host-mounted local folders, saved SSH source paths, checksum-backed MCP source artifacts, application templates | Private source/dependency access requires configured credentials. |
| Environments | Project/environment variables and secrets, dotenv import/selection, branch-to-environment mappings, selected commit context | Real values remain with the executor; agent environment context contains key names/scopes. No broad organization-wide secret inheritance. |
| Build/delivery | Dockerfiles, deterministic generators, AI planning fallback, build-only, local Docker/Compose, configured local Kubernetes, remote single-image Docker/Kubernetes | Remote Compose is explicitly blocked pending its adapter. Automatic cloud VM allocation is not implemented. |
| Release lifecycle | Durable build jobs, cancellation/supersession, logs, verified local candidates, local gateway publication, retained local rollback checkpoints, Kubernetes rollout controls | Equivalent multi-provider/stateful release safety is not qualified. Public routing requires configuration; loopback previews are not automatically phone reachable. |
| GitHub/CI | OAuth/PAT/GitHub App paths, push/check webhooks, immutable commit pins, optional automatic deploys and required CI | Trusted-check policy exists globally; per-project policy editing/live external qualification remain open. |
| AI repository work | Source inspection/edit/create, task-scoped workers, Linux SDK selection/custom SDK build, scoped agent collaboration, acceptance checks, repair/rebuild, bounded incident retries | A recent hosted-frontend healing case passed. That is not a benchmark for arbitrary unfinished repositories or universal repair success. |
| AI context | Selected project/deployment/environment/branch/commit, configuration scopes, dotenv key inventory, value-free private connection results | A successful database TCP probe does not prove database authentication. Context is not an exhaustive remote branch catalog. |
| AI providers/chat | Configured provider connections, NVIDIA NIM/OpenAI-compatible endpoints, model selection, fast/thinking modes, streaming chat, saved history/context | Availability/capability depends on the configured provider. Provider preferences are user scoped. |
| Browser testing | Local/remote/host modes, live view/control, page observations, forms/selects/calendars, tabs/frames, console inspection, assertions, generic audits and declared workflows | CAPTCHA, missing credentials, ambiguous controls and unsupported geometry can block. Native Android uses its separate adapter. |
| Long browser campaigns | Durable bounded campaigns, pause/resume/stop, permissions/questions, paginated results and sampled replay | Bounded time/token/operation/storage limits; recordings do not include website audio. |
| Dictation | Live English prompt transcription, partial/final text, red orb while capturing, authenticated ephemeral speech sessions | No automatic voice attachment. Model accuracy depends on speech/microphone conditions. |
| Infrastructure | Docker/Kubernetes inventory, claims, details/YAML/events/logs, claimed-resource lifecycle controls, Kubernetes scale/rollout/node controls and dry runs | Inventory depends on reachable Docker/Kubernetes contexts. Claims are currently user scoped. |
| Clusters/remote hosts | Saved SSH, Tailscale/Headscale SSH, k3s control-plane bootstrap, worker joins, status/inventory, SSH terminal | No continuous desired-topology reconciliation, automatic edge/cloud failover policy or full add-on management. |
| Observability | Deployment/runtime health, logs, metrics, resource visualization, cost attribution; optional Prometheus/Grafana/Loki stack | Estimated resource cost is not billing. Optional services must be installed/configured. |
| Security/access | Account auth, Google/GitHub sign-in paths, password reset, encrypted stored credentials, audited secret reveal, login/audit history, role checks, scoped/expiring/revocable MCP tokens | Organization policies and authorization consistency need the work listed below. |
| Remote access | Paired devices/phone access, revocation, recent connections/history, authenticated gateway/session paths | Phone access is dashboard access, not native mobile app deployment. |
| Developer interfaces | Dashboard, authenticated REST API, Python CLI and Node MCP bridge for IDE deployment/status/logs/redeploy | User tokens do not create organization service identities or fine resource-scoped roles. |
| Installation | Self-hosted setup on Windows/macOS/Linux using Docker; service profiles and guided setup/update path | Host installation support is distinct from native application execution on those operating systems. |

## Organizations: present features

- Automatic personal workspace and multiple shared organizations.
- Workspace switching and project filtering.
- Owner/admin/member/viewer roles backed by membership-based project access.
- Member lists, email/link invitations, pending invitation expiry/revocation,
  member removal and role changes. Email delivery requires working SMTP.
- Project transfer through the backend and shared project/deployment access.
- Last-owner protection; another owner can be promoted before demotion/leaving.
- Organization/membership actions recorded in the audit log.
- Backend self-service leave for shared organizations; the current organization
  page lacks a clear leave action.

## Organizations: gaps and priorities

| Priority | Gap | Concrete reason / desired result |
| --- | --- | --- |
| First | Consistent authorization and revocation | Some AI paths use creator OR membership checks; AI trigger_build checks default viewer-level access. All source/build/secret/infrastructure mutations should enforce current role consistently, and removal/demotion must revoke every path. Static finding; no user deployment was triggered to reproduce it. |
| First | Verified, usable invitation onboarding | Signup auto-claims invitations by matching email without an email-ownership verification gate in the local registration path. Production first_user_only registration can also prevent an unregistered invitee from creating an account. Invitations need verified acceptance compatible with registration policy. |
| First | Organization-wide audit view | Current login/audit endpoints filter by the current user (50 login entries/100 audit entries). Owners cannot use them as a complete organization activity trail. Add organization identity, authorized actor/resource filtering, pagination/export and retention controls. |
| Next | Organization-owned integrations and infrastructure | AI provider preferences, SSH connections, clusters and claims are largely user owned. Some project target selection reuses a teammate's connection, but that is not a first-class organization integration with lifecycle/roles. Shared resources should survive member departure. |
| Next | Fine permissions and project groups | Four roles apply broadly across organization projects. No custom role/project team model separating deploy, production deploy, source edit, secret reveal, infrastructure admin and billing. |
| Next | Protected environments / organization policies | CI settings and AI action approvals exist, but not organization-wide production approvers, enforced branch rules, allowed deployment targets or enforced agent-access policy. |
| Next | Shared secret management | Project/environment secrets exist; organization-level inheritance, scoped sharing, versioned rotation and organization credential policy are missing. |
| Next | Member administration UX | Clear leave flow, ownership handover, project transfer UI, invitation resend/status and offboarding checks for owned integrations/jobs. Backend capabilities should be made usable without relying on direct API calls. |
| Later | Identity administration | No implemented enterprise SAML/OIDC organization SSO, SCIM provisioning, MFA enforcement, verified-domain membership policy or organization session-control policy found. Google/GitHub account login is a separate feature. |
| Later | Service identities | MCP tokens have read/deploy/admin scopes, expiry and revocation, but remain tied to users. Organization service accounts and project/environment restrictions need a dedicated model. |
| Later | Usage and budgets | Global/task/container limits and resource cost attribution exist. Per-organization build/AI/storage/device budgets, usage reporting, seat billing and invoices are not implemented. |
| Before multi-tenant production | Isolation and operations | Disposable fleet scheduling, strong tenant isolation, shared artifact storage, bounded retention, load/recovery qualification and application data backup/migration/restore gates remain broader platform work. |

The earlier completion plan is useful for broader gaps, but its October 1 live
healing status predates the successful October 13 hosted-frontend repair. Do
not use the old status to erase that success, or one success to mark every
completion workstream finished. The AI guide's older voice-recording paragraph
also predates the current dictation implementation; docs/dictation.md describes
the microphone behavior now.

The owner's subsequent clarification focuses on production technology coverage;
unfinished product functionality belongs to the project owner. The deeper
[technology coverage audit](technology-coverage-gap-audit-2026-10-13.md) defines
category-specific deliverables, native toolchain gaps and 40 engineering items.

## Source basis

- src/controllers/OrganizationController.{h,cpp}; frontend/src/app/dashboard/organization/page.tsx
- sql/migrations/044_organizations_and_rbac.sql, 046_fix_unknown_role_requirement.sql, 050_organization_invitations_and_management.sql
- src/controllers/AuthController.cpp (registrationAllowed, registerUser, getLoginHistory, getAuditLogs)
- src/controllers/AiController.cpp (_internal_agent_workspace, workspace_trigger_rebuild, trigger_build)
- src/controllers/ProjectController.cpp (organization selection/transfer); src/controllers/ProjectEnvironmentController.cpp
- src/controllers/SshController.cpp; src/controllers/SecretController.{h,cpp}; src/utils/JwtHelper.cpp
- src/services/ApplicationCatalog.cpp; src/services/CostModel.h
- deployment-runtime/{planner,linux_recipes,portable_build,native_build,repository_plan,sandbox_capabilities}.py
- ai-service/app/{repository_discovery,repository_toolchains,runtime_verification,dictation}.py
- ai-service/app/agent_runtime/tools.py; native-worker/{README.md,android_worker.py}
- docs/{deployment-workflows,production-cluster-management,ai-agent,agent-reliability-audit-2026-10-13,stackpilot-completion-plan}.md
- deployment-runtime/README.md; docs/mcp-ide-agents.md; docs/dictation.md
