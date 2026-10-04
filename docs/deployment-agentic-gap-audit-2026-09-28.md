# Current agentic deployment and testing gaps — 2026-09-28

> Historical audit before the subsequent fixes. Current per-finding implementation and qualification status is in [deployment-remediation-status-2026-09-29.md](deployment-remediation-status-2026-09-29.md).

## Verdict and scope

StackPilot has a useful local Linux deployment foundation. It does not yet provide a qualified, universal `source -> build -> workflow tests -> safe release -> monitor -> repair -> verified recovery` pipeline. A green deployment proves only its recorded verification scope. It does not establish complete application correctness.

This audit reads the current source, including the previous remediation changes. It distinguishes concrete code defects, missing product capabilities, and implemented paths that have not been qualified. It is not a repetition of the original D01–D36 audit. Some earlier progress statements, particularly the universal required-test gate, need qualification because additional execution branches bypass the common gate.

Evidence collected in this pass:

- Inspected the planner, generated builds, local/remote execution, queued promotion, manual deployment and rollback, incident monitoring/repair, browser tools, production Compose and CI.
- Executed an isolated reproduction in the running AI-service container, using a mocked browser observation and contract verifier. A document containing only `Loading...` returned `verified: true`; the declared contract verifier was called **zero** times. This did not contact an external website or modify a deployment.
- Resolved production Compose service names with a temporary `audit.invalid` domain. There is no `browser-sandbox` service. Without that temporary domain, the current local environment correctly fails production interpolation because `STACKPILOT_DOMAIN` is required; missing local production configuration is not itself an application defect.
- Reviewed existing web, Android artifact and Linux desktop qualification files. Those live qualifications were **not rerun** for this audit. No new remote, Kubernetes, emulator, Windows or macOS qualification is claimed.

P0 means a release blocker before accepting mutually untrusted tenants. P1 means a correctness/reliability or required capability gap. P2 means breadth, scale or qualification work. An absent feature is not necessarily a defect in a supported local lane.

## What already exists

- Typed workload contracts distinguish web rendering, HTTP assertions, TCP connection, process observation and artifact delivery.
- The queued local single-image path records an immutable image content ID, inspects repository-test evidence, uses an attempt-specific candidate and verifies before promotion.
- Build jobs and repair incidents have persisted lifecycle state, ownership leases, bounded retries and important completion fences. Duplicate builds and active source edits are guarded.
- Local runtime admission enforces CPU, memory, PID and privilege restrictions. Resolved local Compose is policy checked and its service readiness/primary endpoint is inspected.
- Android has a real Gradle/SDK build template and hash-verified APK delivery. Linux desktop has a real X11/noVNC lane rather than a static placeholder.
- Browser actions, assertions, step snapshots and a bounded navigation/hover audit exist. They explicitly distinguish untested outcomes.

These improvements are valuable. They do not remove the gaps below.

## Concrete remaining findings

### G01 — Required tests are not enforced in every build branch [P1, defect]

**Evidence:** `src/services/BuildService.cpp:1701` enters the Compose branch and returns success at `:1779`, before the evidence gate at `:1843`. `buildAndRunOnRemoteDocker` returns success at `:1387` without the same image-evidence inspection or `tests_required` enforcement. Queued promotion does not add an equivalent universal test-evidence gate.

**Impact:** A configuration requiring passed tests can still reach runtime verification/promotion through these branches without that evidence. A Compose build failure propagates, but that is different from enforcing the declared test requirement.

**Fix:** Require a common, per-component test-result contract before any provider can promote. Include Compose and remote adapters, and reject missing, stale or wrong-attempt results. Qualify this with deliberately failed/missing tests in each branch.

### G02 — Some generated templates execute tests but discard their evidence [P1, defect]

**Evidence:** Java runs Maven verification/Gradle build (`BuildService.cpp:3018`), CMake runs CTest (`:2993`), and Flutter runs analysis/tests (`:2839`), but they do not consistently export the evidence files inspected by `deployment-runtime/image_evidence.py`. Expo's final nginx stage copies the web export without consistently retaining the repository-test result.

