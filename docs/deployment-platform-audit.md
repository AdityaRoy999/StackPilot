# Deployment platform audit — 2026-09-27

## Verdict and scope

StackPilot does not currently implement a universal, end-to-end agentic build, test, release, repair and monitoring platform. It has a real queued deployment foundation for selected Linux/container applications, some genuine runtime verification, and bounded AI repair. Native/mobile support, testing depth, continuous application monitoring, lifecycle safety and isolation remain incomplete.

This audit inspected the current dirty working tree, including the preceding reliability fixes. It traced source intake, classification/generation, queued builds, Docker/Compose/Kubernetes/SSH execution, AI tools, repair, promotion, rollback, cleanup, CI and maintenance. It also ran isolated Android/CMake reproductions and read-only live agent tool calls. It did not certify cloud Kubernetes, native device execution, signing, application business workflows or every repository. No production implementation or running deployment was changed in this pass. An unused `startBackgroundBuild` implementation in ProjectController was found but is not counted as a reachable pipeline defect: the source has no calls to it.

An honest universal intake contract is: inspect any repository; identify deployable components and required capabilities; execute supported plans; request missing credentials/decisions; report unsupported or failed outcomes precisely. It cannot guarantee successful deployment of broken source, unavailable dependencies, missing private credentials, arbitrary hardware requirements or every operating system. Build, server deployment, native installation, artifact distribution and store publication are different outcomes.

## What already exists

- GitHub, SSH/local source, artifact and application-template build paths; commit/branch handling and Git submodule initialization.
- PostgreSQL job claiming with `SKIP LOCKED`, active-build admission checks and deployment logs/events.
- Existing Dockerfile preservation and deterministic generators, plus AI generation fallback for unresolved project types.
- Docker, Compose, local/remote Kubernetes execution and environment configuration.
- A browser render smoke gate on queued HTTP runtime promotion; exact-job evidence on the primary repair/wait path. This is explicitly not business-workflow verification.
- Kubernetes startup/readiness/liveness probes and rollout checks; environment supersession handling.
- A working local SPA deployment previously qualified, and authenticated tools with project ownership checks.

These are useful foundations. Their presence does not imply every path implements the same lifecycle or verification contract.

## Concrete remaining issues

P0 means an isolation, credential exposure or active-runtime ownership problem that blocks hosting arbitrary customer repositories safely. P1 means a correctness/reliability gap against the requested product contract. P2 means an important reproducibility, performance or qualification gap. Source line numbers refer to this audit snapshot.

