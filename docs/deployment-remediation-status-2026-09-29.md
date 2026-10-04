# Deployment remediation status — 2026-09-29

This is the current status following the G01–G30 audit. The earlier audit and D01–D36 progress file are historical baselines. macOS/iOS execution is deliberately deferred at the owner's request. The available execution environment is one Windows PC, Linux Docker Desktop and a dedicated local Android emulator.

## What now works and what green means

The qualified local single-image web path is source snapshot → build → required repository tests → immutable image → separate candidate → HTTP checks → browser readiness and declared acceptance scenarios → stable preview route → routed verification → completed job. A candidate is not presented as a successful release before routed verification. A failing required test or missing selected build credential leaves the previous serving release available.

Manual Docker/Kubernetes deployment requests now enqueue the common release pipeline rather than bypassing its recorded plan. Only the local Docker path was qualified against a real runtime in this pass. Local rollback can recreate a stopped checkpoint from its immutable image and encrypted runtime configuration, verify the application and the routed origin, and restore previous route/state if routed verification fails. Historical attempts and recreated rollback containers are journaled for deletion/reconciliation. Retained images can outlive deleted projects; bounded retention/garbage collection is still required.

Declared browser scenarios require explicit final outcomes. Blank HTML, uncompiled source, visible loading indicators, broken assets, console errors and wrong form results do not pass the respective render/workflow checks. Repository-reported test evidence remains distinct from independent application acceptance. A smoke check or a few declared scenarios cannot prove an entire product correct.

The native Gradle Android fixture now goes through the actual queued platform pipeline, builds/tests/lints a debug APK, verifies its bytes, installs and launches on the local emulator, fills a native field, taps a button, asserts the resulting text, and provides a deployment-scoped authenticated browser preview of the real app. This is Android execution, rather than an Expo/web substitute. The worker can recover an owned, hash-checked foreground release after restart. Its single-device PNG stream is a development implementation; it does not meet a verified 60 FPS streaming SLO or provide a production tenant boundary.

Native project/deployment deletion now calls authenticated, deployment-specific worker cleanup before removing its records. The live fixture confirmed worker restart recovery and then project deletion: new preview tickets were denied and an already-issued ticket received no further device frames. A busy/unavailable cleanup worker blocks deletion and retains records for retry. The latest qualification fixture was intentionally deleted after this test; its screenshot and evidence remain.

Monitoring stores release-bound healthy/failed/unknown observations under durable monitor leases. Web render probes run periodically alongside cheaper transport checks. Process monitoring uses fresh Docker inspection. An active Android release receives a fresh foreground observation as well as artifact-inventory checks. Recurring workflow submissions require a separate `monitor_scenarios` opt-in; release acceptance scenarios are not silently replayed. Foreground/liveness observations do not claim workflow correctness. Missing verifier/worker capacity is unknown rather than an instruction to rewrite application source.

## Qualification evidence

| Check | Result and scope |
| --- | --- |
| C++ | Backend compilation and 199 unit checks passed. Controller/provider integration requires the separate live tests below. |
| Deployment helpers | 53 Linux contract tests passed, including actual child-process failure/timeout, snapshots, evidence, selected build secrets and monitoring contracts. |
| AI service | Deterministic suite: 133 passed and 51 opt-in tests skipped out of 184. Full live-browser suite: 179 passed and 5 skipped out of 184. This is regression qualification, not a model reliability benchmark. |
| Frontend | 101 unit checks and TypeScript checking passed during this remediation. Lint remains failing: 168 errors and 118 warnings in the existing tree. CI's lint step is still non-blocking. |
| Live platform | 58 API/platform checks passed, including authentication, access control and secrets. This does not exercise every provider/controller state. |
| Runtime render | Eight real Chromium cases passed, covering good/bad rendering and correct/incorrect form outcomes. |
| Local release | Eight live cases passed: initial release/workflow, stable origin switch, rejected test failure, recreated rollback, queued manual redeploy, BuildKit credential handling, missing credential rejection and removal of all five journaled runtime instances on project deletion. |
| Browser authorization | Owner capability connects; missing/forged/cross-session capabilities, cross-user ticket/stop and unscoped stop are rejected. |
| Native worker | Seven boundary/recovery/cleanup tests passed. Real queued Android workflow, restart and preview-revocation evidence is recorded separately. |
| Production configuration | Local and production Compose resolve successfully with a temporary test domain. The production topology has not been booted and qualified on a real domain/provider. |