**Impact:** Required tests can be reported unrecorded even after commands ran successfully. Separately, `tests_required` defaults to false (`deployment-runtime/planner.py:79`), so the absence of required test evidence is not a universal failure policy.

**Fix:** Standardize build/test results across templates: commands, exit codes, discovered/missing suites, scope, source digest, attempt and image/artifact digest. Preserve those results in every final image and in independent platform storage.

### G03 — Web verification skips declared health/assertion checks [P1, reproduced defect]

**Evidence:** `ai-service/app/runtime_verification.py:42` routes non-render scopes to `verify_contract`; the `render_smoke` branch does not execute `health_path`, `accepted_statuses` or `checks`.

**Impact:** A web app can pass while a declared `/ready` or application assertion fails. The isolated reproduction returned `reported_verified: true`, `declared_checks_called: 0`.

**Fix:** Compose the relevant checks: repository tests, declared endpoint assertions, browser readiness and declared workflows. A scope should describe the checks performed, not select one gate that silently replaces others.

### G04 — Rendering content is too weak to establish application readiness [P1, scope gap]

**Evidence:** `runtime_verification.py:28` accepts a complete document with text or certain visible elements. Console errors are returned at `:62` but do not affect the verdict. The reproduced `Loading...` document passed.

**Impact:** A perpetual loader, visible error message or partially broken application can be green. Current checks do catch an entirely empty page, uncompiled TS/JSX and observed failed same-origin assets; that protection should be retained.

**Fix:** Add a declared readiness signal, route-specific assertions and representative user workflows. Classify console/network errors and allow justified application-specific exceptions. Avoid replacing this with a universal blacklist of loading/error text.

### G05 — Manual deployment does not preserve the queued contract and evidence [P1, defect]

**Evidence:** `src/controllers/DeploymentController.cpp:49` sends only a URL to `/runtime/verify`. Local Docker calls it at `:2134` and writes a new default HTTP snapshot at `:2143`. Manual Kubernetes deployment also uses this helper at `:2347` and reconstructs the snapshot. These paths do not consistently carry the queued deployment plan, immutable content ID, test result and attempt identity.

**Impact:** An API/process/TCP workload can be rejected or evaluated with the wrong scope. A manual mutation can discard information later needed for correct monitoring and repair. Browser verification is present for manual Kubernetes deployment; the defect is the missing typed contract/evidence, not a total absence of verification there.

**Fix:** Route manual deployment/provider changes through the same durable job and release contract as queued builds. Preserve immutable release evidence and verify the correct workload.

### G06 — Rollback has inconsistent verification and cannot recreate every checkpoint [P1, defect/capability gap]

**Evidence:** `src/controllers/DeploymentInsights.cpp:530` only reuses an already running, artifact-available previous deployment and verifies its URL without its contract. Kubernetes rollback (`DeploymentController.cpp:4013`, success persistence at `:4161`) does not run the application verifier after rollout undo.

**Impact:** Valid non-browser workloads can fail generic rollback. A stopped old release cannot be restored through that generic route. Successful Kubernetes rollout undo does not prove application recovery.

**Fix:** Restore by immutable release identity, start it if necessary, apply the same workload/workflow verifier, then switch traffic and report recovery. Keep infrastructure rollout and application verification separate.

### G07 — Lost job ownership can leave a candidate and overwrite evidence [P1, defect]

**Evidence:** `src/services/JobQueueService.cpp:1619` writes verification metadata before the owner/attempt promotion fence at `:1623`. If that fence fails, `:1624` commits and returns. Failed-candidate cleanup at `:1612` is restricted to failed local Docker results.

**Impact:** A late worker can write evidence after losing ownership. A successfully started candidate can remain running after cancellation, supersession or lease takeover even though it cannot publish success.

**Fix:** Fence evidence writes too. Persist candidate ownership/resources before side effects, clean them when the lease is lost, and reconcile orphan candidates after crashes. Test cancellation during build, start, verification and promotion.

### G08 — Local release promotion does not atomically switch stable traffic [P1, capability gap]

