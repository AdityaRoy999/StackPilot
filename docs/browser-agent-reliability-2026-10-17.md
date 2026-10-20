# Browser agent reliability and performance — 17 October 2026

StackPilot's actual planner/executor has now produced verified outcomes for all
six fixed public workflows below. These results combine the six-case run and
targeted retests after fixes; they are **not one clean six-case run on the final
revision**, a universal website success rate, or proof of parity with CUA.

The updated AI service is built and running locally. AI service, backend and
frontend all report healthy. No local decision model has been trained or enabled.

## What failed and what changed

| Root cause | Implemented correction |
| --- | --- |
| A native select was treated as a text field; its label also included the option text. | Native control contracts expose supported operations and exact observed options. A wrong typing operation becomes `select_option` only for one unambiguous enabled observed choice. Shared accessible naming resolves actual labels. The executor checks selection readback, controlled-component reverts, overlays and replacement controls. |
| TodoMVC's transparent native checkbox was rejected as invisible. | Styled native checkboxes/radios use their actual hit surface or a visible associated label, preserving native checked state. Hidden, disabled, covered and inert controls remain blocked. |
| A successful password fill was classified as focus/no effect, stopping a legitimate login batch. | Private equality is checked inside the browser and emitted as a Boolean checkpoint. The model receives no password readback, length or hash. Actual login still needs a separate outcome. |
| Quantity labels, headings and paragraphs were not consistently available as assertable targets. Inline links/code fragmented article evidence. | Query-based read-only text evidence exposes real DOM references for safe visible text and semantic blocks. Assertions retain exact/contains/case semantics. These references cannot become clickable control candidates. |
| The model guessed assertion targets, then spent repeated waits checking the same wrong element. | Failed text assertions return bounded fresh candidate evidence without changing the requested expectation or promoting a failure. Repeating the same failed text probe does not incur another full wait. Native input label assertions explicitly use accessible names. |
| Outcome protection treated later search-result captions as unchanged starting-page controls. | Baseline captions retain their observation URL. Destination headings/paragraphs can prove a navigation outcome; unchanged launch buttons and unknown aliases still cannot. |
| Correct final standalone assertions did not terminate as verified, prompting unnecessary planner turns. | An explicit terminal outcome assertion can complete a targeted task after all checks pass. A final assertion marker inside a batch is normalized without overriding an explicit outer marker. Dispatch acknowledgement alone never completes a task. |
| The AJAX trigger could be replayed while its first response was pending. | Explicit, uniquely named one-click constraints are enforced at native activation enqueue, including timeout/cancellation or unknown acknowledgements. Scrolling and movement consume no activation allowance. Ordinary repeatable controls remain usable. |
| Fast targeted runs carried unnecessary planning/schema overhead. | The targeted fast prompt is approximately 5,610 characters, down from 11,845; broad audit/campaign tools are omitted only when inapplicable. An empty opening observation refreshes once. Batches remove redundant focus clicks, and durable progress retains completed checks. |

Primary implementation is in `ai-service/app/browser_driver.py`, `tools.py`,
`main.py`, and `browser_testing/{accessibility,control_contract,checkables,
text_evidence,assertions,outcomes,transactions,cardinality,planning,decisions}.py`.

The exact screenshot trace `9b5504b4-e9a9-480a-9e90-e020efa02873` was not in
the available local database. The initial native-select diagnosis is supported
by the screenshot, source review and reproduced control tests; this report does
not claim to have recovered that original run's complete history.

## Live public website results

All cases used StackPilot's real `stream_agent_reply` planner, the configured
NVIDIA API model `nvidia/nemotron-3-super-120b-a12b` in fast mode, and an isolated
Windows Edge CDP worker (`Edg/156.0.4314.30`). No per-site execution selectors or
prerecorded actions were given to the model. Read-only independent oracles ran
after the agent stopped. Only anonymous backend project-context recovery was
bypassed; these tasks did not need a saved deployment or user chat.

| Website / workflow | Latest verified outcome | Seconds | Planner seconds | Repeated-call candidates | Report |
| --- | --- | ---: | ---: | ---: | --- |
| selenium.dev — native form | Requested text and option Two submitted, checkbox unticked, confirmation received | 23.557 | 15.445 | 0 | A |
| saucedemo.com — demo shopping | Exact requested backpack in cart, quantity 1; no checkout | 24.842 | 19.130 | 0 | A |
| todomvc.com — productivity | Created task checked and visible under Completed | 80.138 | 67.061 | 0 | B |
| uitestingplayground.com — delayed AJAX | Response appeared after exactly one trigger activation | 52.142 | 41.853 | 2 | A |
| docs.python.org — documentation search | Reached dataclasses module page and verified its description | 63.724 | 47.574 | 0 | B |
| en.wikipedia.org — reference search | Ada Lovelace heading and mathematician lead text verified | 54.048 | 39.106 | 0 | C |

