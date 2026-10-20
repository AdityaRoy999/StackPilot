# Public website qualification

Latest results and their limits are recorded in
[the 17 October reliability report](browser-agent-reliability-2026-10-17.md).
All six fixed workflows have verified passes across the six-case run and
targeted retests. This is not a single clean six-case run on the final revision.

`tests/integration/browser_unseen_benchmark.py` runs six narrow workflows through
StackPilot's actual AI planner, browser tools, operation recovery and Chromium.
It does not give the model per-site selectors or replay prerecorded actions. The
only bypass is backend project-context recovery: these are anonymous, owned
browser contexts without a deployment or saved chat. Read-only post-run oracles
independently check what the browser actually reached.

| Task | Site | Independent success condition |
| --- | --- | --- |
| Native inputs | Selenium's public form fixture | Submitted text and native option Two, unchecked checkbox, received confirmation |
| Demo shopping | SauceDemo | Exactly one Sauce Labs Backpack in cart, quantity 1; no checkout |
| Productivity | TodoMVC React | Newly created task checked and visible under Completed |
| Async interface | UI Testing Playground | Delayed AJAX result actually appears after one trigger |
| Documentation search | Python documentation | Search leads to the dataclasses module page and description |
| Reference search | Wikipedia | Ada Lovelace article with the requested heading and lead topic |

These are six unrelated domains, not a claim that the base model has never seen
the sites during training. “Unseen” means no application-specific adapters were
written for execution. The fixed task manifest must stay unchanged between a
baseline and retest. Record public-site changes or infrastructure blocks rather
than silently replacing a difficult task.

Oracle correction on 2026-10-17: Wikipedia's document contains an empty
`.mw-parser-output` before the actual article. The original oracle selected that
empty node and incorrectly reported that the visible Ada Lovelace article lacked
the word mathematician. The corrected oracle reads the first three nonempty
article paragraphs under `#mw-content-text`. Task goals and all other oracles
remain unchanged. Original reports are preserved; the new manifest hash records
this checker correction. Agent assertion failures in the original run remain
failures even though this independent checker also had a bug.

## Running

Use the AI service runtime, where dependencies, browser worker and provider are
already configured. The harness does not print provider credentials. It requires
an explicit live flag because it makes real, billable provider calls.

```sh
PYTHONPATH=/app python /tmp/browser_unseen_benchmark.py --list
PYTHONPATH=/app python /tmp/browser_unseen_benchmark.py --run-live \
  --model nvidia/nemotron-3-super-120b-a12b \
  --deadline 180 --screenshots --output /tmp/stackpilot-unseen/benchmark.json
```

Use `--only selenium_form` for a single regression. Keep runs sequential so local
worker contention does not distort the comparison. The script closes each owned
browser in `finally`, including deadline and provider failures. It never closes
existing user sessions or writes a user chat. Screenshots are optional; generated
reports belong in `tests/artifacts/` after copying them out of the container.
Sanitized per-task `.events.jsonl` files are flushed as decisions arrive, allowing
diagnosis of partial failures without driving or interfering with the agent tab.
Fresh reports also record the fixed manifest's SHA-256 and hashes of the loaded
planner/executor source files. This identifies which implementation ran without
printing credentials or provider configuration. Use a new output directory for
each baseline/retest so partial events and screenshots are preserved.
`summary.implementation_stable` flags source files edited during a running suite;
use an unchanged implementation for the final comparison.

If Docker cannot start, the Windows qualification wrapper uses an installed Edge
as an isolated headless CDP worker. It still invokes `stream_agent_reply`, the
configured real provider, and the same planner/executor. It creates a fresh browser
profile and checkpoint journal and closes only its own process tree. Reports mark
the worker as Windows Edge, so this does not certify the container's networking,
packaging or browser image.

```powershell
.codex_ai_venv/Scripts/python.exe tests/integration/browser_unseen_host.py `
  --run-live --model nvidia/nemotron-3-super-120b-a12b `
  --deadline 180 --screenshots `
  --output tests/artifacts/unseen-retest/benchmark.json
```

The wrapper reads only provider-related values from the workspace `.env` into its
own process and never prints them. It does not use a normal Edge profile, change
saved StackPilot connections, or mock the model or browser actions.

## Initial failures preserved

The first live-provider runs are retained in `tests/artifacts/unseen-baseline/`.
The file named `initial-six.json` contains only the first two completed scenarios;
it is not a completed six-site result. TodoMVC was recorded separately.

| Scenario | Browser outcome | Agent completion | Seconds | Calls | Diagnosis |
| --- | --- | --- | ---: | ---: | --- |
| Selenium form | Passed independent oracle | Unverified | 41.8 | 4 | Requested controls and submission worked, but a standalone final assertion did not terminate the task as verified. |
| SauceDemo cart | Passed independent oracle | Unverified | 164.4 | 16 | Exact quantity assertion was evaluated against an unrelated control, causing repeated failed verification despite the correct cart. |
| TodoMVC | Failed independent oracle | Deadline exceeded | 180.0 | 39 | Transparent styled checkbox was rejected as invisible; retries then encountered stale control references. |

There were no false verified completions in these three runs. Correct browser
state with an unverified terminal status is still a failed strict qualification.
These are diagnostic baselines rather than estimates of general browser-agent
success rates.

## Reading results

- `independent_success`: the read-only oracle passed, regardless of model claims.
- `agent_claimed_verified`: the agent's terminal event claims completion.
- `strict_success`: both agree and the stream had no error.
- `false_completion`: the agent claimed verified while the oracle failed.
- `agent_elapsed_seconds` excludes post-run oracle/screenshot overhead.
- `planner_seconds` and `planner_median_ms` separate provider decisions from
  browser/server waits; the AJAX demo deliberately adds a slow server response.
  These sum completed timing events. A provider call that times out without a
  timing event is reflected in total elapsed time, so zero recorded planner
  seconds must not be interpreted as zero provider latency.
- `same_state_repeat_candidates` requires identical tool arguments and identical
  cached observed state. It is a diagnostic candidate count, not automatically a
  bug. A checkpoint and final outcome check have different purposes and are not
  collapsed. The benchmark adds no CDP reads to the measured decision loop.
- `page_diagnostic` and errors help distinguish a site/network/CDN challenge from
  a wrong agent action. A task blocked before its UI loads remains unverified;
  do not call it a workflow pass or count it as a successful agent interaction.

`tests/unit/test_browser_unseen_benchmark.py` validates independent oracles and
metric accounting without browser access, provider calls, or network traffic.
Run it with `python -m unittest discover -s tests/unit -p test_browser_unseen_benchmark.py -v`.
This qualification measures six specific workflows; broad audits, visual-only
controls, cross-frame transactions and production account flows need their own
holdout cases. Passing six is useful regression evidence, not universal CUA
parity.