**Evidence:** `src/services/LocalDockerRuntime.cpp:125` publishes a random loopback port. `JobQueueService.cpp:1827` changes `current_deployment_id`; this is not an atomic reverse-proxy traffic switch. The recorded web qualification explicitly marks stable routing unimplemented.

**Impact:** A newly successful deployment can have a different URL; users can remain on an old runtime. A database pointer update alone does not provide zero-downtime release semantics.

**Fix:** Give each environment a stable routed origin, qualify a private candidate, atomically switch the route, verify through that route, and drain the old runtime. Kubernetes ingress helpers already exist; this finding concerns a unified release contract across lanes.

### G09 — Compose replacement does not have equivalent candidate safety [P1, defect/capability gap]

**Evidence:** The local Compose project is derived from the deployment identity and `compose up` applies to that project (`BuildService.cpp:1698–1779`). The queue's failed-candidate cleanup only handles `local_docker`.

**Impact:** Rebuilding the same Compose deployment can mutate the serving stack before validation. Failure can leave a partially changed stack without restoring the previous healthy services.

**Fix:** Use attempt-specific Compose candidates, preserve state deliberately, verify every component and switch the primary route only after acceptance. Add ownership-aware failed-stack cleanup and compensating recovery.

### G10 — Previous-runtime cleanup can destroy rollback history [P1, defect/capability gap]

**Evidence:** `JobQueueService.cpp:1898` requests image deletion during cleanup of a previous successful release; the row can become retired. Generic rollback requires a running, artifact-available previous runtime.

**Impact:** Enabling cleanup can remove the very checkpoint rollback depends on. Keeping every old runtime forever is also not a managed retention policy.

**Fix:** Retain a bounded set of restartable releases, source/config identities and immutable images/artifacts. Separate runtime retirement from artifact retention and garbage collection.

### G11 — Stateful release safety is not a complete pipeline gate [P1, capability gap]

**Evidence:** The release path has no complete per-application migration/backup/restore qualification gate; the current remediation report also identifies this as outstanding.

**Impact:** A healthy HTTP endpoint does not establish schema compatibility, data persistence, backup recoverability or whether an older release can run after a migration.

**Fix:** Declare migration jobs, serialize them with releases, enforce compatibility, qualify backups/restores and test data persistence/recovery. Code rollback must not imply that data was rolled back safely.

### G12 — Production configuration differs materially from the locally working stack [P1, defect]

**Evidence:** `docker-compose.prod.yml:227` defines AI service without its configured DB variables; `ai-service/app/tools.py:736` falls back to fixed database defaults. Production Compose has no browser-sandbox service or supplied browser endpoint, while `browser_driver.py:37` defaults to `browser-sandbox:9222`. `InteractiveBrowserCanvas.tsx:290` falls back to the page host on port 8010; production only exposes that service internally and Caddy sends `/ws/*` to the backend. Production still defines Promtail while the current local stack/docs use Alloy.

**Impact:** Configured production DB credentials can differ from the AI fallback, breaking tools/incident workers. Default browser rendering/testing cannot reach a sandbox. The default frontend stream URL lacks a matching production public route. Local success does not prove the production bundle works.

**Fix:** Share validated configuration contracts between environments, remove credential fallbacks, configure real browser workers, add authenticated public stream routing, align log collection, and exercise the actual production bundle in CI. Fail readiness when required dependencies are unavailable.

### G13 — Several runtime mutations still block request handlers [P1, performance/reliability defect]

**Evidence:** `DeploymentController.cpp` performs Docker/kubectl/SSH operations synchronously in multiple deploy, scale, pause/resume, expose and rollback handlers. Metrics at `:3211` use `BlockingTaskRunner`, and generic rollback uses it, but that protection is not consistent across the controller.

**Impact:** Slow external commands can occupy request/event-loop threads and delay unrelated API/UI work. Offloading metrics alone does not remove deployment-induced latency.

**Fix:** Enqueue runtime mutations as durable operations; keep request handlers short, use bounded executor capacity and stream operation progress. Audit command deadlines and cancellation across every adapter.

### G14 — Repair source and release assets are not portable immutable worker state [P1, capability gap]

