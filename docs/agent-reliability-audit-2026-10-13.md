# Deployment repair investigation — 13 October 2026

This investigation follows the failed `multi-agent-rag` deployment
`5bb727ef-e89a-4a64-9637-3980906c5187`. Changes address observed platform
defects; successful command execution alone is never treated as a verified
release.

## What failed

The explicit Compose stack built and started its API and PostgreSQL services.
Both containers were healthy. Endpoint discovery probed `/`, which returned
HTTP 404; the API exposes `/health`. The original error described this as an
ambiguous endpoint even though no endpoint passed the configured route.

A proposed `stackpilot.json` used `health_path`, while the source parser read
only `health.path`. That silently discarded the attempted correction. The
delivery type was also inferred as a web application despite Compose deploying
an API and database without a frontend service.

The original incident did retry three times. Its repair commands repeatedly
failed because disposable workers lost separately installed dependencies,
network access was omitted, commands used the wrong component root or shell
syntax in argv, and test plugins were not installed. Restricted Ubuntu guests
were also used to install toolchains that already had admitted SDK images.
Fractional CPU requests were advertised but rejected by the executor.

Verbose installation output lost its final error, copied source permissions
prevented writes in restricted guests, and nonzero exits without an `error`
field escaped repeat accounting. Worker summaries could say "completed" after
their command failed. Terminal incidents could leave detached task leases
running. Acceptance plans could freeze an impossible execution environment
before checking its admission.

## Changes

- Disposable worker commands accept a confined component root and bounded
  setup argv. Dependencies and the command run in the same guest with each
  argument shell-quoted. Malformed shell argv receives actionable feedback.
- Test and build commands infer the component SDK and declared dependency
  groups. Explicit offline choices and operator network policy remain enforced.
  Pytest file paths copied from repository inventory are made relative to an
  already selected component when the actual file exists there; options,
  selectors, unknown paths, and traversal checks retain their meaning.
- Only the disposable source copy receives writable permissions. Returned
  changes still require task scope, source revision, and integration checks.
- Command output retains a bounded beginning and final tail. Disposable and
  persistent workers share this handling.
  Actual failed-test evidence takes priority over a simultaneous coverage
  failure. Invalid pytest options and missing paths receive specific guidance.
- Fractional CPU quotas match the published schema and retain operator limits.
- Retry accounting includes nonzero exits and survives checkpoints. A source
  fix resets the unchanged-command failure counter; three identical failures
  require a revised approach.
- Worker results retain actual exit codes, failure reasons, and bounded output
  tails. An unchanged task with a failed final check finishes as failed even
  when its written summary claims success.
- Existing component directories in task write scopes become confined
  `directory/**` prefixes before inheritance and overlap checks. Exact file
  scopes cannot expand a child task's capability to the whole directory.
- Terminal incidents fence matching repair runs and task leases in the same
  database transaction. Retryable incidents retain their checkpoints.
- Acceptance setup and capability admission are checked before a model plan
  freezes. Fresh guests cannot silently probe a nonexistent localhost service.
  Automatically derived repair checks also wait for SDK/network admission.
- Narrow FastAPI/Compose recovery initializes the original deployed component
  test suites. Repository completion contracts remain authoritative, and other
  delivery types retain the existing planner.
  Task workers receive the frozen roots, commands, SDKs, setup, and network
  choices before their first model turn, even when the lead omits this context.
- Health parsing accepts the normalized `health_path` spelling, rejects
  conflicting paths, and preserves explicit `health.path`. Endpoint failures
  distinguish zero passing services from multiple viable endpoints and report
  the actual HTTP response.
- Repair prompts and visible terminal messages include observed failure
  evidence. Build success still requires independent source acceptance and
  qualification of the exact resulting deployment job.

The project cards no longer display environment-count or last-release lines.
The deployment table drops the Monorepo badge, shortens generated release IDs
while retaining their full title, and keeps actions side by side. Secondary
actions have compact icons with accessible names and hover titles.

## Validation and remaining release evidence

- 61 AI runtime, completion, execution-profile, failure-diagnostic, and
  incident-lifecycle tests
  pass, including failed-command summary and checkpoint regressions.
- 36 team-runtime regression tests pass, covering scoped integration,
  delegation, lease recovery, and verification boundaries.
- 24 deployment executor, endpoint, and repository-plan tests pass.
- Production frontend and backend images build successfully; local services
  pass their health checks.
- Production browser tests pass at 375, 1440, and 1920 pixels. All deployment
  actions remain in one row, desktop tables fit without horizontal scrolling,
  removed card metadata and badges stay absent, and no page errors occur.
- Real disposable worker fixtures exercise declared dependency installation,
  component roots, writable copied source, scoped patch return, and unchanged
  original source. They run with the existing restricted Docker configuration.
- The original application's 151 API tests pass, but its coverage is **86.12%**
  against its existing **90%** requirement. This is a real acceptance failure,
  not an infrastructure error. That threshold is preserved.
