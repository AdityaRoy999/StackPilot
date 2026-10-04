# Browser coverage and step approvals

## Observed issue

The broad website-testing path stopped its planner immediately after the route
audit. The audit intentionally recorded navigation/hover mechanics and left
forms and unknown controls for explicit scenarios, so stopping there prevented
those scenarios from running. The latest real report visited six pages but
still listed unsent contact fields and several ordinary controls as untested.

## Changes

- Route discovery now returns fresh page controls and the planner continues with
  positive/negative scenarios and explicit outcome assertions.
- Recognizable local UI controls (theme, navigation menus, tabs and similar
  controls) can run in the conservative audit; arbitrary effects remain gated.
- `browser_assert` supports `kind=validity` with an expected boolean. This reads
  native validity without dispatching submit/invalid events or sending data.
- Consequential browser inputs require an owner/chat/exact-step signed approval.
  Its private binding includes current page/control identity and hashed form
  context. Raw credential values are excluded from the approval preview and
  durable evidence journal.
- A batch with consequential inputs executes its reversible prefix, then pauses
  at each consequential step. Approval executes only the privately held step
  once, advances its safe suffix, and requests the next approval before another
  provider request. Earlier steps are never automatically replayed.
- Changed page/control/form context, expired/consumed tokens and wrong owners
  invalidate approval. Stop and a replacement task invalidate the pending step.
  A service restart invalidates private pending steps rather than recovering
  uncertain submissions automatically.
- Browser provider silence has a separate bounded 120-second default; deep
  audits have separate 360-action/600-second defaults. Cancellation is preserved.
- Broad reports come from the recorded evidence ledger exactly once, without a
  second paid model synthesis request or a whole-site pass claim.
- A disconnected browser record no longer crashes a newly connecting viewer;
  the socket can process attach and recreate its owned tab.

## Verification

Focused suite: 68 tests, 64 executed successfully and four opt-in live tests
skipped. Those four Chromium audit fixtures were also run separately and passed:
route queue, section/hover/theme behavior, bounded page coverage, stale control
IDs, and positive/negative email validity without POST/delete. Approval fixtures
cover safe-prefix execution, sequential approvals, no prefix replay, stale page
rejection, owner/session stop isolation, unknown gestures/shortcuts and redacted
credential previews. Three report/approval cases were rerun after the final
single-report change and passed. Fifteen relevant Python modules compiled using
a nonwriting syntax check; Git whitespace checks passed.

These are fixture and execution-contract checks, not proof that the selected
external model correctly plans every application. Native validity does not
establish server validation or business behavior. CAPTCHA, credentials, external
origin transitions, canvas-only interfaces and unknown expectations can remain
blocked or unverified. The selected Nemotron lane uses DOM/tool observations;
visual coverage requires an explicitly supported vision model. This change does
not claim exhaustive coverage or parity with ChatGPT computer use.

## Selected-model qualification and remaining workflow gap

An owned, disposable three-page fixture was tested using the actual selected
`nvidia/nemotron-3-super-120b-a12b` provider lane. No model fallback, user chat
mutation, real submission or external-site action was used. The 300-second
qualification separates nested deterministic route checks from model-planned
assertions and requires a specifically observed Send approval before declaring
the full qualification successful.

The first run discovered all three pages but produced no scenario assertions
and paused against the focused document body. Approval preflight now resolves
unique observed labels to exact references, rejects missing or ambiguous click
targets, and never treats a missing selector argument as a focused-body action.
Batch schemas and preflight now agree about supported actions, reject unknown
fields/actions before dispatch, and preserve read-only theme observations.
Forty focused checks passed, followed by eleven updated schema/live checks,
covering 46 distinct checks including five actual Chromium fixture cases.

The retake took 130.48 seconds. All planner turns remained on the selected
Nemotron model. It visited 3/3 discovered pages and passed ten model-planned
expectations, including both invalid and valid native-email states. The report
contained thirteen passed expectations including deterministic route checks.
The journal had no pending dispatch and the fixture received only GET requests.
The model never proposed the requested exact Send approval, so the strict
qualification failed and the final browser run remained `unverified`. The safe
evidence summary is saved in
`tests/artifacts/browser-depth-selected-nemotron-2026-10-02.json`.

This is an observable planning gap: the harness still relies on a model tool
call to create the Send permission ticket. A discovered review obligation and
two continuation reminders do not compel that call. The prior reminder also
incorrectly claimed no expectation had passed, while the discovery ledger
continued to describe the email scenarios as untested. Native validation
evidence now updates that ledger without claiming server validation, and
continuation messages name completed expectations and remaining obligations.
They explain that proposing the exact permission step pauses before input;
no submission is executed by requesting approval.

A narrowly scoped deterministic workflow-obligation controller now records
finite remaining reviews with the original goal's hash. If a no-tool planner
finish leaves a specifically requested consequential workflow, it refreshes the
page, requires a unique matching current control and its context, and prepares
the normal target-bound permission card with paired tool-call/result IDs. This
path dispatches no input. For a form, current native validity and recorded
positive/negative input checks are prerequisites. Generic deep testing cannot
select an arbitrary critical button. Stale/ambiguous targets, unknown effects,
unmet prerequisites and unrelated critical controls remain precise incomplete
reviews. Budget/stop rules take precedence. Goal replacement resets the
obligations; approval follow-ups retain the original goal, and an executed step
is never automatically proposed again. Final reports expose remaining reviews
instead of declaring whole-site completion.

Fifty-five distinct deterministic permission, obligation, coverage, batch and
agent-stream tests passed after this controller change. The owned live Chromium
controller case also passed in 8.823 seconds: it recorded invalid and valid
native-email checks, prepared a fresh exact Send target, and sent no POST or
delete request. This is one additional live fixture test, separate from the five
earlier live cases and the external-model qualification.

The actual selected Nemotron retake then met the bounded fixture contract in
60.11 seconds. It discovered 3/3 same-origin pages and planned two passed native
validity assertions, one invalid and one valid. All six planner turns used
`nvidia/nemotron-3-super-120b-a12b` through NVIDIA NIM, without fallback. When the
model finished without proposing Send, the controller refreshed the observed
target and emitted its exact permission card. The run paused as
`waiting_for_permission`, retained `verified=false`, recorded no pending
dispatch, and the fixture received only GET requests. The Send proposal's source
is explicitly `workflow_controller`, not the model. Sanitized full evidence is
saved in `tests/artifacts/browser-depth-controller-nemotron-2026-10-02.json`.

The model first tried an obsolete element reference and later an invalid batch
assertion schema. Both failed before the invalid input dispatched; it recovered
the current page and completed the two native checks. Reading the current theme
returned `light` as an observation, not a verified theme outcome. Native form
checks and permission preparation do not establish successful submission,
business/server validation, account deletion, external-origin behavior, or
visual correctness. Those workflows remain precise unverified reviews. The
preserved 130.48-second result predates this controller and remains a failed
strict qualification; it is not relabelled as successful.

The final focused repeat passed all 55 tests in 14.225 seconds. Thirty-eight
relevant Python modules passed a nonwriting syntax check, and targeted Git
whitespace checks passed with Windows CRLF recognized correctly. The evidence
file clarifies that nested tool-step assertion events can duplicate the two
model-planned validity checks; they are counted once.