**Evidence:** Build and repair use deployment-local `uploads/builds/.../source` workspaces (`BuildService.cpp:756` onwards). Existing edits are guarded during active jobs, but there is no complete content-addressed patch/source/artifact replay contract across workers.

**Impact:** A restart, machine loss or worker reassignment can lose repair context or use a different mutable source snapshot. Local OCI IDs do not provide a shared release registry by themselves.

**Fix:** Persist immutable source/patch bundles, generated plans, logs, artifacts and evidence in durable shared storage. Bind all of them to the source commit and job attempt; replay on a replacement worker without depending on the old directory.

### G15 — Shared Docker does not provide hostile-tenant build isolation [P0 before untrusted multi-user use]

**Evidence:** The backend mounts the shared host Docker socket. Repository commands execute in builds managed by that engine. Runtime resource/security admission exists, but disposable tenant workers and an enforced build network/quota boundary are not implemented.

**Impact:** Runtime limits are useful but insufficient as the isolation architecture for arbitrary mutually untrusted repositories.

**Fix:** Move execution off the control plane onto disposable workers with authenticated assignments, tenant quotas, network policy, scoped credentials and cleanup. Qualify escape/resource exhaustion boundaries appropriate to the chosen worker technology.

### G16 — Preview/control access needs an authenticated tenant boundary [P0 before public previews]

**Evidence:** `ai-service/app/main.py:4702` accepts a browser WebSocket without user/session ownership authentication. HTTP service-token middleware does not secure this WebSocket. Current Linux GUI qualification also identifies authenticated preview routing as pending. Browser contexts isolate cookies/storage, while display/video ownership remains shared within the browser worker.

**Impact:** Reachability and knowledge of a session identifier are not a tenant authorization policy for viewing or controlling a browser. Exposing current preview endpoints publicly would require additional controls.

**Fix:** Issue short-lived, user/session/operation-scoped preview tokens, verify origin and ownership before acceptance, revoke takeover permissions, and allocate isolated workers/displays. Keep internal service credentials out of browser clients.

### G17 — Monitoring does not cover the scopes users expect [P1, capability gap]

**Evidence:** `deployment_incidents.py:188` selects only deployments with URLs. At `:203`, web render monitoring is reduced to HTTP checks. Process, device and business workflows are not continuously verified.

**Impact:** An app that later turns blank but still serves HTTP 200 can remain healthy. URL-less workers, failed queue consumption and broken native interactions lack equivalent monitoring.

**Fix:** Combine cheap frequent liveness checks with scheduled browser/device/workflow probes, worker-heartbeat/job-result probes and application SLOs. Record the scope of each observation explicitly.

### G18 — Unknown and superseded health observations are not fully handled [P1, defect]

**Evidence:** `deployment_incidents.py:205` returns without persisting `unverified`. Observation/incident writes at `:210` do not compare the probed job/runtime URL with the currently active release.

**Impact:** A verifier outage can leave old healthy evidence visible. A slow probe against a replaced runtime can write stale health or enqueue an obsolete incident. Incident claiming cancels some superseded jobs later, but that does not fence the initial observation.

**Fix:** Persist healthy/failed/unknown/stale separately; fence observations to the exact release identity; expose observation age and verifier failure; avoid source repair for infrastructure/verifier faults.

### G19 — Monitoring and repair scheduling have limited scale guarantees [P2, capability gap]

**Evidence:** Monitoring processes a rotating batch of 32, with two concurrent probes, then sleeps at least 15 seconds (60 by default). Repair execution has a bounded incident loop rather than a capability-aware distributed executor.

**Impact:** More applications or slow/time-out probes increase detection and recovery delays. This is not a hard 32-deployment support ceiling, but there is no qualified per-application detection/recovery SLO or fair distributed capacity model.

**Fix:** Durable per-target schedules, horizontal worker assignments, backpressure and fair tenant budgets; measure detection latency and repair queue age under realistic load.

### G20 — Repair cannot reliably classify and resume every blocked prerequisite [P1, capability gap]

