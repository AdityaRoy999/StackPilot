# Deployment contracts

## Toolchains beyond built-in generators

An explicit `build_recipe` in `stackpilot.json` supports Linux toolchains without adding framework names to the platform. Existing Dockerfiles are preserved. Declare the toolchain image, executable argument arrays, exact output roots, and a runtime command. Required repository tests run before outputs are exported; failed commands, missing outputs and escaping/symlink/private configuration paths block export.

```json
{
  "workload": "desktop",
  "tests_required": true,
  "tests": [["python3", "-m", "unittest", "discover", "-s", "tests"]],
  "build_recipe": {
    "image": "python:3.12-slim",
    "commands": [["python3", "build.py"]],
    "outputs": ["output"],
    "runtime_image": "python:3.12-slim",
    "runtime_setup": [["apt-get", "update"], ["apt-get", "install", "-y", "python3-tk"]],
    "runtime_command": ["/usr/bin/python3", "/app/output/app.py"]
  }
}
```

The desktop runtime currently requires a Debian/Ubuntu compatible Linux image and an X11 application. It launches the real executable on Xvfb, verifies a mapped application window, and streams it through noVNC with pointer/keyboard input. A Tk fixture has been built and clicked through the browser. This qualifies one real native application, not every desktop framework or every workflow. The fixture is in `tests/fixtures/deployment/portable-desktop`.

Other portable recipe workloads are web/API, worker, TCP/gRPC, and downloadable artifact. Artifacts export a ZIP and SHA-256 manifest. Native Android, iOS, Windows and macOS require platform-specific build/run adapters; a Linux recipe cannot convert those apps into browser applications. Phone access also requires reachable, authenticated preview routing.

Build recipes execute repository code inside the build image. Docker isolation alone is not a complete hostile-tenant boundary; production requires disposable workers, quotas, network policy and authenticated preview routing.

StackPilot discovers repository manifests and preserves supplied Dockerfiles. It generates build plans for supported stacks. Ambiguous choices require an optional `stackpilot.json`; a filename or a successful viewer page is not sufficient evidence of a working application.

Example API:

```json
{
  "version": 1,
  "workload": "api",
  "port": 8080,
  "health": {"path": "/ready", "statuses": [200]},
  "checks": [{"path": "/ready", "json_contains": {"ready": true}}],
  "tests_required": true,
  "tests": [["python", "-m", "pytest", "-q"]]
}
```

`workload` determines the verification scope. Web deployments receive a browser render smoke check. APIs receive HTTP status/content checks; TCP services receive connection checks. Local workers receive a fresh process observation, with no fabricated web preview. Configured finite jobs require successful exit and declared output checks; package delivery verifies generated artifacts and manifests. Interactive CLI workflows use the console adapter and explicit input/output assertions. Undeclared business workflows remain unverified in every lane.

Generated Node/Python/compiled templates execute repository test commands where supported. Supplied Dockerfiles remain under repository control: include test execution and `/stackpilot-evidence/tests.json` evidence, or their tests are reported as unrecorded. Set `tests_required` to block promotion without passed evidence. This evidence is a repository test result, not independent proof that arbitrary untrusted test code is meaningful.

To resolve entry ambiguity, use `entrypoint` as an argument array, `project` for an executable .NET project, `go_package` for a reported Go main package, or `rust_binary` for a Cargo binary target. Tests never run directly on the backend host; they execute in the submitted/generated build image. SDK versions, native libraries and signing credentials still have to match the source requirements.

Local Compose admission validates the resolved model, confines host bind mounts, rejects privileged/host access, limits resources and assigns loopback ports. Set `primary_service` when more than one HTTP endpoint is viable. Readiness is checked for every service; this does not test every service's business behavior. Unsupported Compose-to-Kubernetes semantics fail explicitly. Remote Compose is blocked until its isolation and routing adapter is qualified.