- A fresh live repair uses the original API test plan and has corrected the
  source delivery contract to API, primary service `api`, and `/health`.
  Its worker is correctly reported as failed when coverage is insufficient,
  despite its summary reporting passing tests.
- That live trial exhausted three bounded attempts without a verified rebuild.
  Its added evaluation test still fails; the full run reports 151 original
  tests passing, one added test failing, and 86.35% coverage. The terminal
  incident closes its repair run and leaves zero active tasks or task leases.
  The last worker-context/admission changes are loaded in the local AI service;
  their complete regression coverage passes, but a subsequent successful live
  application recovery has not been demonstrated.

No tests, coverage thresholds, source ownership, lease fencing, or runtime
verification gates were disabled. The API coverage results above describe the
earlier Compose trial; the production scope was subsequently clarified below.

## Production frontend and existing hosted services

The user clarified that the backend and database were already hosted. The
repository confirms this arrangement: the root Vercel contract builds
`apps/web/dist` and forwards `/api/:path*` to the existing Render API. The saved
public variables point to the existing Supabase project. The root Compose file
describes local development, not the intended production deployment.

The planner now recognizes this declared Vite arrangement, preserves the
development Compose source, and selects a generated frontend Dockerfile. Its
nginx runtime preserves SPA navigation and the hosted HTTPS API proxy, including
streamed responses. Broker-provided public variables are copied to the selected
frontend directory before compilation; environment files are not served as
assets. A declared Render health path also becomes a real proxy release check.
Explicit StackPilot contracts and handwritten Dockerfiles remain authoritative.
Generated contracts are included when packaging this recipe for an SSH target.

Recovery freezes the original production frontend build as its readiness check.
It does not rebuild the already hosted API/database or manufacture API coverage
requirements for this frontend release. Original tests and thresholds remain
unchanged. Duplicate build checks execute once with their frozen environment.

The live retry exposed a Node heap failure in the 512 MiB acceptance worker.
The agent corrected its build environment, reran independent acceptance, and
released successfully. Default disposable worker memory is now 1 GiB, while
operator overrides remain authoritative. Heap failures receive a resource-specific
diagnostic. Malformed deployment/completion JSON edits are rejected before the
previous working file is replaced.

Fresh incident `ff2635ce-23b5-40c8-9292-bf651f7498f1` finished **healed**, backed by
completed job `14eff183-83bb-488a-b9eb-35573eb8811e`, not a model success claim.
The exact image passed the declared frontend build, browser render qualification,
and routed `/` and `/api/health` checks. `/api/ready` also returned HTTP 200 with
`ready`. The repair run closed with zero active tasks.

A fresh desktop browser opened **Create your first workspace**, with no failed
requests, failed assets, or JavaScript errors. Supabase Auth settings returned
HTTP 200 with anonymous users enabled. All three public Vite values were present
in the compiled frontend, and no `.env` files were exported. Workspace creation
and authenticated business workflows were not exercised. The initial render
observation briefly showed the repository's generic guest error; the independent
fresh browser check connected successfully, so this was not taken as evidence
that anonymous access was disabled.

Validation: 109 AI runtime regressions, 20 repository-plan tests, 3 command
executor tests, 7 existing portable-build tests, and 12 capability tests pass. The backend production
image builds successfully. The new backend and AI safeguards are loaded in the
healthy local services. Evidence and the browser screenshot are saved under
`tests/artifacts/hosted-frontend-*`.

Environment-aware recovery now loads executor-owned project/deployment metadata:
selected branch/commit, selected environment, environment branch mappings,
effective runtime target, variable names/scopes, and dotenv file/key inventory.
The context query does not select encrypted values or decrypt credentials.
Model source reads of dotenv templates return names with hidden values; actual
dotenv files are excluded from isolated agent source. Supplied client project
metadata is replaced with the authorized broker context.

The executor still injects real values privately with its existing precedence:
project variables, environment variables, project credentials, environment
credentials. A new connection tool accepts key references and performs a private
read-only external probe. Results omit URLs, credential/header values, response
bodies and exception text. HTTP results report status codes; database results
report TCP connectivity only, not authentication. Local/private endpoints require
checks in the deployment network. Redirects are not followed with credentials.

Recovery receives this context in both lead and worker prompts and preserves the
deployment's environment/branch on rebuild. Automatic production frontend
inference now respects a selected development environment's local Compose file;
local Docker placement alone never implies local dependencies. Explicit delivery
contracts remain authoritative. Branch context lists the selected source and
configured environment mappings, rather than claiming an exhaustive remote Git
branch catalog. These changes do not promise that unavailable providers or invalid
credentials can always be repaired without operator input.

Validation of this follow-up: 116 AI/runtime regressions, 21 repository-planner
tests, and 5 private-connection-probe tests pass. The backend production image
builds and both backend and AI service report healthy after loading the change.
The disposable live API qualification passes key-only context, selected
environment/branch, environment-variable override precedence, project/scoped
credential precedence, value-free probe results, and cross-user/deployment access
controls without starting model calls or application deployments.