| ID | Severity | Confirmed issue and concrete consequence | Source evidence |
| --- | --- | --- | --- |
| D01 | P0 | Project variables are written into `.env`, `.env.local` and `.env.production.local`; `.dockerignore` explicitly re-includes them. Broad `COPY .` can bake private runtime secrets into build layers/images. Existing source env files are truncated rather than merged. Static/source-serving runtimes can publish these files. The Android dummy-canary reproduction returned HTTP 200 for `/.env`. | `BuildService.cpp:646–704`, `2824–2828`, `2885` |
| D02 | P0 | Local Compose is executed from the submitted file against the host Docker daemon without an equivalent policy validation layer. Privileged containers, host bind mounts, Docker socket access and host networking are not rejected in this path. Kubernetes conversion withholding privileged mode does not protect local Compose execution. | `BuildService.cpp:1693–1730`; compare `ComposeKubernetesPlanner.cpp:515–555` |
| D03 | P0 | Compose conflict recovery runs `docker rm -f` on container IDs/names parsed from error output without checking deployment ownership. A conflicting runtime from another project can be removed. | `BuildService.cpp:398–404` |
| D04 | P0 | Generic rollback copies the previous runtime/container/image identity onto the current deployment row while leaving the previous row as an owner. Cleanup subsequently removes the container/image by the selected row's fields, without a shared-runtime ownership check. Deleting/retiring the old record can therefore remove the runtime now used by the current record. This is source-confirmed; no destructive live rollback/cleanup was performed. | `DeploymentInsights.cpp:592–627`; `DeploymentCleanupService.cpp:276–329`, `488`, `522–536` |
| D05 | P1 | Native Android generation does not build Android at all. The image uses Python, copies source and starts an HTTP portal; there is no JDK/SDK installation, Gradle build, APK validation, installation or emulator test. Nevertheless the portal always says “Android Application Ready.” Reproduced with no APK: portal 200, download 404. | `BuildService.cpp:2820–2831`; probe JSON |
| D06 | P1 | The Android portal turns a nested APK path into a basename URL without copying it to the web root. Even an APK under the usual `app/build/outputs/apk/debug/` layout cannot be downloaded through that link. Reproduced with a dummy nested artifact: 404. The QR additionally assumes its advertised hostname is reachable from a phone. | `BuildService.cpp:2828`; probe JSON |
| D07 | P1 | Compose Desktop can suppress all Gradle failures with `|| true`; a missing wrapper also skips the build successfully. Its supervisor can run `sleep infinity` instead of the app, and the app does not automatically restart. A healthy noVNC viewer is not proof the desktop application exists or works. | `BuildService.cpp:2838–2849` |
| D08 | P1 | Windows detection accepts `.msi`, but the generated launcher only searches `.exe`, otherwise sleeping indefinitely. Wine/noVNC is a compatibility preview, not a general native Windows build, installer, GUI test or release pipeline. | `BuildService.cpp:2433–2445`, `2804–2819` |
| D09 | P1 | React Native and Flutter are diverted into web previews. Native-only plugins and APIs may not work there; no actual Android/iOS release is produced or tested by these generators. Any `app.json` in a Node repository can trigger the Expo classifier, and bare React Native is treated as Expo. | `BuildService.cpp:2649–2660`, `2702–2719`, `2850–2884` |
| D10 | P1 | iOS is explicitly unsupported for native deployment. There is no routed macOS/Xcode worker, simulator qualification or signed release workflow in the inspected deployment implementation. | `BuildService.cpp:2727–2736` |
| D11 | P1 | Runtime ports and health routes are guessed/hardcoded. Queued Docker and Kubernetes paths pass port 3000 and root `/`, so an existing valid image listening on 8080/5000/etc. can fail despite its `EXPOSE`. Direct APIs allow some configuration, but universal source-only deployment does not infer and carry a consistent runtime contract. | `JobQueueService.cpp:1439–1441`, `1477–1479`, `1558`, `1595–1597`; `LocalDockerRuntime.cpp:104–112` |
| D12 | P1 | The verification gate assumes a browser-renderable HTTP root. A healthy API returning JSON, an authenticated/404 root with a valid health endpoint, a worker or gRPC/TCP service needs a different verification contract. A portal/default page can look fine while the intended application is missing. No runtime URL skips browser verification altogether, although built-only records are separately represented. | `JobQueueService.cpp:1631–1644`; `ai-service/app/runtime_verification.py` |
| D13 | P1 | Deployment does not automatically execute the repository's test suite or generate and verify its complete business workflows. Java templates explicitly skip Maven/Gradle tests. The browser gate covers initial rendering, not login, persistence, email, payment, jobs or all routes. | `BuildService.cpp:2838`, `3058`; `JobQueueService.cpp:1645`; existing deployment smoke tests |
| D14 | P1 | Required CI can be bypassed for manual/non-GitHub-push builds. A GitHub commit with no check runs eventually continues; lookup covers only the first 100 check runs and does not establish a required-check-name policy or legacy status-check coverage. Therefore “require CI” is not a strict universal testing gate. | `JobQueueService.cpp:511`, `546–573`, `994–1003`, `1075–1086` |
| D15 | P1 | The AI metrics tool returns fixed CPU 1.2% and memory 84.5 MB, not measured usage. Live read-only calls reproduced these values. An agent can make performance or health decisions from fabricated telemetry. | `AiController.cpp:2682–2696` |
| D16 | P1 | The AI Kubernetes events tool returns the constant “Pod scheduled. Container initialized. Exit code recorded in logs.” It returned this for a local Docker deployment during this audit. | `AiController.cpp:2744–2755` |
| D17 | P1 | The AI scale tool only updates `desired_replicas` in PostgreSQL; it does not call the runtime scaling implementation or verify replica readiness. Its response labels the action “scaled.” Separate controller scale endpoints do not make this tool action real. | `AiController.cpp:2698–2721` |
| D18 | P1 | No durable continuous application-monitor-to-repair loop was found. Maintenance samples cost, expires previews and prunes records; startup reconciliation is one-off. Prometheus scrapes the platform/cAdvisor but defines no application synthetic checks or incident repair integration. Kubernetes probes and Docker restart policies provide limited process recovery; they do not continuously test application workflows and repair source. | `JobQueueMaintenance.cpp:244–282`; `main.cpp:120`, `477`; `observability/prometheus/prometheus.yml` |
| D19 | P1 | Health/status can be stale or too shallow. AI status reads stored deployment/job state; local runtime health treats a running, unpaused container as healthy. A process may be running while returning 500, showing a blank page or losing its database. | `AiController.cpp:2241`; `DeploymentController.cpp:3437–3451` |
| D20 | P1 | Automatic healing starts after build failure as a detached backend thread, not a recoverable incident/workflow job. It can be lost on backend restart and has no durable incident lease/deduplication mechanism. Failed AI-repair jobs do not trigger another automatic healing cycle through this branch. A bounded model turn may try multiple actions, but this is not durable ongoing convergence. | `JobQueueService.cpp:1974–2018`, `2279` |
| D21 | P1 | `repair_deployment` ignores `problem_description` and merely queues an `ai_repair` rebuild. Calling this tool alone does not inspect or fix code. The stronger `/diagnose`/workspace-edit flow is a separate path; tool naming should not imply equivalent functionality. | `AiController.cpp:2758–2785` |
| D22 | P1 | AI repair of a remote deployment rebuilds an existing local `uploads/builds/<id>/source` first, then skips the normal remote dispatch because `isAiRepair` is true. The local runtime branch also excludes remote-host execution. A local repaired image can remain built-only instead of redeploying to the intended remote host. If no local workspace exists, fallback cloning loses local-only edits. | `JobQueueService.cpp:1355–1369`, `1553`, `1581` |
| D23 | P1 | Repair source is a mutable worker-local directory, not a durable versioned artifact/patch attached to a commit. The repair path hardcodes `uploads/builds` while build workspace location can be configured. Another worker, custom workspace root or subsequent source clone can lose the repair. | `JobQueueService.cpp:1356`; `BuildService.cpp` workspace initialization/source checkout |
| D24 | P1 | Queue leases are assigned once without heartbeat renewal; interrupted-job recovery runs on startup with a 15-minute age threshold. Starting another worker can reclaim a still-running long build; a crash does not guarantee timely recovery while other workers stay alive. Completion also lacks lease-owner fencing. | `JobQueueService.cpp:633`, `717–727`, `799`, `833`, `870–879` |
| D25 | P1 | Cancellation is not fenced at final success. The cancel endpoint marks jobs/deployments canceled, but `completeJob` updates by ID without checking state/owner, and success promotion updates similarly omit a canceled-state predicate. Cancellation during runtime start/verification can be overwritten by a late successful worker. Build-process cancellation is present but is not a transaction fence across the whole workflow. | `DeploymentController.cpp:1646–1669`; `JobQueueService.cpp:870–879`, `1654–1797` |
| D26 | P1 | Same-deployment Docker rebuild removes the existing container before starting/verifying its replacement. An unsuccessful repair can take down the currently serving app. Environment promotion updates a database pointer; this Docker path does not atomically switch stable user traffic after candidate qualification. | `LocalDockerRuntime.cpp:114–117`; duplicated queue command `JobQueueService.cpp:417–419`, promotion `1854–1860` |
| D27 | P1 | Enabling cleanup of the previous successful deployment removes its runtime and image. Generic rollback requires a previous running, available checkpoint, so cleanup can make rollback impossible. Kubernetes rollback waits on rollout but does not apply the same browser/business gate before marking the result running. | `JobQueueService.cpp:1914–1945`; `DeploymentInsights.cpp:570–584`; `DeploymentController.cpp:4110–4143` |
| D28 | P1 | Monorepo detection lists conventional subdirectories, but does not create a complete component/dependency/build/test/routing plan. Generic AI generation asks for a primary backend or combined container. An arbitrary frontend + API + worker + database repository is not automatically equivalent to a validated multi-service release. | `BuildService.cpp:2395–2427`, `2328` generation payload; Compose branches |
| D29 | P1 | Compose-to-Kubernetes conversion changes semantics: `depends_on` is advisory, `network_mode` is ignored, Compose healthchecks become TCP readiness, and bind mounts are skipped. Named-volume/PVC support exists, but accepting the plan with warnings does not establish that all services/data/configuration are equivalent. | `ComposeKubernetesPlanner.cpp:515–555` |
| D30 | P1 | Entrypoints/artifacts are selected by “first match.” The CMake template reproduced launching a unit-test binary instead of the application. Java may select a non-executable/library JAR; .NET selects a guessed project/DLL and classifies any `.sln`/`.csproj` as web; Rust selects the first release executable. Entry selection must follow actual targets/configuration, not filesystem order. | `BuildService.cpp:2448`, `2900–2930`, `3037–3064`; CMake probe JSON |
| D31 | P1 | Dependency/toolchain templates do not honor every project's declared manager/version/entrypoint. Node server templates use npm and can bypass lock failure, unlike the corrected SPA branch. Python startup is guessed from files/framework dependencies. Go builds only root `.` with CGO disabled. Custom SDKs, native libraries, nested roots and multi-target builds need capability-aware plans. | `BuildService.cpp:2979–3029` |
| D32 | P2 | AI generation reports a Dockerfile as “verified” before its subsequent build/runtime checks. Generation validation checks text structure, not execution. This wording can mislead users before evidence exists. | `BuildService.cpp:2334–2370`, `3071` |
| D33 | P2 | Qualification coverage is much narrower than the advertised capability. Generator tests currently cover SPA precedence, plain HTML and Dockerfile preservation; the real rebuild smoke covers one valid local Docker workspace. No native/mobile release, store/signing, remote repair, lease takeover, canceled promotion or rollback-owner lifecycle qualification suite was found. | `tests/unit/cpp/build_service_generator_test.cpp`; `tests/integration/deployment_repair_smoke.py` |
| D34 | P2 | Release planning does not provide an enforced digest-based artifact/provenance contract, package signing/verification, multi-architecture worker routing, a pre-promotion security scan, or an explicit database migration/backup/compatibility gate in the inspected workflow. Some artifact metadata/storage exist, but these release gates are not executed universally. Treat stateful and native releases as unqualified until their lifecycle is implemented and tested. | `BuildService.cpp` image build/generators; `JobQueueService.cpp` promotion lifecycle; `KubernetesService.cpp` deployment lifecycle |
| D35 | P0 | The ordinary local Docker run command has no CPU/memory/PID quotas or explicit capability restriction. Loopback port binding is useful but does not prevent an application from consuming the shared worker's resources. Kubernetes resource presets do not enforce quotas on this separate Docker execution path. | `LocalDockerRuntime.cpp:116–117`; `JobQueueService.cpp:418–419` |
| D36 | P1 | Local Compose selects a runtime endpoint by scanning services and a fixed port list. A database/admin console can be chosen before the intended application, an unusual application port may be missed, and the one selected URL does not verify every service. The portal's apparent health can mask a broken dependent application. | `BuildService.cpp:1731–1751`; queued single-URL verification `JobQueueService.cpp:1631–1644` |

