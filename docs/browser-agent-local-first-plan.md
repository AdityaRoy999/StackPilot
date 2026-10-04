# StackPilot browser agent: local-first implementation direction

Updated September 27, 2026 following the user's sequencing clarification. This is the immediate implementation plan; `browser-testing-production-plan.md` remains the later sandbox and production roadmap.

### Implementation progress: first local slice

Implemented in the existing runtime: browser timezone propagation; an anchored task/date context retained across structured clarification answers; explicit read-only `browser_assert` expectations with bounded retries; checkpoint versus terminal-outcome distinction; negative-validation assertions; bounded batches that stop on failed/unverified assertion steps; fresh `browser_observe` images on configured vision lanes; and date-control fill/readback. Coordinate clicks collect their own effect snapshot.

The default browser loop now uses one observed-state planner for workflows and audits. The travel/form heuristic burst and fixed fallback crawler have been removed from `main.py`; broad audits no longer switch to a second hardcoded execution engine. English button-name ranking, inferred next-submit hints, blanket modal acceptance and fill-every-form prompts have been removed. The implicit `browser_fill_form` tool is retired; use explicit observed targets in bounded batches. The old System1 module remains for compatibility/regression tests and is not dispatched by the default planner. Explicit user URLs, including local port 3000, are honored. Observations expose pagination so controls after the first 80 can be inspected.

The suite now contains 74 regressions, including 20 live Chromium cases. New mock-provider orchestration checks cover unrelated record workflows, broad audits, non-English requests and controls, bounded outcome reminders, and the absence of unplanned form/modal actions. These verify dispatch and evidence plumbing; they do not measure a real model's generalization. Browser fixtures also cover delayed/wrong results, negative validation, exact dates/checkboxes, duplicate target rejection, invalid selectors, privacy, batch stopping and screenshots. Earlier frontend TypeScript and lint checks passed. This is a foundation for L1–L4, not completion of the roadmap. Open-ended intent normalization, independent coverage planning, calibrated model selection, durable restart recovery, local stream ownership and decoder work remain outstanding. Assertion selectors currently address the top-level document; iframe/shadow/canvas assertion adapters are not claimed.

## 1. The intended product

The user supplies a website and a natural-language request. The agent understands the request, inspects the current website, chooses the right controls, completes the workflow, checks the actual outcome, and shows its real browser actions live. It must work beyond hardcoded travel forms or one demonstration website.

### Generality requirement

Do not add runtime website lists, known-domain flows, invented credentials, fixed button names or selectors copied from a demonstration. Discover controls, required inputs, navigation and state transitions from the requested application's observations. Generic control semantics such as checkbox state and native date values are browser primitives, not website recipes. User-supplied expectations and explicit fixture data belong in task contracts and tests.

"Any website" is the product direction, not a guarantee that every test passes. A broken application must fail its relevant checks. A blocked page, missing credential, unsupported control surface or unavailable oracle must be reported as blocked/unverified. Passing one assertion cannot certify an entire website. Expected rejection can pass a negative test because the observed rejection matches its declared expectation.

Before qualifying generality, evaluate held-out applications with unfamiliar routes, renamed controls, randomized DOM identifiers, multiple languages, dynamic rendering and deliberately broken variants. Keep their expected outcomes independent of the planner. Record exact task success and false passes, plus retries and p50/p95 latency. No workflow-specific runtime patches should be necessary to pass a held-out application. This qualification and the 60 FPS viewer work remain planned, not proven by the current regression count.

Two first-class modes share one browser execution loop:

| Mode | Example | Completion criterion |
| --- | --- | --- |
| Do a requested task | Search tickets for a specified route tomorrow | Exact route/date and selected search criteria are established; matching results or an explicit no-results state are observed |
| Test a requested workflow or website | Test this URL; test checkout validation | A discovered/requested coverage matrix is executed and every required assertion has an evidence-backed result |