**Evidence:** Missing native capability raises a runtime error in `deployment_incidents.py:68`; repairs run with `allow_agent_questions: false` at `:111`. The prompt requests blocked reporting, but there is not a complete structured prerequisite/continuation lifecycle for missing credentials, signing, workers or application requirements.

**Impact:** Non-retriable prerequisites can consume retries instead of waiting for the exact missing input. A successful rebuild is judged by its recorded smoke/contract scope, not a repeated regression scenario proving the original defect is gone.

**Fix:** Typed failure categories, structured blocked requirements, resumable input/capability handoff, scoped patches, and a required regression replay before declaring healing. Qualify real model repair without allowing test suppression or placeholder substitution.

### G21 — Component discovery is not full monorepo orchestration [P1, capability gap]

**Evidence:** `deployment-runtime/planner.py:18` discovers bounded manifest directories; `:80` records them as component paths. It does not create a complete dependency/build/test/data/routing graph. Compose checks service readiness, which is distinct from component workflow correctness.

**Impact:** An arbitrary frontend + API + database + worker repository does not automatically receive correct wiring, migration order, test data, secrets and cross-service scenarios.

**Fix:** An explicit per-component plan with dependencies, capabilities, startup order, health/test contracts, volumes, credentials and routed endpoints. Infer what can be proved from source; resolve ambiguities through metadata rather than guessing.

### G22 — Toolchain and framework support is conditional [P2, capability gap]

**Evidence:** Generated templates select defaults such as Node 22, Python 3.12, Go 1.24, .NET 8 and Java 21 (`BuildService.cpp:2820` onwards). Linux recipes allow custom commands/images, but there is no universal SDK/OS/native-library capability resolver.

**Impact:** Merely recognizing a framework does not ensure its engine version, system libraries, architecture and test discovery are compatible. Unrecognized languages can use a suitable Dockerfile/recipe; that is not equivalent to an automatic qualified lane.

**Fix:** Resolve source-declared toolchains and architectures, validate them against registered workers, preserve lockfiles, support explicit overrides and qualify each promised lane with real repositories.

### G23 — Private build credentials lack a dedicated safe adapter [P1, capability gap]

**Evidence:** Runtime/private variable separation is implemented. `deployment-runtime/README.md:55` explicitly identifies private build credentials as requiring BuildKit secret integration.

**Impact:** Private dependency registries and signing operations cannot universally build using the platform's runtime secret injection. Inserting credentials into generated ARG/ENV/source is not the missing adapter.

**Fix:** Scoped BuildKit secret/SSH mounts, private dependency cache policy, redaction and tests proving secrets do not enter final images, build artifacts or public client bundles.

### G24 — Required CI policy is incomplete [P1, capability gap]

**Evidence:** `JobQueueService.cpp:445` fetches up to 100 check runs; more than 100 is blocked at `:488`, not silently accepted. Passed/skipped/neutral results are accepted at `:499`. Required check names/trusted app identities, full pagination and legacy commit-status coverage are not complete.

**Impact:** Required CI can fail closed for large check sets, yet a small set does not establish that the intended integration/security suites ran. The earlier missing-check/manual-commit bypass was corrected and should not be reported as still open.

**Fix:** A named required-check policy with trusted sources, complete pagination/status retrieval, commit binding and explicit skipped-suite semantics.

### G25 — Release provenance and security gates are incomplete [P1, capability gap]

**Evidence:** Local immutable image IDs and Android artifact hashes/signature validity checks exist. `image_evidence.py:10` accepts repository-supplied evidence as an object. There is no complete independent attestation/SBOM/signature/vulnerability and multiarchitecture release policy across providers.

**Impact:** A repository can report its own passed tests without independent proof of execution or quality. Debug APK signature validity does not establish the expected production signing identity. Remote release evidence is weaker than the inspected local image path.

**Fix:** Platform-observed execution records tied to digest/source/attempt, registry-backed provenance, SBOM/scanning policy, trusted release signing and architecture-aware artifact routing. Keep repository test outcomes distinct from independent acceptance tests.

### G26 — Native execution and finite-job/package lanes are missing [P1, capability gap]