## Actual capability assessment

| Input | Current implementation | Product promise justified today |
| --- | --- | --- |
| Conventional static HTML / supported SPA | Generated static/compiled image, runtime and browser render smoke | Selected local web deployments; business workflows remain unverified |
| Backend HTTP service | Several language templates and existing-Dockerfile support | Partial support; port, health, auth, entrypoint and toolchain assumptions remain |
| Multi-service Compose repository | Local/remote execution and partial Kubernetes translation | Partial; isolation, correct primary endpoint, all-service readiness and semantic equivalence need work |
| Worker, CLI, scheduled job, pure library | Mostly modeled as web/container application or rejected | No general purpose-built build/test/job/package lane |
| Native Android source | Python download portal | Native build, installation, testing and release not implemented by this generator |
| React Native / Flutter | Web preview diversion | Web preview only; not native qualification or release |
| Compose Desktop | Best-effort Gradle plus noVNC | Preview scaffolding; app launch and installer success not guaranteed |
| Windows EXE/MSI | Best-effort Wine/noVNC | Compatibility preview; not arbitrary Windows deployment |
| iOS / macOS native source | iOS explicitly rejected | No native macOS/Xcode worker lane found |
| Electron/Tauri/other desktop stacks | No dedicated native release lane found | Must not advertise signed native installers/updates as implemented |