At the end of qualification, local backend health, AI dependency readiness, Prometheus readiness, Grafana health and Loki readiness all returned HTTP 200. The updated backend, AI service and native worker are running; the owned compilation-only container was stopped. Readiness responses do not prove every dashboard/query or production topology works.

Reproducible live results are in [release-pipeline-qualification.json](release-pipeline-qualification.json), [browser-authorization-qualification.json](browser-authorization-qualification.json), [android-pipeline-qualification.json](android-pipeline-qualification.json) and [the Android screenshot](screenshots/android-workflow-qualified.png). These are local fixture evidence, not fleet-wide or arbitrary-repository guarantees. Integration CI now runs release/rollback/credential/cleanup and browser-ownership fixtures; native emulator execution remains an opt-in Windows hardware check.

## Every finding from the latest audit

“Implemented” describes code, and “qualified” describes the tested lane. A partial finding remains open for its stated scope.

| ID | Current state | Changes and remaining work |
| --- | --- | --- |
| G01 | Gate implemented; provider qualification partial | Required image evidence gates added to local Compose and remote single-image branches. Explicit `test_services` can select prebuilt Compose services. Remote/Compose failure integration still needs real target qualification. |
| G02 | Corrected; helper tests passed | Generated Java/CMake/Flutter/Expo stages preserve test evidence. Actual builds across every generated toolchain remain to qualify. |
| G03 | Corrected; real Chromium qualified | Declared HTTP contract checks run before browser render checks and remain in the proof. |
| G04 | Strengthened; bounded acceptance | Loading-only pages, broken assets, console errors, readiness assertions and outcome scenarios fail appropriately. Undeclared application requirements remain untested. |
| G05 | Corrected locally; other providers partial | Manual requests queue the release plan and verification. Real local manual redeploy passed; real Kubernetes/SSH qualification remains. |
| G06 | Local web recovery qualified; partial | Immutable local checkpoint recreation, candidate/routed verification and compensation implemented. Rollback is not yet a complete durable operation across crashes/providers; a crash between runtime creation and journal registration can still require reconciliation. Android device-session rollback/restoration is not qualified by the web rollback fixture. |
| G07 | Hardened; crash matrix partial | Lease/attempt fences protect promotion/evidence; candidate journal and bounded cleanup reconcile abandoned local resources. Full crash/cancel timing and remote resource qualification remain. |
| G08 | Local HTTP qualified | Atomic database route/environment switch with generation and post-route verification, plus compensation. Local gateway is loopback-only; public TLS and remote/provider equivalents remain. |
| G09 | Stateless local candidate changes; stateful partial | Attempt-specific Compose identity and relocated immutable source prevent obvious same-project overwrite. Real failed replacement, named-volume continuity and stateful migration/traffic safety remain unqualified. |
| G10 | Local checkpoints/cleanup qualified; retention partial | Retirement preserves immutable images/checkpoint material. Project deletion removes earlier attempts and rollback runtimes, and shared images are retained. Bounded image/source/checkpoint retention and GC remain. |
| G11 | Open | Explicit state ownership, migration compatibility, verified backups/restores and cross-release data safety are not a complete release gate. |
| G12 | Configuration corrected; production boot pending | Production includes the browser worker, required AI database/readiness configuration, AI WebSocket route, frontend URL configuration and Alloy log collection. A real production boot/route/observability qualification is outstanding. |
| G13 | Partially corrected | External lifecycle work is dispatched away from request event loops through a bounded task runner. Durable job/state machines for every mutation, bounded admission and rollback transaction shortening remain. |
| G14 | Local immutable snapshot implemented; distributed partial | Sealed source contexts and deterministic content-addressed archives preserve release input. Shared durable storage/registry, immutable repair patches and replacement-worker replay remain. |
| G15 | Open; production isolation blocker | Runtime limits are useful, but shared control-plane Docker is not disposable tenant execution. Dedicated workers, quotas/network restrictions, scoped credentials and an adversarial isolation qualification are still required. |
| G16 | Browser/Android capability boundary qualified; partial | Tenant-scoped signed tickets, control/view permissions, expiry and ownership checks protect these streams. Linux noVNC/public application previews and shared display/worker isolation still need the same qualified tenant boundary. |
| G17 | Monitoring expanded; partial | Periodic render, separately opted-in monitor scenarios, fresh process inspection and native foreground checks exist. Queue consumption, application business SLOs, full device workflows and external-service monitoring remain. |
| G18 | Corrected in monitor writes; scale qualification partial | Unknown observations persist, exact job/URL ownership fences writes, and verifier outages do not trigger source repair. Adversarial promotion/probe races and larger outage matrices remain to qualify. |
| G19 | Durable leases implemented; SLO open | Exclusive per-target monitor claims and bounded probe concurrency support multiple service instances. Fair tenant scheduling, capacity-aware assignments and measured detection/recovery under load are not qualified. |
| G20 | Typed blocks added; continuation partial | Missing native capability/permission prerequisites are blocked rather than retried as code defects. Structured prerequisite input/resume and real model repair followed by original regression replay remain. |
| G21 | Open orchestration | Bounded component discovery is not a complete dependency, data, secret, test and routing graph for arbitrary monorepos. |
| G22 | Conditional support | Existing Dockerfiles and explicit Linux recipes allow custom toolchains. Automated SDK/engine/architecture resolution and a real fixture matrix across claimed stacks remain. |
| G23 | Local BuildKit adapter qualified; other lanes open | Explicitly selected project secrets use private temporary inputs and BuildKit mounts, with log redaction and cleanup. Live secret/missing-secret cases passed. Compose/remote secret adapters, SSH mounts and signing/cache policy remain. Malicious source can deliberately transform/exfiltrate credentials; this is not a hostile-repository isolation guarantee. |
| G24 | Contract policy implemented; product/provider partial | Commit binding, bounded pagination, named checks, trusted app identities and legacy statuses are supported; skipped/neutral checks do not count as passed. The global policy is wired through both Compose topologies. Policy UI, external GitHub fixture qualification and operational rollout remain. |
| G25 | Open supply-chain policy | Local image identity, artifact hashes and independent acceptance checks exist. Trusted provenance, SBOM/vulnerability gates, release signatures and architecture-aware routing are not implemented as a complete policy. |
| G26 | Real Android lane added; other lanes open | Local Gradle/APK/emulator workflow and authenticated preview qualified. Isolated native Windows build/run/stream, finite-job executor and package/store publication remain. Native Flutter/React Native generality is not proved. macOS/iOS execution is deferred. |
| G27 | Bounded audit; full coverage open | “Test this website” runs discovery and bounded safe exploration, not every business requirement/state. Explicit coverage/scenario generation, accounts/test data and meaningful expected outcomes remain necessary. |
| G28 | Open protocol breadth | Frame/file/dialog/external integration coverage, authenticated API mutations, database/gRPC exchanges and dedicated visual/accessibility/load/security suites are incomplete. |
| G29 | Partial journals; fleet/subagents open | Browser journals expose uncertain interrupted actions; RAM/cookies are not durable browser recovery. Advertised `invoke_subagent` still reports unsupported. Independent task workers and isolated browser/display allocation remain. |
| G30 | Expanded evidence; incomplete production matrix | Local release/recovery, Android and stream authorization now have real fixtures and CI additions. Model healing, stateful/Compose/remote/Kubernetes/Windows lanes, production boot, lint debt and performance/isolation SLOs remain. |