**Evidence:** `planner.py:81` marks Windows/macOS worker requirements, but current builders block rather than dispatching to registered OS workers. Android's interactive preview requires an emulator worker. `planner.py:70` blocks finite jobs and packages pending their executor.

**Impact:** Android artifact delivery is not an Android interactive preview; native Windows/macOS/iOS are not supported end to end; a CLI/library/package is not universally deployable as a long-running web app.

**Fix:** Capability-registered Windows/macOS/Linux-emulator workers, native build/install/launch drivers, authenticated streaming, finite-job execution/results and artifact/package publication adapters. Release/store credentials and native workflow suites are separate requirements.

### G27 — Generic website auditing is not whole-product end-to-end testing [P1, capability gap]

**Evidence:** `site_audit.py:56` defaults to 25 pages/120 actions/120 seconds. `:282` returns `exhaustive: false`. Tools explicitly require separate scenarios for form submissions and business outcomes (`tools.py:94`).

**Impact:** `Test this website` discovers and exercises bounded navigation/sections/hover/approved harmless controls. It does not automatically prove login, roles, payment, data creation, email, persistence, recovery and every reachable application state.

**Fix:** Persist an explicit coverage model and scenario queue, infer likely workflows from source/UI, provision test accounts/data, define expected outcomes and record passed/failed/blocked/untested. Application business rules and external prerequisites cannot be guaranteed from visible pages alone.

### G28 — Browser and test protocols do not cover every workflow class [P2, capability gap]

**Evidence:** Site audit marks embedded frames, downloads and external flows untested (`site_audit.py:201–215`). Current tool schemas do not expose complete frame-scoped, file-upload/download or browser-dialog workflows. HTTP verification is bounded GET/status/text/shallow-JSON; TCP verification proves a connection, not a gRPC or database exchange.

**Impact:** Complex SSO/embedded UI, uploads, downloads, native dialogs, protocol semantics and external integrations require additional adapters. DOM assertions are not full visual regression, accessibility, performance/load or security testing.

**Fix:** Add scoped protocol/browser capabilities with observed-state assertions and fixtures; network/API/database acceptance tests, external-service mocks or authorized test integrations, and dedicated visual/accessibility/performance suites where required.

### G29 — Browser recovery and advertised subagents are limited [P2, capability gap]

**Evidence:** `browser_testing/run_state.py:3` states that browser RAM/cookies are not recovered; its journal is local SQLite. `tools.py:920` returns `unsupported` for `invoke_subagent`. Cookie isolation exists, but shared browser/display resource ownership remains.

**Impact:** An interrupted action is recorded as uncertain rather than a resumable full browser workflow. The subagent tool does not execute independent planner/coder/verifier workers. A single browser process/display is not a qualified concurrent native/browser test fleet.

**Fix:** Durable workflow checkpoints, explicit reconciliation before replay, retained traces/screenshots and reproducible test definitions; real scoped worker tasks if subagents remain a promised capability; independent display/browser allocations and concurrent qualification.

### G30 — The production qualification matrix is incomplete [P1, evidence gap]

**Evidence:** Existing evidence qualifies one queued web render deployment, one Android debug artifact template/delivery and one Linux Tk interaction. `.github/workflows/ci.yml` runs useful unit/contract/live-browser/platform checks, but not the full provider/native/repair/rollback/stateful matrix. Frontend lint is explicitly non-blocking (`npm run lint || true`).

**Impact:** Passing current CI is not proof that arbitrary repositories, real provider outages or all lifecycle operations work. Android's full queued lane and model-driven autonomous repair remain to qualify beyond their component evidence.

**Fix:** Required fixture lanes for web/API/worker/TCP/Compose/monorepo/native/job; real remote/Kubernetes targets; adversarial cancellation/lease/crash/rollback/migration cases; model-provider failures and repair replay; production configuration boot/stream/monitoring checks; performance and isolation qualification.

## Actual support boundaries

