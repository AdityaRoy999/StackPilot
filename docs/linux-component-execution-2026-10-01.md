Linux component execution
=========================

Version 2 repository plans now compile mixed Linux web/API, worker, TCP/gRPC,
interactive CLI, finite job, and artifact/package components into an isolated
Compose candidate. Every network component receives an ephemeral loopback port;
the primary component identifies the advertised endpoint. Secondary declared
health checks, browser assertions/scenarios, console scenarios, job completion,
and package artifact hashes participate in the same release gate.

The broker records each exact daemon container ID, image ID, start time, restart
count, and published endpoint. Runtime evidence carries a digest of the compiled
component contracts. The AI-service verifier returns those identities alongside
actual per-component outcomes. The broker must collect identities again after
verification before promotion, so a replaced/restarted candidate cannot inherit
old success. Worker process assertions execute argument arrays inside the exact
isolated candidate container. Long-running business tests belong in repository
tests, rather than readiness checks.

An example worker component:

```json
{
  "id": "worker",
  "root": "worker",
  "workload": "worker",
  "capabilities": ["linux", "process"],
  "process_checks": [
    {
      "argv": ["python", "verify_worker_ready.py"],
      "timeout_seconds": 10,
      "output_contains": "ready"
    }
  ]
}
```

An explicit existing Compose topology remains authoritative and cannot be
overwritten by generated components. Component state declarations still require
a genuine backup/migration/recovery executor; promoting fresh volumes as if they
contained production data is rejected. Unsupported native worker, hardware,
orchestrator, replica, or capability requirements produce specific blockers.
Cloud provisioning is deferred. TCP/gRPC currently proves connectivity unless
repository tests cover protocol behavior; it does not claim business correctness.
Workers without declared process checks prove process stability only. Desktop
business/device workflows still require their corresponding verifier.

Qualification:

- 13 repository plan tests and 5 container-evidence tests passed.
- 6 component-verifier tests cover failures, pending job identity, contract
  tampering, stale snapshots, exact images, and the ordinary single-root lane.
- `tests/integration/linux_components_smoke.py` exercised six real Docker
  adapters: API JSON assertions, a worker process check, original CLI input and
  output, a completed job, artifact download/hash, and TCP connectivity. It also
  rejected an actual assertion mismatch and observed a worker restart changing
  the bound identity. The disposable image and containers were removed.
- Evidence is in `linux-component-qualification-2026-10-01.json`. This fixture
  qualifies the component executor/verifier, not model repair accuracy or the
  backend's final release transaction.