## Reproduced evidence

Run from the repository:

```text
python tests/integration/deployment_audit_probe.py --cmake-image stackpilot-unit-tests:ci --output docs/deployment-audit-probes.json
```

The optional image must already exist locally and contain CMake/a compiler; the probe forbids pulling it. Temporary fixtures contain only dummy data. Docker probe containers use `--rm`; generated portal server and temporary directory are closed/removed.

Observed:

- Android generator: no Gradle build, no SDK installation.
- Missing APK: root HTTP 200, “Application Ready”, download HTTP 404.
- Nested dummy APK: advertised basename download still HTTP 404.
- Dummy source `.env`: HTTP 200, canary visible.
- Multi-target CMake: selected `build/a_unit_test` instead of `build/z_application`.
- A simpler single-target CMake control selected the real application. The failure is ambiguity with multiple targets, not every CMake project.
- Live authenticated agent metrics tool: CPU 1.2%, memory 84.5 MB, matching literal source constants.
- Live authenticated Kubernetes-events tool: returned its canned Pod message for deployment `e930fdf1-355e-421c-b2a2-be22ec3c08f7`, which runs on local Docker.

The probes do not constitute a full generated-image build or a destructive recovery test. The `.env` reproduction executes the exact embedded Python handler in an isolated source root. Rollback, cancellation and remote-repair findings are source-traced, not live failure-injected against user workloads.

