# StackPilot browser agent: local-first reliability and speed plan

**Status:** phased implementation in progress, October 9, 2026. Local fixtures and an isolated Goibibo station-picker smoke test pass, but the full Goibibo task and held-out multi-site evaluation have not been rerun. Arbitrary websites are not yet qualified.

Current implementation adds a same-page semantic rebind for unique replaced controls, bounded enablement waits, independent dispatch/verification states in browser run events, durable outcome accounting, condition-aware batches, and an opt-in image observer for text-only planners. `Autonomous (Never ask)` no longer silently selects the first answer to a missing-information question. The image observer requires `STACKPILOT_BROWSER_VISION_FALLBACK_MODEL` or runtime `browser_vision_fallback_model` on a compatible image-capable endpoint; without it, sparse visual interfaces remain a limitation. The observer describes screenshots but cannot directly authorize a coordinate click.

The current regression set includes 354 browser unit tests on the service container (93 opt-in/skipped) and 55 live Chromium fixture tests. Aggregate existing SSE/JSONL run events with `python scripts/browser_eval.py path/to/events.jsonl` from `ai-service`; this reports planner/tool and click-phase p50/p95, dispatch states, and false completion signals without printing task data. These checks do not satisfy the release gate for 100 held-out site workflows or the target of 70% fewer planner calls. Those metrics need a new controlled run against the baseline.

The goal is a framework-independent agent that completes a user's browser task from observed evidence, acts quickly when the next step is clear, and accurately reports when a result is blocked or unverified. React, Angular, Vue, server-rendered pages, and ordinary custom elements should use the same browser-level contract. No browser agent can guarantee every task on every site: missing user facts, OTP/CAPTCHA, expired authentication, inaccessible closed widgets, external-origin boundaries, and unavailable services require a handoff or a truthful blocker. The aim is broad *measured* coverage, not an unconditional success claim.

This plan is the immediate path for the current CDP-based local and remote workers. The longer-term isolated runner, broker, and media architecture is in [browser-testing-production-plan.md](browser-testing-production-plan.md); do not make that infrastructure a prerequisite for the corrections below.

## Evidence to preserve

The October 8 Goibibo run (`remote_run_id=8277a8f7-f1fe-4d72-b52f-8aea38d505d1`) recorded 13 planner turns taking 39,368 ms and 12 timed browser tool calls taking 7,704 ms. The stored assistant trace has 15 browser calls: seven failed, four unverified, one blocked, and three observations; no action passed. Click dispatches reported occlusion, a train route was rejected under a stale target origin, and an unverified scroll ended a batch. The run was stopped before a train result. The task did not provide a travel date; that is a required fact for a real availability result, but was not the immediate navigation failure.

Source changes address the stale target origin, navigation hover recovery, URL normalization, and discovery of some pointer-cursor custom controls. A later isolated Goibibo smoke test opened the train origin field, observed 13 station options in its unmarked HTML list, and committed one selection with field-display evidence after its input unmounted. The station click's measured site-settling span fell from roughly 0.8–1.2 seconds to 32–40 ms in these individual samples; total click time and network/model latency are separate. The complete Goibibo workflow has not been rerun against the updated service. Do not treat these patches as general-site validation.

The selected planner was `nvidia/nemotron-3-super-120b-a12b`. With default `browser_vision_enabled` detection, its name does not select an image input, even though a viewer may see the live browser. Benchmark structured-only and multimodal fallback paths separately.

## Execution contract

Each task must carry a versioned contract: original user goal; selected site and allowed origins; available facts and missing facts; permitted action classes; outcome criteria; time and cost budgets; and the current workflow checkpoint. A train search, for example, must distinguish an exploratory test with a labelled synthetic date from a real user availability request requiring an actual date. `Autonomous` may select a *documented safe test default* for the former; it must not silently choose the first option for the latter.

Every browser command must return separate fields for **dispatch** and **verification**:

- `not_dispatched`: target stale, ambiguous, disabled, occluded, out of scope, or unauthorized; include fresh recovery evidence.
- `dispatched_unverified`: native input was sent, but its expected effect is not established. Never blindly replay a possible submit/send/purchase.
- `checkpoint_passed`: a specified intermediate condition was observed, such as a committed station or selected date.
- `outcome_passed`: an independently specified terminal condition matching the user's request was observed.
- `blocked`: an explicit missing fact, credential, human challenge, site failure, or policy boundary prevents that part of the workflow. Continue independent in-scope work when possible.

An incidental URL change, DOM mutation, focus shift, or animation is evidence of *an effect*, not proof of the requested outcome. The batch runner should stop dependent actions on ambiguity or failed checkpoints; it should not treat every harmless `dispatched_unverified` scroll as a failed click. The completion report must be derived from expected outcomes, not the planner's prose.

## Work in dependency order