Each row has both `strict_success=true` and `independent_success=true`. The
independent oracles validate only these stated workflows, not every feature of
each site. TodoMVC's oracle examines tasks rendered under the Completed filter;
the accompanying action trace shows one creation, one completion toggle and a
filter change. It does not independently inspect every hidden local-storage row.

Reports, sanitized events and screenshots are retained locally under:

- **A:** `tests/artifacts/unseen-retest-2026-10-17/benchmark.json`
- **B:** `tests/artifacts/unseen-retest-text-fix-2026-10-17/benchmark.json`
- **C:** `tests/artifacts/unseen-wikipedia-guard-fix-2026-10-17/benchmark.json`

Every report records source hashes and `summary.implementation_stable=true`
during its own run. Reports B/C follow later fixes and therefore have different
source identities from A. Generated `tests/artifacts` files are ignored by Git;
the reproducible harness, regression tests and this report are repository files.

The two AJAX repeat candidates were read-only observation calls, not duplicate
trigger activations. Its trace also contains repaired intermediate verification
errors and separate checkpoint/final checks. The successful retests still have
some failed intermediate assertions. These results do **not** establish zero
redundant checks, instant testing, or a failure-free model.

## Failures and checker correction retained

The first complete six-case run A had only **3 strict passes out of 6** and
4 independent browser-outcome passes. TodoMVC hit a provider timeout after task
creation. Python documentation reached the correct page but failed strict
completion; Wikipedia reached its article but failed assertion recovery and the
deadline. Those failures remain in A; passing retests do not replace them.

Report B contains two completed scenarios. Its process was stopped after those
completed results, while the next Wikipedia case was beginning, to address the
newly identified outcome-guard issue. It is not a full-suite result.

Wikipedia's original independent oracle also had a bug: the first
`.mw-parser-output` was an empty element preceding the article. The corrected
oracle reads the first three nonempty article paragraphs. This is a checker
correction, not an altered user goal. The manifest changed from
`618d418f3da6094f01fac51307b3d4cad736c162d25b6b0839e13b4167a135b4`
to `d07fe578302b8a17cd95921b378c77554c8cb03aef27f13a1d14b7192ae6673b`.
The corrected-oracle but still unverified run is preserved at
`tests/artifacts/unseen-wikipedia-corrected-2026-10-17/benchmark.json`.
Its browser outcome passed; its final verification did not. Report C verifies
the subsequent guard fix. Earlier diagnostic failures remain under
`tests/artifacts/unseen-baseline/` and `unseen-retest-references/`.

## Regression checks and local deployment

- Latest full Docker Python browser suite: **544 collected, 406 executed passed,
  138 skipped**. Skips include opt-in browser/live-environment cases; they are
  not additional passes. The first copied-suite invocation lacked its sibling
  `init_browser_state.py`; copying that existing initializer to the expected
  temporary path fixed the test harness, and the complete rerun passed.
- Latest host text-evidence suite with the local Chromium fixture enabled:
  **14 passed**, including real DOM observation/assertion checks, private-content
  exclusion, native accessible names, stale references and zero input dispatch.
- Independent benchmark/oracle/metric tests: **9 passed**.
- Earlier actual Chromium native-select/password/control tests and six styled
  checkbox/radio tests also passed; they are separate opt-in fixture evidence,
  not part of the 406 executed Docker tests.
- Task-scoped `git diff --check` passed. AI image rebuilt, AI service recreated,
  and AI/backend/frontend report healthy. Task-owned fixture browsers were closed.

The live public workflows certify the Windows Edge execution path. The Docker
suite checks the container application regressions; it is not a second live
six-site qualification through the Linux browser image. Existing user changes
outside this browser task were preserved.

## Decision model and remaining limits

A CPU policy for routine grounded browser decisions is feasible. The optional
typed-decision adapter now includes bounded redacted context, duplicate-choice
abstention, confidence/staleness gates and timing of failed calls/fallbacks. It
does not have a configured local model, and this work does not claim to train one.

Use a compact candidate ranker with an explicit ABSTAIN choice, then preserve
the existing executor and outcome checks. Train from licensed trajectories and
authorized redacted StackPilot demonstrations; validate on entirely held-out
sites. The durable RunJournal stores recovery hashes/timings rather than a
training-ready observation/action corpus. A separate opt-in collector is needed.

See [the CPU decision-model training guide](browser-decision-model-training.md)
for architecture, model options, source licenses, data format and rollout steps.
The [qualification guide](browser-unseen-qualification.md) explains reproduction.

Remaining limits include variable external-provider latency/timeouts, occasional
model assertion mistakes, visual-only controls and site/authentication-specific
requirements. Six workflows are useful regression evidence, not a guarantee
that any unseen website or all CUA operations will succeed.
