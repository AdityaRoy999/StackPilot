# Repository compatibility implementation — 2026-09-30

StackPilot now has separate delivery paths for interactive programs, finite commands and built packages. This extends the existing Linux web/API, worker, TCP, artifact, desktop and Android paths. No population-wide compatibility percentage has been measured, and this milestone does not establish “almost 100% of repositories.”

The subsequent [repository completion workflow](repository-completion-2026-10-01.md)
adds frozen per-feature acceptance and exact-revision release gates for unfinished
projects. It does not remove the execution and qualification boundaries below.

## Implemented changes

- A bounded, read-only repository analyzer reports manifests, components, Python imports, declared entrypoints, Node package binaries, candidate ambiguity and existing test commands. It never imports or executes repository code. Both the build planner and scoped AI tools use it.
- Unambiguous Python interactive programs and Node package binaries get a console delivery plan. A source Dockerfile remains authoritative. Multiple candidates require an explicit contract; utilities inside other components do not become arbitrary first-match entrypoints.
- The browser console executes the original fixed argv command in the deployment container. Browser input cannot choose a shell command. Each session has its own process, a random capability identifier, a 90-second idle deadline, bounded output and input, and an explicit close operation. Four concurrent sessions are admitted per deployment.
- Console verification starts fresh processes, submits declared inputs and asserts actual outputs/exit codes. PTY echo is disabled so submitted text cannot satisfy an output assertion. Startup failures include captured program output in recovery evidence. These workflows are not replayed by periodic monitoring.
- Finite jobs run once with no interactive stdin. Readiness requires exit code zero within the configured deadline. Failure and timeout do not become healthy running workers. Captured output is visible through the result endpoint and bounded container logs.
- Package delivery uses a portable build recipe with explicit outputs. Build commands and repository tests run before export. Actual outputs are bundled and served with a hashed artifact manifest; the runtime verifier downloads and hashes the resulting bytes.
- Single-component version 2 CLI/package contracts retain their normalized entrypoint, runtime command, tests and build recipe. Mixed finite/native multi-component execution remains explicitly unsupported.
- Python, Node and portable recipes have console/job templates. Existing CMake, Java and .NET launchers support declared console commands. Go/Rust final images now retain the selected executable command, deployment plan and common launcher instead of bypassing workload delivery.
- Repair runs require independently executed source tests before rebuilding. Existing npm/pnpm/Yarn/Bun, Python, Go, Cargo and Maven/Gradle test commands are discovered when no explicit test list exists. Original test files, package test scripts and console acceptance scenarios cannot be weakened within an agent run. Interactive repairs also require declared input/output scenarios.
- Repository analysis is supplied to the lead and exposed as `analyze_repository` for scoped team members. Recovery instructions distinguish an incorrect delivery contract from broken application behavior and forbid placeholder substitutions.

## Evidence

| Check | Observed result |
| --- | --- |
| Original advanced calculator saved source | Actual image build passed five arithmetic method assertions; authenticated platform verifier passed addition and multiplication through live console input/output. The original calculator implementation was not rewritten. |
| Node CLI without a website/start script | Real image build, original program tests and platform console scenarios passed, including invalid input handling. |
| Finite Python job | Real image build and job behavior test passed; platform verifier observed completed exit code and expected output. Separate regressions reject failed and timed-out jobs. |
| Python library/package | Real wheel built, installed and tested; platform verifier downloaded and hash-checked the exported artifact. |
| C++ regressions | 203 passed. |
| Full AI regression suite | 228 collected, 46 environment-dependent/live tests skipped; all 182 executed tests passed. Later acceptance changes were checked separately with the agent-team suite. |
| Deployment regressions | Linux: all 86 passed with Node tooling. Windows: 86 collected, eight platform-specific skips. |
| Agent acceptance and scoped tool regressions | 36 passed, including discovered package tests, prevention of test-script weakening and the mandatory repair acceptance gate. |
| Runtime activation | Backend/AI images rebuilt; backend, AI readiness and frontend health endpoints return HTTP 200. |

Machine-readable results: [calculator](calculator-console-qualification-2026-09-30.json), [package](package-delivery-qualification-2026-09-30.json), and [Node/job/package integration](repository-delivery-qualification-2026-09-30.json).

The calculator was tested in a disposable deployment copied from its retained source snapshot. Its existing failed deployment and deleted chat were not recreated or silently marked healed. No live provider/model healing run was used to establish this milestone.

The reusable integration check is `python tests/integration/repository_delivery_smoke.py`. It uses disposable containers and calls the same authenticated runtime verification endpoint as release promotion. It creates no project records. CI now runs it after the existing release/rollback qualification. It qualifies delivery adapters, not the entire project creation, provider repair and promotion workflow for every repository.

## Configuration examples

An interactive program can declare:

```json
{
  "workload": "cli",
  "entrypoint": ["python", "-u", "calculator.py"],
  "tests_required": true,
  "tests": [["python", "test_calculator.py"]],
  "console_scenarios": [{
    "name": "Calculation",
    "steps": [
      {"output_contains": "Number:"},
      {"input": "12\n", "output_contains": "Result: 144"}
    ]
  }]
}
```

A finite command declares `"workload":"job"` and an entrypoint argv. A package declares `"workload":"package"` and a `build_recipe` with a Linux builder image, argv build commands and specific output paths. [The real wheel fixture](../tests/fixtures/portable-python-package/stackpilot.json) illustrates package build, installation and testing. Other Linux toolchains can use the same recipe mechanism, including Ruby/PHP or custom build systems; a recipe is an extension path, not proof that every such framework was tested.

## Remaining boundaries

| Requirement | Current boundary |
| --- | --- |
| Long-running batch jobs | This executor supports 1–45 second jobs. A durable asynchronous job/artifact executor is still needed for longer tasks. |
| CLI terminal fidelity | Text input/output with PTYs; full ANSI terminal emulation, resize and complex full-screen TUIs are not qualified. Sessions share the deployment's application filesystem. |
| Native platforms | Windows workers need further implementation/qualification. macOS/iOS execution remains deferred. Android and Linux desktop qualification is specific to the existing tested adapters. |
| Stateful applications | Complete migration, backup, restoration and data-safe rollback qualification is unfinished. Source/runtime rollback alone is not a database recovery guarantee. |
| Complex repositories | Explicit roots, commands and component contracts resolve ambiguity. Secondary-service assertions and mixed native/finite component execution still need a multi-adapter verifier. |
| Toolchain differences | Generated templates use the platform defaults. Repositories requiring other compiler/SDK versions, system packages or special build behavior need an explicit Dockerfile or portable recipe selected from their source requirements. |
| Private inputs/hardware | Credentials, signing identities, licensed dependencies, GPU/device drivers and unavailable operating systems require real prerequisites. They cannot be supplied by relabeling a deployment healthy. |
| Production isolation | Existing shared Docker infrastructure is not a qualified hostile multi-tenant repository execution boundary. |

Meaningful business acceptance must be supplied or derived from real repository behavior and then executed. A startup check, successful download, package test command or LLM summary does not prove every feature of an arbitrary repository works.
