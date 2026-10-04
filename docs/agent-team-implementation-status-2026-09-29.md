# Autonomous repository delivery: implementation and qualification

This implements the first delivery unit of [the universal repository plan](universal-repository-agent-plan-2026-09-29.md): real agent sessions, durable coordination and safe integration into the existing release pipeline. Initial component planning and independent acceptance execution are also implemented. The six-phase plan is not completely implemented or production-qualified.

The later [repository completion milestone](repository-completion-2026-10-01.md)
adds frozen intended features, per-check toolchain/setup selection, execution-based
feature status and matching source/contract release gates. Its deterministic
mostly empty CLI fixture passes; current live Nemotron qualification remains
unverified after provider failures. Read that report for the current evidence.

## Implemented behavior

- `spawn_agent` creates an actual asynchronous model/tool session. Roles are free text; workers can create smaller subtasks. There is no mandatory Architect/Coder/Verifier team.
- Runs, tasks, messages, requirements, checkpoints, patches and ordered action events persist in PostgreSQL. SQLite is an explicit offline test adapter.
- Lead and workers share a root model-turn budget. Capacity, task/depth limits and deadlines bound execution. Idle runs cannot fill the scheduler's eligibility window and starve new tasks.
- Independent edits run concurrently in private source copies. Overlapping write scopes serialize. A worker cannot expand its parent's file scope into a directory scope.
- Broker-owned Git metadata stays outside executable repository directories. File writes require an observed revision; worker source imports are bounded and check content and executable modes.
- Workers explicitly submit their actual patch and stop. Submission reports `verified=false`. The lead owns integration and combined acceptance; private workspaces do not receive peer edits automatically.
- Integration compares original paths and modes with current source. Conflicts become requirements and replacement tasks. Canceled tasks cannot publish late patches.
- Prerequisite resolution retains saved context and resolution evidence. Interrupted execution requires reconciliation. Undispatched calls in an interrupted multi-call response are closed as not executed, not replayed.
- Repository commands execute in disposable, resource-limited Docker containers containing assigned source. Guests receive neither control-plane credentials nor its Docker socket. Image/network capabilities are server policy.
- Original regression files and declared acceptance commands/scenarios cannot be removed or weakened by repair. Required flags stay required; additional tests are permitted.
- `verify_agent_source` independently executes declared tests on the integrated revision. Actual process status and exit codes determine the result. Further source edits invalidate that proof. Model text and image-supplied success JSON cannot substitute for it.
- The existing rebuild queue consumes sealed accepted source, including a first deployment, without silently re-cloning the original repository and discarding repairs. Existing candidate, routing and exact-job verification gates remain authoritative.
- Legacy build aliases use the same gate. Lead and child tools reject cross-project targets. Commands requiring a deployment cannot silently fall back to a different owned deployment.
- Approval uses a signed, expiring token bound to user, session, run, tool and exact arguments, consumed once. Model-supplied booleans and approval phrases in chat/history do not authorize actions.
- The frontend displays actual worker IDs/states and individual tool steps/screenshots. Same-role workers remain distinct. Screenshot artifacts have authenticated owner/project access checks. Narration no longer manufactures completed worker cards.
- Provider connections are reused. Transient model requests have bounded retries without replaying tools or silently switching a selected model. Repeated invalid calls stop early; additional tool schemas load on demand.
- The lead receives its authorized repository identity and file inventory at attachment. It starts with delivery tools and loads other schemas on demand, shares the worker connection pool, and retains a final answer without a duplicate paid synthesis call. Its repository prompt no longer forces framework/image defaults from the older chat prompt.
- Repeated waits, status reads and source observations remain available while work progresses. They are not treated as duplicate mutations by the browser-oriented loop guard. Lead timing and retry events are persisted alongside tool events.
- GLM-5.3 Fast/Thinking requests map to low/high reasoning budgets. NVIDIA documents that thinking is always enabled for this model and defaults to its largest budget, so the older `enable_thinking=false` setting could not implement Fast mode. See [NVIDIA's model-specific guidance](https://docs.nvidia.com/nim/vision-language-models/latest/get-started/advanced/get-started-glm-5-3-flash.html). Hosted-protocol and outcome qualification of the new budget mapping is still outstanding, as described below.
- A selected project's runtime URL no longer forces repository deployment requests into a browser-only tool set.

## Component planning

Version 1 remains supported. Version 2 declares a primary component, separate roots, workloads and dependencies. Cycles, missing dependencies, duplicate roots and path escapes are rejected. Stateless Linux components can be prepared in separate contexts and compiled into the existing Compose lane.

Generated topology has an ownership digest. Preparation is repeatable and preserves the authoritative version 2 input. Manual Compose edits are not overwritten. A nested primary component can supply its inferred Dockerfile port.

Accepted-source export preserves all broker-sealed bytes, including prebuilt `target/` artifacts and environment templates; it does not apply a second, inconsistent source filter. Backend Docker compilation layers now depend on C++ inputs rather than runtime helpers, migrations or qualification files.

Stateful promotion, mixed native/finite components, unavailable capabilities and secondary-service runtime assertions produce explicit blockers. This is narrower than the proposed full worker registry and multi-adapter graph executor. Primary smoke and secondary image tests do not prove every component's business workflow.

## Verification

Automated suites exercise isolated Git source, concurrent real tool loops with a deterministic provider, stale leases, cancellation, dependencies, conflicts, regression protection, exact-revision acceptance, provider recovery and frontend replay/status behavior. Deployment regressions include repeatable version 2 preparation, nested ports, topology preservation and unsupported verification/capability rejection.

Backend and AI images build. Migration 062 is applied to local PostgreSQL. The live test, `tests/integration/agent_team_smoke.py`, uses two real model workers to repair disjoint files, integrates their patches, independently runs the original combined tests in Docker, and requires the first release to pass its exact job's routed assertion. Resources are disposable. Results and model latency are saved to `docs/agent-team-model-*-qualification.json`; a passing fixture qualifies only that provider/model/workload.

The initial configured vision model repeatedly generated invalid delegation arguments. Another model timed out. A stronger model repaired defects but initially wasted turns on unintegrated peer tests and coordination, then exceeded the test deadline. These were failed qualifications. Explicit submission, fresh observations, real peer IDs and the revised handoff boundary address that waste; upstream latency remains a measured limitation.

The live repaired-source delivery fixture passed with `z-ai/glm-5.3-flash`: two model patches, original independent regression tests, first deployment and exact-job routed assertion. It took **285.96 seconds**, including ten model calls measuring **25.5–64.6 seconds** each. This does not meet the requested speed goal. Backend and AI fast-mode defaults now agree on that qualified model. The local `.env` Fast-mode default was updated from the vision model that failed worker qualification; explicit request/UI model selections still take precedence. Separate browser vision configuration remains available.

The separate [live access qualification](agent-team-access-qualification.json) passed five checks: owner event replay, internal broker exclusion from public JWT tools, tenant read isolation, body identity forgery rejection and owner cancellation. The [live model delivery evidence](agent-team-model-qualification.json) contains source/job identity and latency; its disposable application was removed after verification.

The first single-prompt lead qualification failed after its actual worker repaired and tested the source: the old repeated-action guard stopped lead progress before integration and release. It took 761.35 seconds and is preserved in `agent-lead-model-initial-qualification.json`. The revised observational wait guard, assigned-source context, prompt, tool loading and pooling are separately exercised by deterministic regressions. A rerun qualifies the live lead policy only when its exact-job release assertion passes.

The next lead attempt failed on provider DNS transport before scheduling a worker; it is retained in `agent-lead-model-transport-failure-qualification.json`. A host time discontinuity also interrupted one Windows test run, producing Git process timeout errors with negative remaining wait intervals; that run is not counted as passing. A fresh suite ran normally afterwards. Lead DNS/transport retries are now bounded and preserve the selected model and existing tool evidence.

The provider catalog is reachable, but current completion probes timed out before response headers. The non-streaming low-budget request exhausted three bounded attempts. The subsequent 40-second streaming probe and the paired comparison of **both the prior request format and the documented low-effort format** timed out. See `agent-provider-effort-qualification.json` and `agent-provider-effort-comparison.json`. This does not establish hosted compatibility, a latency improvement or revised-policy completion. The earlier 285.96-second worker delivery pass used the previous effective reasoning profile; changing reasoning budgets needs a new live accuracy/latency qualification.

The C++ suite passed **199 tests**. Frontend passed **104 tests** and TypeScript checking. Deployment contracts passed **61 tests with 3 explicit skips**. The final AI suite ran **219 tests: 173 passed, 46 skipped**, in 150.413 seconds. Live browser/hardware fixtures require their own opt-in environment and are not counted as passed when skipped. These four suites total **537 passed and 49 skipped**; the live model and access qualifications are separate evidence.

## Remaining work

The user's selected `nvidia/nemotron-3-super-120b-a12b` was subsequently tested explicitly on disposable fixtures. This uncovered and fixed scoped capability/schema mismatches, first-deployment target requirements, empty-response handling, HTTP-200 provider error detection, bounded 500 retries and dashboard error serialization. The model generated fast tool calls and source edits, but the end-to-end qualifications failed amid hosted 500/503 responses; it is not qualified as a reliable delivery model. See [the Nemotron qualification](nemotron-model-qualification-2026-09-29.md) for each attempt and the 61 targeted regression checks. Saved model preferences were not changed.

| Plan area | Remaining implementation or qualification |
| --- | --- |
| Real runtime | Live service-loss matrix, tenant fairness/load qualification and source/artifact garbage collection. Lease/checkpoint tests are not complete chaos qualification. |
| Integration | Semantic/API compatibility checks, richer diff/contract UI, and crash tests at every integration/release boundary. |
| Repository graph | Worker capability registration/placement, toolchain resolution, component-specific verification images/setup, secondary runtime outcomes and complete service/data graph discovery. |
| Repair/release | Unseen repositories and realistic frontend/API workflows; lead policy qualification from one “Deploy this repository” prompt; state migration, backup, restore and rollback executors. |
| Native/non-web | Generic Windows/Linux desktop adapters and GUI outcomes; finite job/library/package consumer execution; preview authentication, session ownership and concurrency qualification. Existing native fixtures do not establish framework-independent support. |
| Production | Separate workers with a qualified hostile-repository boundary, shared immutable artifact storage, signing/provenance, quotas and recovery/load tests. Local Docker workers are disabled by default in production Compose. |
| Media | Sustained presented-FPS/input-latency qualification under concurrent model/build load. This change does not establish smooth 60 FPS. |

macOS/iOS execution remains deferred. Private credentials, signing identities, unavailable OS/hardware and missing product requirements remain prerequisites. No current test matrix supports “every repository” or “every test case” success.

## Local operation and reproduction

The named `agent_workspaces` volume is writable by AI user 10001 and mounted read-only by the backend. Uploaded/local source is imported read-only. A workspace initializer sets permissions. `STACKPILOT_AGENT_TEAMS_ENABLED` controls this integration.

The final backend and AI images were built and activated locally. Backend, AI and frontend report healthy. Migration 062 is present in PostgreSQL, the final JWT/access fixture passed again after activation, and no disposable agent command containers remain running. The development frontend reads the changed source through its existing hot-reload mount. A healthy control plane does not mean an upstream model completion is available.

Default admission is three simultaneous tasks per run, four globally, 64 tasks, depth six, 256 combined model turns and a one-hour deadline. These are capacity policies, not a fixed team composition. Image policy, network capability and command timeouts remain configurable.

A legitimate original acceptance change must be made explicitly outside the repair run and recaptured in a new run. The repairing model cannot waive it. Resolving a requirement supplies continuation evidence; executors still check the actual capability or credential.

```powershell
# Repository root, with the local Docker stack running:
python -m unittest discover -s tests/deployment -q
# AI tests need app imports:
Set-Location ai-service
python -m unittest discover -s tests -q
Set-Location ..
# Makes real provider calls; only disposable fixture resources:
python tests/integration/agent_team_smoke.py z-ai/glm-5.3-flash
```

Frontend checks are `npm test` and `npx tsc --noEmit` from `frontend`. Repeat live qualification when changing models, provider protocol, worker adapters or release gates.