## Remaining implementation order

1. Move untrusted execution off the shared control plane; register workers with authenticated capability/capacity/lease ownership. Add tenant-authenticated application and desktop preview routing. Acceptance: one tenant cannot view/control another runtime or consume another assignment's credentials/resources.
2. Implement complete durable lifecycle operations, shared source/artifact storage and bounded retention. Exercise kill/restart during build, promotion, rollback and cleanup; require exact release identity and no lost serving route/resources after recovery.
3. Add explicit stateful component plans, migration/backup/restore gates and named-volume ownership. Qualify a frontend/API/database/worker product with failed migration and compatible/incompatible rollback scenarios.
4. Finish typed blocked prerequisites and resumable repair; qualify a real model-driven source fix by replaying the original failure and refusing suppressed tests/placeholders. Add persisted product coverage rather than treating crawl completion as exhaustive correctness.
5. Implement the isolated Windows GUI lane and finite-job/package adapters, then signing/publication policies. Add source-declared toolchain resolution and real repository fixtures for each advertised lane. macOS/iOS stays deferred.
6. Boot the production topology, qualify providers and observability, remove the lint debt, and measure queue/build/workflow/route/stream/detection/recovery percentiles under load. Enforce release SLOs only after measurement.

These include substantial outstanding code work. They are not all solved merely by supplying another machine. No local fixture results justify “any repository, every test case, 100% success,” a universal 2–3 second build/release, or constant 60 FPS.