| Phase | Engineering changes | Release evidence |
| --- | --- | --- |
| 0. Trace and reproduce | Freeze the Goibibo trace, provider/browser versions, and a sanitized local fixture reproducing hover occlusion, replaced controls, direct train navigation, custom search widgets, and missing date. Add timing spans for observe, resolve, dispatch, site wait, verify, image transfer, and model inference. | Existing run metrics reproducible from saved events; fixture fails under old behavior; traces never include personal input values. |
| 1. Truthful task and action state | Define a task contract and typed result states in `browser_testing/intent.py`, `transactions.py`, `testing_runtime.py`, `tools.py`, and `main.py`. Replace autonomous first-option selection with a safe-default/blocked decision. Preserve one task across answers and approvals. Add a command ID and post-action reconciliation for uncertain submissions. | Missing travel date yields one useful question or an explicit blocker; a dispatched click is not misreported as undelivered; restart cannot duplicate a send/booking; unrelated tests continue. |
| 2. Target resolver and actionability | Represent a target by role/name/label/test ID, frame and tab identity, relevant container, and observation epoch; keep numeric node IDs only as a short-lived optimization. Re-resolve before action. Wait briefly for unique, visible, stable, enabled, event-receiving targets; re-observe once when replaced. Classify overlays and do not force-click through them. Apply in `browser_driver.py`, `actionability.py`, and frame helpers. | Dynamic rerender, sticky menu, delayed enablement, portal, open shadow root, iframe, and viewport changes work on local fixtures without wrong-target clicks; exact same-origin href fallback is verified. |
| 3. Hybrid perception and widgets | Return bounded semantic controls, active dialog/listbox/calendar, frame/tab ownership, focused control, and a screenshot reference in one observation. Trigger a real multimodal model input for sparse/ambiguous controls or visual-only interfaces; ensure coordinates are bound to screenshot dimensions, scale, scroll, and page epoch. Extend generic widget transactions for autocomplete, calendars, combo boxes, dialogs, file controls, and drag interactions. Do not add site-name branches. | A model integration test proves image bytes reached a vision-capable provider; custom Goibibo-style widgets pass independent fixture assertions; unsupported canvas or closed widgets produce an explicit limitation. |
| 4. Fast decision loop | Use deterministic execution for resolved low-risk steps and call the planner at genuine branches, unexpected state, or final interpretation. Keep short, condition-aware batches; return compact state diffs rather than repeated full DOM and prompt history. Escalate to stronger reasoning/vision only after a classified ambiguity. Do not run concurrent mutations in one tab. | On eligible frozen workflows, at least 70% fewer planner calls than the baseline without lower task success; report model and browser p50/p95 separately. This is a target, not a current result. |
| 5. Broad evaluation and rollout | Build resettable fixtures and a held-out real-site task set across UI families; replay each candidate with fixed browser/model versions, clean state, repeated seeds, and independent outcome graders. Canary the resolver and planner separately with a feature flag. | No false completion on deliberately broken fixtures; measured task success, wrong-target rate, recovery rate, model turns, cost, and p50/p95 latency improve on held-out tasks before default rollout. |

## Cross-site evaluation matrix

Start with at least 20 development scenarios and expand to at least 100 versioned scenarios before a broad production claim. Cover plain HTML, React/Angular/Vue and server-rendered pages; delayed hydration and rerenders; sticky hover menus; overlays and cookie banners; native/custom date pickers; autocomplete with duplicate city names; validation and error responses; nested frames and open shadow DOM; new tabs and allowed authentication redirects; uploads/downloads; mobile responsive layouts; canvas/visual-only controls; slow networks; provider timeouts; takeover/cancel/resume; and prompt injection in page text. Include broken application variants to detect false passes. Use independent application state or fixture APIs where available, not just the agent's own report.

Goibibo is one regression scenario, not the benchmark. Freeze a local replica because a third-party site's design, traffic controls, and data can change. Keep an optional live smoke test with no booking or personal-message submission. For the missing-date variant, verify that the agent asks or blocks accurately; for a variant with a supplied date, verify the committed stations/date and results, not simply that the search button was clicked.

## Immediate PR sequence

1. **Trace and result contract:** typed dispatch/outcome states, sanitized trace replay, and missing-fact tests. This removes misleading results before accelerating actions.
2. **Resolver and actionability:** semantic re-resolution, bounded auto-wait, overlay classification, and stale-reference tests.
3. **Visual escalation and widget flows:** actual image delivery to a vision model, coordinate binding, generic widget fixtures.
4. **Planner optimization:** condition-aware batches and compact diffs, benchmarked against the frozen trace.
5. **Release gate:** 100-scenario held-out suite, real-site smoke, canary, rollback, and published limitations.

Do not claim parity with another computer agent, 60 FPS, or “works on any website” from fixture passes. Viewer FPS is measured separately from planner and browser-task latency. First earn accurate outcomes and dependable input; then optimize inference and media.

## Basis for the design

Playwright's [locators](https://playwright.dev/docs/locators) resolve current controls on use, while its [actionability rules](https://playwright.dev/docs/actionability) wait for uniqueness, visibility, stability, event reception, and enabled state. OpenAI's [computer-use integration guidance](https://developers.openai.com/api/docs/guides/tools-computer-use) describes preserving browser state and returning fresh screenshots after short action groups. [BrowserArena](https://arxiv.org/abs/2510.02418) documents real-world agent failures around CAPTCHA, banners, and direct navigation; [BrowserGym](https://arxiv.org/abs/2412.05467) provides a basis for reproducible multi-site evaluation. These sources motivate the contracts and tests; they do not establish StackPilot's performance until the release evidence above exists.