## Architecture and implementation order

1. **Make isolation and evidence truthful first.** Remove fake tools, split runtime secrets from public build config, use secret mounts, validate/restrict repository execution, enforce quotas and unique runtime ownership. Do not make the AI the security boundary.
2. **Create one durable deployment workflow.** Every entry route and repair uses the same typed stages: intake → component/capability plan → isolated build → repository tests → artifact validation → candidate runtime → type-specific verification → promotion → continuous monitoring. Persist attempts and outputs; renew/fence leases; preserve cancellation; classify infrastructure failures separately from source defects.
3. **Separate workload lanes.** HTTP web, API, TCP/gRPC, worker/job, package, Android, Windows and macOS each need real artifacts, native runtimes, test adapters and clear release criteria. Discover declared toolchains and targets; route to an appropriate OS/architecture worker. Retain unsupported outcomes when capability or credentials are missing.
4. **Make repairs durable and target-preserving.** Store patches/versioned source with the incident, build the same target, attach exact artifact/job/session identity and run the same gates. Use bounded attempts and rollback when safe; no uncontrolled detached repair threads.
5. **Implement promotion/rollback and stateful operations.** Keep immutable known-good artifacts, verify candidates before switching stable traffic, use shared ownership checks, and plan migrations/backups independently of application container rollout.
6. **Continuously observe real applications.** Collect real metrics/events, synthetic API/browser checks and dependency health; open durable incidents; restart/rollback/repair according to policy. Distinguish infrastructure healthy, application ready, workflows verified and release distributed.
7. **Earn support with a repository corpus.** For every declared lane test successful builds, wrong ports, missing files, package managers, native dependencies, failed tests, absent artifacts, multiple entrypoints, slow builds, worker crash/restart, canceled promotion, broken dependencies, rollback cleanup and runtime failures after promotion. Publish measured support and reliability rather than “100%.”

## Primary documentation used

- [Android command-line builds](https://developer.android.com/build/building-cmdline): actual Gradle tasks, APK output, emulator/device installation and signing requirements. A release needs the appropriate signing key; a debug APK is not a Play Store release.
- [Xcode system requirements](https://developer.apple.com/xcode/system-requirements): supported macOS/Xcode combinations, relevant to routing native Apple builds.
- [Docker build secrets](https://docs.docker.com/build/building/secrets/): secret/SSH mounts rather than persisting credentials in build outputs.
- [Docker Engine security](https://docs.docker.com/engine/security/): daemon/host access is a security boundary when accepting untrusted repositories.
- [Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/): process startup/readiness/liveness mechanisms and their operational semantics.
- [Kubernetes workload controllers](https://kubernetes.io/docs/concepts/workloads/controllers/): Deployments, Jobs and CronJobs serve different workload lifecycles.

The preceding fixes and local qualification are documented separately in `docs/ai-service-reliability-audit.md`. They remain valid for their measured scope and do not resolve the issues listed here.
