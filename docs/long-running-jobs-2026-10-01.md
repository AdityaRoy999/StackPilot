Finite Linux jobs now have an asynchronous process lifecycle. A fixed repository command starts once per deployment container; opening its console does not restart it. Jobs can declare `job_timeout_seconds` from 1 to 86400 (24 hours), with a one-hour default. Docker/EC2 capacity provisioning is independent of this execution contract.

`/healthz` reports adapter liveness with HTTP 200 while the job runs, and its JSON `ready` flag becomes true only after successful completion. `/job/status` returns the real process state, output, exit code, start/finish/deadline timestamps, timeout flag, command digest and a fresh execution UUID. The adapter retains up to 128 KiB of output, marking older discarded output explicitly.

The AI runtime verifier observes this state promptly. Running returns `status: running`, `pending: true`, `verified: false`. A verified job requires exit zero, completed output collection, a finish inside its deadline and any declared outcome checks. Timeout, cancellation, nonzero exit, contradictory evidence or a different execution UUID cannot produce success. A final UUID observation also catches restarts during outcome checks. Parent exit cannot leave a child holding stdout indefinitely; the deadline bounds collection and kills the process group. Server shutdown kills outstanding command groups.

The durable backend release broker must persist the original execution UUID and accepted deadline while awaiting completion, and pass `job_execution_id` on subsequent verification requests. It must observe the same candidate rather than rebuild/replay the command. A backend restart can resume observation of the surviving Docker candidate. A deployment-container restart creates a new execution and cannot satisfy the old release. This is restart detection, not resumable application computation or exactly-once external side effects.

Validation added:

- Eight AI evidence/request tests cover pending observations, true completion, restart rejection, deadlines, terminal failures, malformed evidence and required outcome assertions.
- Actual Linux process tests cover progress followed by completion, cancellation, timeout, descendants holding stdout, early crashes, interactive CLI behavior, and opening a job without replay.
- `tests/integration/long_job_smoke.py` executes a 46-second Docker job beyond the previous 45-second ceiling, verifies its declared output, then rejects a Docker restart against the original execution UUID. This fixture creates no user or project. Run after activating the updated AI service; it qualifies the adapter/verifier, not the backend durable release phase.

The supported execution deadline is bounded at 24 hours; jobs requiring hardware, external credentials, checkpoints or greater duration still need an appropriate declared executor and resource policy. A successful process exit plus declared assertions does not prove undeclared business behavior.
