# Repository completion and verified delivery

The broader remaining implementation is recorded in [the StackPilot completion
plan](stackpilot-completion-plan.md), deferred at the owner's request on 1 October
2026. This document describes the existing completion contract implementation
and its qualification boundaries.

New repository-agent runs now require a completion contract before release.
The contract describes the intended finished application, assumptions, workload
and executable acceptance checks for every declared feature. Agents can implement
missing files and features using their existing scoped source/worker tools.
The normal release pipeline builds the accepted revision and verifies its actual
runtime after source acceptance passes.

## Behavior

1. Import source and preserve original tests and acceptance inputs.
2. Import `stackpilot.completion.json` automatically when supplied. Otherwise the
   lead reads the request, README and original behavior and calls
   `define_completion_plan`. Essential missing product intent still needs a
   requirement; the platform does not silently invent a finished product.
3. Freeze the normalized contract in PostgreSQL, outside editable source.
   Identical retries are idempotent. An agent cannot drop a feature or replace a
   failing check with an easier one within that run. An intentional scope change
   requires a new run.
4. Implement and integrate source changes. `get_completion_status` reports
   per-feature failed/unverified/passed state for the current integrated revision.
5. `verify_agent_source` executes original repository tests and frozen feature
   checks in disposable workers. Each feature can select its own allowed image,
   dependency setup, component root, network capability and timeout. Exit codes,
   timeout state and optional output assertions determine the result.
6. Release requires all declared features to pass on the exact source revision
   and contract digest. Any subsequent source edit invalidates the proof. Both
   the Python runtime and the C++ release broker enforce the gate.
7. The existing candidate/routed runtime checks still apply. A source test pass
   is not a successful deployment. CLI delivery remains a real interactive
   program; a library remains a package, rather than a substituted website.

The chat tool panel presents the feature results, assumptions and source
revision. A historical result refers to that revision; it is not a live claim
about later source. Existing active runs without the new requirement flag remain
compatible. The server enables the requirement for newly attached runs.

## Contract example

This check executes the actual CLI and asserts its behavior. Freeze inline
assertions or refer to original protected tests, rather than relying on a mutable
new test script as the only acceptance oracle.

```json
{
  "version": 1,
  "summary": "Complete the documented greeting CLI",
  "workload": "cli",
  "assumptions": ["The README defines the supported command syntax"],
  "features": [{
    "id": "greeting",
    "description": "Greet the supplied name through the CLI",
    "checks": [{
      "image": "python:3.12-slim",
      "argv": ["python", "-c", "import subprocess; r=subprocess.run(['python','greet.py','Ada'],capture_output=True,text=True,timeout=5); assert r.returncode == 0, r.stderr; assert 'Hello Ada' in r.stdout, r.stdout"],
      "timeout_seconds": 30
    }]
  }]
}
```

Contracts support web/API, CLI, worker, job, TCP/gRPC, package/artifact and native
workload labels. A label does not supply an unavailable platform worker, compiler,
credential or hardware capability. Existing runtime support boundaries remain in
[the compatibility report](repository-compatibility-status-2026-09-30.md).

## Qualification and limits

- Nine new completion tests execute real Python assertions against an unfinished
  CLI and a repaired implementation; verify frozen requirements, resume, worker
  permission, protected original contracts and stale-source release rejection.
- All 36 existing agent-team regressions pass.
- The full AI suite executed 197 tests successfully and skipped 59 opt-in tests
  (256 collected). The first network-disabled attempt failed three WebRTC tests
  because no interface existed; the run with normal networking passed.
- Backend image builds, including its existing C++ qualification target.
- Frontend TypeScript checking passes.
- `tests/integration/completion_repository_smoke.py` passed seven real integration
  cases using a mostly empty CLI fixture with four independently specified
  features. It exercises Docker acceptance workers, a direct C++ broker rejection,
  immutable acceptance, image building, routed interactive console verification
  and proof invalidation after a later edit. This uses a known fixture repair and
  no model calls; it does not measure autonomous model success. Evidence is in
  `completion-repository-qualification-2026-10-01.json`.
- A real NVIDIA Nemotron lead qualification did not pass. The first attempt
  supplied a JSON-encoded nested contract, then hit provider 503 errors. Valid
  encoded objects now normalize identically to structured objects (tested),
  without weakening validation. The second attempt accepted that plan and used
  real worker tasks but hit repeated provider 500/503 responses and ended
  unverified; its premature rebuild attempt was blocked. No successful live
  model release is claimed. Evidence is in
  `completion-model-first-attempt-2026-10-01.json` and
  `agent-lead-model-nvidia-nemotron-3-super-120b-a12b-qualification.json`.
- An opt-in `--model MODEL` mode in the CLI integration fixture now gives the
  mostly empty source directly to the production agent. It supplies no repair,
  checks all four frozen features and requires exact-job routed verification.
  It saves failures as well as successes separately in
  `completion-model-qualification-2026-10-01.json`. This mode has not yet passed
  live qualification; it is separate from the successful deterministic fixture.
- CI includes the new end-to-end fixture and installs the migration fixtures for
  agent tests copied into their test container.

This milestone does not establish arbitrary-project completion, a repository
success percentage, every business feature, or guaranteed deployment of every
possible repository. The frozen checks define the verified scope. Model/provider
reliability on unseen repositories, richer requirement discovery, general native
workers, long jobs, stateful migration/restore and production worker qualification
remain separate work.
