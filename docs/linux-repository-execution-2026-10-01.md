# Linux repository execution — 1 October 2026

StackPilot now selects versioned Linux toolchains from repository manifests, executes mixed component contracts, retains long-running job candidates for asynchronous observation, and lets leased agent tasks build custom SDK images. Docker is the current executor. [Task-owned Ubuntu, Debian and Alpine instance provisioning](docker-instance-provisioning-2026-10-01.md) is now implemented; automatic EC2 or other cloud provisioning is deferred.

## Implemented behavior

- Discovery reads bounded version evidence for Node, Python, Go, Rust, Java, .NET, Ruby and PHP. Explicit Dockerfiles and build recipes remain authoritative. Conflicting versions or ambiguous component roots require configuration instead of silently choosing a different application.
- Generated Linux recipes and dependency setup use the selected toolchain and repository package manager. Java wrappers from Windows checkouts run through a private normalized copy; protected source bytes and executable modes remain unchanged.
- Independent acceptance chooses an environment for each repository component. Frozen completion checks retain their original image, setup, network settings and feature assertions. A newer source revision invalidates previous acceptance.
- Version 2 component plans support API/web, worker, TCP, CLI, finite job and package adapters in one isolated Compose candidate. Declared worker checks run inside the actual component container. Each component must pass its own assertions before the graph can be promoted.
- Finite jobs run once with a configured deadline from one second to 24 hours, defaulting to one hour. Pending jobs return actual execution identity, progress and output. The deployment queue stores the exact candidate, encrypted execution configuration and original deadline, releases its worker, and resumes observation without rebuilding or consuming another build attempt.
- Docker container ID, image ID, start time, restart count and published endpoint bind component verification to the observed candidate. Jobs additionally pin their actual execution ID. Replacement, replay or a change during verification cannot inherit the previous release proof.
- Saved graph health checks collect fresh observations. Monitoring uses declared monitoring scenarios, while the stable public route receives a separate transport check.
- Agent tools expose `get_execution_capabilities`, `build_worker_image` and `run_worker_command`. A custom SDK build receives bounded task source and returns an observed immutable image digest. Other runs cannot use it, and revoked task leases cannot execute it. Guest containers receive no Docker socket, host mount or control-plane credentials.
- Terminal-run SDK cleanup runs independently of task scheduling. It rechecks ownership labels, retains images referenced by any container, avoids force removal, and persists bounded retry state for unavailable cleanup.
- Runtime helper staging batches independent copies with at most eight threads. Source sealing preserves deterministic archives while avoiding redundant mounted-filesystem metadata calls; archive traversal and links remain rejected.
- Failed Compose releases retain the safe cleanup identity for their candidate or previous serving runtime. Cleanup admits the generated `compose.safe.json` filename in addition to repository YAML, so failed attempts do not prevent project deletion.

## Configuration and future provisioning

`STACKPILOT_AGENT_WORKER_FAMILIES` admits numeric versions of configured SDK families. `STACKPILOT_AGENT_WORKER_IMAGES` registers explicit custom or private image references. `STACKPILOT_AGENT_WORKER_NETWORK`, `STACKPILOT_AGENT_LOCAL_WORKERS` and resource limits still control task execution.

Sandbox admission reports configured capabilities and, when requested, the observed Linux Docker daemon architecture. The registry now reports the implemented Docker container provisioner and separately identifies cloud provisioning as deferred. Missing capabilities return concrete prerequisites and an unfulfilled provisioning request; unavailable hardware is not fabricated. Admission alone does not prove that an image can be pulled or application tests pass. The instance provisioning report records the current resource, ownership, lifecycle and live qualification boundaries.

## Practical limits

This is not a claim of 100% compatibility with arbitrary repositories. A repository that contains 2% of a product still needs intended behavior, meaningful acceptance, dependencies and any required credentials. The agent can implement and repair declared scope; an executable placeholder cannot satisfy unfinished product requirements.

Stateful backup/recovery orchestration, component-aware Kubernetes/remote recovery, automatic cloud provisioning, special hardware/device mounting, and arbitrary native operating-system requirements remain outside this new local Linux component executor. Unsupported assertion lanes are rejected explicitly. Large cold builds and acceptance commands remain bounded by their configured worker deadlines. Package outputs are verified as artifacts, not represented as running web applications.

The qualification artifacts distinguish real fixture execution from autonomous model performance. Successful fixture execution does not establish a universal repository success percentage or prove that a particular model will finish every incomplete application.

## Qualification artifacts

- `linux-toolchain-qualification-2026-10-01.json`: actual generated Docker builds, original repository checks and interactive CLI outcomes for five languages.
- `linux-component-qualification-2026-10-01.json`: six actual Linux service types, assertion rejection and restart identity checks.
- `component-broker-qualification-2026-10-01.json`: authenticated mixed-service release and durable pending-job integration.
- `agent-sdk-broker-qualification-2026-10-01.json`: authenticated SDK build, command execution, ownership/lease rejection and terminal cleanup.
- `agent-sdk-qualification-2026-10-01.json`: separate helper isolation fixture; its lease callback was mocked and is not live broker evidence.
- `long-job-qualification-2026-10-01.json`: actual finite execution exceeding the former 45-second ceiling, with replay rejection.
- `completion-repository-qualification-2026-10-01.json`: scripted completion of an unfinished CLI, four frozen feature checks, rejection of unverified release and invalidation after later source edits. This uses real tool execution with no autonomous-model reliability claim.

The JSON records carry their own pass/failure results. Initial failed qualification records are retained where they explain repairs; they are not counted as passing tests.

Unit/regression verification: 207 C++ tests passed; 150 deployment-runtime tests passed on Linux; 240 AI tests passed across the full run and the network-enabled WebRTC follow-up, with 46 optional tests skipped. The initial network-disabled AI test container lacked a WebRTC interface; those three errors were rerun successfully with a local interface. Logs are saved alongside the qualification records. Existing calculator, club website and portfolio projects were preserved; fixtures used disposable accounts and projects.

The final authenticated mixed-service fixture passed all seven checks, including an actual backend restart during an 85-second job, unchanged candidate/execution identities and build attempt, fresh health after a worker restart, failed replacement rejection, retained previous release, and safe project cleanup. The live SDK fixture and long-job replay fixture also passed. The unfinished-calculator fixture passed all four frozen feature checks and blocked a later unverified revision.

An older disposable fixture source folder, `local-projects/component-release-qualification/b59d78df10f0`, remains: automatic approval review rejected recursive deletion with the reason "blocked by policy." Its containers and database records were removed. This is test source, not an existing user project.