Android builds use the Gradle wrapper, unit tests and lint tasks where present, and verify APK signatures before an artifact runtime starts. Gradle dependencies use a BuildKit cache; SDK installation has a separate cache layer. A configured local emulator worker can then install, launch and test the APK before promotion. See [native-worker](../native-worker/README.md) for the actual Windows development lane and its limits. Compose Desktop builds an executable JAR and requires a real visible application window before serving noVNC. Native Windows still requires an isolated worker adapter; macOS/iOS execution is deferred.

Private runtime variables stay outside the build context. Only explicitly public, non-secret variables enter build configuration. For local single-image Docker builds, `build_secrets` selects existing project secret names for the BuildKit secret adapter. For example, `"build_secrets": ["REGISTRY_TOKEN"]` requires that project secret; a supplied Dockerfile consumes it through `RUN --mount=type=secret,id=REGISTRY_TOKEN,required=true ...`. Secret inputs live outside the source context/archive, have restrictive permissions, are removed after the build, and raw secret output is redacted. Missing selected secrets block the build. Compose/remote builds explicitly reject this option until their adapters exist. Do not place private credentials in ARG/ENV or source files. This adapter does not prevent deliberately malicious build code from leaking transformed credentials.

Background incidents are stored in PostgreSQL, leased, retried at most three times and canceled when superseded. Repair requires the owner's AI setting and current project administration access. Provider credentials remain in internal service requests and are unavailable to agent tools. Monitoring claims durable target leases and records release-bound healthy/failed/unknown evidence. It includes periodic render checks, fresh process inspection and foreground observation for the active Android release. Recurring workflow replay requires a separate `monitor_scenarios` list; deployment `scenarios` are not automatically repeated. Unknown verifier/worker capacity does not justify automatic source repair.

## Independent browser acceptance

When required CI is enabled, GitHub evidence must match the immutable commit and
all selected results must succeed. `STACKPILOT_REQUIRED_CI_POLICY` configures a
global JSON policy with `checks` (objects containing `name` and the actual trusted
GitHub `app_id`) and `statuses` (required legacy context names). Both Compose
topologies pass it to the backend. Missing/ambiguous trusted checks, skipped or
neutral results, malformed policy and unverifiable evidence fail closed.
Retrieval follows pagination up to 1,000 checks/status records per endpoint;
exceeding the bound blocks rather than treating a partial list as complete.
Per-project policy editing and live external GitHub qualification remain open.

`browser_checks` declares readiness assertions. `scenarios` declares bounded release workflows with explicit final assertions. `monitor_scenarios` separately opts in recurring workflows; use dedicated accounts and safe test data when those actions mutate application state. Release and monitoring workflows share a maximum of 100 actions and each list is limited to 20 scenarios.

```json
{
  "workload": "web",
  "port": 3000,
  "browser_checks": [{"kind": "visible", "selector": "#ready", "expected": true}],
  "scenarios": [{
    "name": "Submit a form",
    "steps": [
      {"action": "fill", "selector": "#name", "value": "Alice"},
      {"action": "click", "selector": "#submit"},
      {"action": "assert", "expectations": [{"kind": "text", "selector": "#result", "expected": "Hello Alice"}]}
    ]
  }]
}
```

Scenarios use the declared selectors and observed outcomes. They are not site-specific code. Missing/ambiguous targets or wrong outcomes block release. The agent's generic site audit is separately bounded exploration and does not establish that undeclared product workflows passed.

## Local release and recovery

Local single-image releases use separate candidates, immutable image identities and recorded application proofs. With the local runtime gateway configured, the environment has a stable `.preview.localhost:8091` origin. Candidate qualification precedes route publication; routed verification precedes successful job completion. HTTP routing failure restores the prior route. Local rollback can recreate and verify retained checkpoints, rather than requiring an old container to remain running. Manual deploy requests enqueue the same release pipeline. Previous attempts and recreated rollback runtimes are recorded for reconciliation and project deletion.

The gateway is a local loopback development route, not a phone-reachable public preview. Multi-provider/stateful release safety, disposable worker isolation, shared artifact storage, bounded retention, production signing, migration/backup gates and full monorepo orchestration remain open. See [deployment workflows](../docs/deployment-workflows.md) for current behavior and [the completion plan](../docs/stackpilot-completion-plan.md) for remaining support work.