An agent that types values and clicks Search has performed actions. An agent that checks the correct route/date/results has completed the task. An agent that tests valid and invalid workflows against declared expectations has tested the application. Keep those distinctions in the API and report.

The browser, planner and viewer improve locally first. New OS sandboxes, Firecracker, VM pools, Kubernetes, a broker fleet and a media gateway are deferred. Preserve interfaces so those can be attached later without rewriting intent or test verification.

## 2. What stays and what changes now

Keep the existing Docker/local Chromium/CDP setup, Python AI service, C++ API/proxy, frontend viewer, provider settings and previous regression fixes. Do not rewrite the platform or add a second database to begin improving the agent.

Refactor incrementally into small modules behind the current request/tool interfaces:

- `app/browser_testing/intent.py`: normalized task type, entities, date/timezone, scope, ambiguity and expected completion.
- `app/browser_testing/observations.py`: compact semantic state, page identity/version and selected fresh screenshot observations.
- `app/browser_testing/coordinator.py`: one task/plan/execute/verify/recover state machine.
- `app/browser_testing/assertions.py`: retrying explicit expected outcomes and negative-test semantics.
- `app/browser_testing/coverage.py`: website capability inventory, deduplicated workflow coverage and budget.
- `app/browser_testing/evidence.py`: step events, assertion results, timing and report provenance.

These are proposed paths. Keep `main.py` as the transport/API adapter rather than moving unrelated repair, deployment or chat work into this browser refactor.

Use the existing CDP driver through an executor interface initially. Evaluate Playwright on the same local scenarios after contracts and behavior are measured; migrate driver functionality selectively if it improves reliability and maintenance. New VM provisioning is not required for that experiment.

Because the current desktop stream is global, permit only one actively controlled/visually observed local run at a time until capture isolation is solved. Queue additional runs with visible status; do not display one tab while an agent operates another. This is a temporary local scheduling constraint, not production tenant isolation. Basic session ownership and authenticated viewing/control still belong in the local fixes.

## 3. Understand intent before touching the page

Normalize the goal into:

`task kind + target URL + entities + resolved date/timezone + constraints + expected outcomes + missing/ambiguous inputs`.

Use model reasoning for open-ended intent and page semantics. Use deterministic helpers for validated dates, formats and entity matching. The current regex extractor must not be the authority on every natural-language task, and constant confidence values must not decide that an ambiguous task is safe to execute.

Relative dates use the user's supplied runtime timezone and a captured reference time. Thread that context into both planner prompts and deterministic helpers; the server/container date must not silently determine “tomorrow.” Preserve the resolved absolute date through follow-ups, navigation and replanning, unless the user changes it. Test midnight, month/year boundaries and misspellings such as “tommorow.”