| Workload | What exists | What is not supported/proven end to end |
| --- | --- | --- |
| Static site / SPA / Linux web app | Generated/supplied image, local candidate, render smoke; one queued web rebuild qualified | Complete business flows, universal engines/dependencies, stable safe release/rollback across all paths |
| Linux HTTP backend/API | Typed port/health/status/text/JSON checks | Authenticated mutation scenarios, data correctness, all manual/remote lifecycle paths |
| Docker Compose | Admitted local subset, all-service readiness, explicit/unique primary HTTP endpoint | Remote Compose; complete Kubernetes equivalence; per-service required test gate and safe replacement |
| Kubernetes / SSH-host deployment | Provider adapters exist | Real supplied-target qualification, consistent contract/evidence/rollback semantics; remote TCP/process routing |
| Long-running worker | Local fresh running/restart observation | Recurring queue/business-result monitoring, finite jobs and schedules as a qualified release lane |
| TCP / gRPC service | Local TCP reachability contract | gRPC health/RPC/business tests, protocol correctness and remote non-HTTP adapter |
| Native Gradle Android | Real SDK/Gradle debug build, tests/lint where present, APK verification and hashed downloads | Live emulator/device installation and interaction, interactive web preview, full queued qualification, production AAB/signing/Play publication |
| Expo / React Native / Flutter | Selected web exports; Flutter web analysis/tests | General native Android/iOS lane, native modules/device parity or arbitrary Gradle apps through Expo |
| Linux desktop | Debian/Ubuntu-compatible X11 explicit recipe / Compose Desktop; real noVNC fixture clicked | Every GUI framework/workflow, Wayland/hardware parity, installers/update channels and public authenticated previews |
| Windows native desktop | Capability requirement detected | Isolated worker, build/install/launch/test/stream, installer signing/publication |
| iOS / macOS native | Capability requirement detected | macOS/Xcode worker, simulator/device/GUI drivers, signing/notarization/store release |
| CLI / finite batch job / package/library | Artifacts supported for declared artifact recipes; unsupported job/package scope fails explicitly | General finite-job executor, exit/output acceptance, package publication and a meaningful interactive preview for every package |
| Stateful multi-service product | Some Compose/storage and runtime helpers | Complete dependency provisioning, migrations, backup/restore verification and cross-service acceptance |
| Hardware-specific app | Explicit custom recipes can describe some builds | A general physical-device/GPU/USB/camera/sensor/native-permission testing fleet |

A web URL can expose a web app, an artifact download, a protocol console or a streamed native process. Those are different experiences. Creating an artifact URL does not mean a native app has run, and a library does not acquire meaningful GUI behavior merely because a portal exists.

## Recommended execution order and acceptance criteria

1. **Close false-green and inconsistent evidence paths:** G01–G07, G12 and G18. Required-test failures must block every provider; web checks must all run; stale owners/observations must not alter current evidence; all manual operations must preserve the same release contract.
2. **Make replacement/recovery safe:** G08–G11, G13–G14. Qualify stable routed switching, failed Compose replacement, restartable rollback, data compatibility, worker loss and non-blocking progress reporting.
3. **Establish the production execution boundary:** G15–G16 and G23–G25. Qualify disposable workers, tenant-authenticated previews, private build inputs, source-bound CI and independent release evidence.
4. **Prove actual application workflows:** G17, G20–G22 and G27–G29. Require replayable scenarios and useful coverage/unknown states. Monitor representative user/worker results, not only startup.
5. **Add capability-specific lanes and qualify them:** G19, G26 and G30. Start with a real Android emulator worker on the available PC, then an isolated Windows lane; macOS/iOS requires appropriate hardware/OS. Add provider/device lanes only with real build, launch, interaction and recovery evidence.

Performance acceptance should measure stage timings separately: queue wait, dependency fetch, build, tests, candidate start, workflow execution, route switch and verification. The recorded cached web rebuild took 42.38 seconds; that is historical evidence, not a current benchmark or a 2–3 second release promise. Cached dependencies, reused toolchains and bounded worker concurrency can improve throughput, but neither faster code nor a GPU substitutes for correct lifecycle checks.

The product target should be explicit supported lanes with truthful passed/failed/blocked/unknown coverage. “Any repository, every test case, 100% success” cannot be a meaningful production guarantee when requirements, credentials, dependencies, source correctness or required operating systems are absent.