Resolve city names, airport/station codes and autocomplete choices against observed options or a documented entity source. Do not equate the typed query with a committed selection. Where origin and destination resolve to the same location or a supplied abbreviation is uncertain, ask one focused clarification instead of inventing a different destination. For the user's illustrative “mum to bom” request, this ambiguity matters: Mumbai airport's code is BOM, so interpreting “mum” as Mumbai could produce a same-location route. [Official airport reference](https://csmia-mumbai.adaniairports.com/About-Us).

Remember resolved task state across tool calls and replies. A short answer to an agent question updates the relevant entity in the original task; it must not become a new unrelated task. Ask only when missing information changes what correct completion means. Do not pause for every suggestion when one exact, unambiguous match exists.

## 4. One control loop

`understand → observe → plan a short sequence → execute → check expected state → continue or recover → verify final outcome`.

The planner and website discovery logic feed the same state. They must not independently navigate, declare completion or repeat the same work. A local optimization may execute already planned steps; it must not introduce another workflow recipe or completion oracle. Replace heuristic “URL contains search, therefore goal achieved” checks with task-specific postconditions.

Each step records its precondition, target, expected effect/outcome, observation version, execution result, timing and evidence. Reject stale target references, refresh after navigation or DOM replacement, and stop a batch when assumptions fail.

Use DOM/accessibility information for exact targeting, with current screenshot interpretation for canvas, unclear layout or visually meaningful states. Send selected screenshot images as actual provider image observations, not base64 text or a viewer-only stream. Verify provider capabilities and context limits before enabling that lane. Do not silently switch an explicitly selected provider/model.

Compile familiar actions into short bounded local sequences. Continue locally when the expected state is established; replan when the state is unexpected or ambiguous. Never make a model round trip merely to confirm an already verified ordinary field fill. Never continue a blind batch because it is faster.

Recovery distinguishes stale target, ambiguous target, validation, loading, navigation, backend error, provider failure and unsupported interaction. Use bounded retries and fresh observations. Do not repeat a submission with an unknown side effect until its outcome has been reconciled.

## 5. Concrete first workflow: ticket search

Use a controlled local fixture first, with realistically delayed autocomplete, calendar navigation, disabled controls and delayed results. Then evaluate permitted real public searches separately; fixture success is not proof of third-party-site generalization.

1. Parse the route, travel mode, date and constraints; resolve necessary ambiguity.
2. Inspect the supplied website and choose the relevant search tab/form from its semantics.
3. Fill origin and destination; select the correct suggestions; read back the committed selections.
4. Set and read back the exact absolute date, including the correct month/year.
5. Check additional user constraints or visibly state defaults where relevant.
6. Submit once; wait for matching results, explicit no-results or a real error condition.
7. Verify route/date/filter identity in the result state, not merely that the URL changed.
8. Summarize the observed results and evidence. A search request stops at search results; it does not authorize completing a purchase.

Acceptance variants: reversed suggestions; duplicate city names; wrong initial airport; same-location route; date boundary; no-results; validation rejection; slow success; API failure; popup; changed element IDs; refresh; and a short user clarification that preserves earlier context.

Do not hardcode one vendor's selectors as the universal solution. Keep fixture-specific expected outcomes in the independent grader; let the agent discover controls through the same observation interface used on other websites.

## 6. Website testing that understands the application

For “test this website,” first inspect routes, navigation, forms, user roles, important domain entities and visible workflows. Produce a compact coverage plan before interacting broadly. A store suggests product/search/cart flows; a project tool suggests create/edit/filter/member flows. These are hypotheses to confirm from the supplied app, not fixed labels that decide correctness.

Execute meaningful cases within scope: happy paths, invalid inputs, required fields, state transitions, persistence, error handling, role restrictions where accounts exist, uploads/downloads, responsive behavior and relevant visual/accessibility checks. Deduplicate repeated navigation and shared components. Do not substitute clicking every link for understanding the product.

When requirements or test credentials are unavailable, explicitly mark expected business rules or authenticated coverage unresolved. For a supplied specific case, focus on that case rather than launching a full crawler. For a general audit, discovery feeds the coordinator and coverage matrix; it is not a second independent controller.

Every case has expected conditions and pass/fail/unverified/blocked/skipped outcomes. Expected invalid-input rejection can pass a negative test. A DOM mutation, focus change or completed HTTP dispatch cannot establish business correctness. Read back state, reload where persistence matters, and use configured test APIs for independent persistence checks when available.

Use disposable fixture data for local mutating tests. On a real website, stay within the requested workflow and supplied test scope; unavailable permissions or data become explicit coverage gaps. The report must list tested workflows, failed assertions, evidence, blocked cases and untested areas. It must not claim that all possible behavior was tested.

## 7. Visible, truthful, responsive actions

Keep the current live viewer and native input events. Align input targets with the displayed page. Show cursor movement/click markers and field interaction events using actual action coordinates/timestamps, including failed or interrupted steps. Preserve password masking.

Fix the existing pipeline before introducing a new media stack: bounded queues, keyframe-safe recovery, decoder queue limits, accurate painted-frame counts and recording coverage. Reduce React state updates for high-frequency cursor events through refs/animation-frame rendering where appropriate. Test under concurrent chat rendering and client CPU/network throttling.

Animate the viewer independently when useful, but do not delay every browser action to create a theatrical mouse path. Event highlights should preserve what happened and in which order. Never manufacture 60 FPS or show the wrong tab. A slow provider response and a smooth video stream are separate measurements.

Stop must interrupt waiting provider/action work. Takeover pauses agent dispatch and grants exclusive input; returning control triggers a fresh observation and plan. No simultaneous human/agent filling of the same form.

## 8. Ordered local milestones

| Milestone | Changes to the existing architecture | Exit evidence |
| --- | --- | --- |
| L0: local baseline | Freeze model/provider/config; add phase timing and 20 representative fixture tasks | Separate model, observation, action, assertion and video timings; independent outcomes saved |
| L1: intent and context | Typed task state; user timezone/date handling; ambiguity; follow-up merging; separate do-task/test modes | Route/date/context variants pass; no invented inputs or lost task state |
| L2: perception and execution | Semantic targeting; current screenshots at decision points; stale-target handling; readback and short batches | Ordinary forms, delayed autocomplete, popup/iframe and coordinate fixtures work without duplicated actions |
| L3: verification | Explicit retrying assertions, expected rejection, final result identity and persistence | Incidental mutation cannot pass; delayed success is recognized; wrong result state fails |
| L4: general website coverage | Capability discovery and bounded workflow coverage in the same coordinator | Several unrelated fixture apps are understood and tested with truthful coverage reports |
| L5: local performance/viewer | Remove redundant extraction and unjustified sleeps; local sequences; bounded media/decoder; real cursor events; stop/takeover | Lower end-to-end latency at unchanged correctness; truthful smooth viewing and exclusive input |
| L6: local qualification | Held-out tasks, repeated runs, provider comparison, real-site read-only checks and failure cases | Accuracy/reliability/speed results justify progression to the existing production sandbox plan |

L1–L3 are the first functional slice. L5 transport fixes can proceed alongside that work without replacing the browser runtime. Do not start infrastructure-heavy VM/media development as a prerequisite.

## 9. Evaluation and evidence

Retain the existing 33 regressions and nine live Chromium cases. Add workflow-level fixtures rather than tests that simply mirror new implementation code. Grow from 20 development tasks to a held-out multi-app suite; include travel, commerce, CRM/project forms, account/permission and data-table workflows.

Measure exact task success, false passes, wrong-target actions, recovery, repeated submissions, model calls, p50/p95 task latency and cost. Compare the frozen current local implementation against each milestone on the same starting state and independent expected outcomes. Separate new tasks from repeated workflows; report retries and failures instead of excluding them from timing.

For viewing, measure actual presented frames, freezes, decoded drops, queue delay, and click-to-visible-response on a controlled fixture. Test slow clients and simultaneous SSE/chat updates. Producer packet rate alone is not the FPS score.

Use a strong evaluated model for unfamiliar reasoning; enable cheaper/faster lanes only when outcomes support them. A heuristic helper cannot compensate for missing visual observations or weak reasoning across arbitrary websites. Claude/Codex-like behavior is a quality target; parity or a 5–10× speed claim needs comparable tasks and measured outcomes.

Local qualification requires: no false passes on deliberate broken variants; original intent retained through recovery/follow-ups; correct delayed and negative outcomes; no duplicate mutating actions; functional stop/takeover; truthful video; and held-out workflow success that improves without latency optimizations reducing accuracy. Universal/flawless performance remains an ambition, not a release assertion.

## 10. Transition to the later sandbox plan

Once local behavior meets those gates, attach the same executor/coordinator contracts to a sandbox provider. Move browser/display/profile state into per-run OS environments; add fleet scheduling, production network isolation, image lifecycle, artifact policy and qualified media infrastructure from the existing plan.

The local work is therefore reusable: understanding, observation, action, assertion, evidence, recovery and replay stay the same. The environment adapter changes. The immediate priority is a capable, fast and truthful browser agent on the system that already runs.
