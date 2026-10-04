# AI agent testing audit — September 26, 2026

The largest verified problems were in browser execution and the meaning of a test result. Changing the model alone would not have fixed them.

## Execution path reviewed

`frontend/src/lib/stream-agent.ts` sends a POST SSE request through `src/controllers/AiStreamController.cpp` and `src/services/AiStreamProxy.cpp`. The proxy forwards complete frames incrementally. The AI service in `ai-service/app/main.py` runs the provider tool loop, an optional deterministic decision burst, then a separate crawler for broad audits. `tools.py` dispatches actions to `browser_driver.py`; `apv_engine.py` compares observations. `swarm.py` also reports deployment verification.

The browser sandbox uses CDP, rather than Playwright. Native input events are supported by the [CDP Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/); evaluated page observations come through the [Runtime domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/). A successfully dispatched input is distinct from an application assertion.

## Confirmed defects and fixes

| Defect | Consequence | Change |
| --- | --- | --- |
| Real option click followed by a synthetic mouse sequence | Handlers can run twice | One actionable native click; missing, disabled, or occluded targets fail |
| Value setter, appended trigger characters, then another value setter | Contradictory input events and repeated requests | Native `Input.insertText`, followed by value readback; readonly fields remain readonly |
| Every input polls for suggestions for 1.95 seconds | Email and ordinary fields incur unnecessary latency | One immediate observation for ordinary inputs; bounded retries for autocomplete controls |
| Browser tree extracted in driver, tools, and planner | Repeated CDP round trips | Reuse the action's refreshed tree and captured alerts |
| Fast decision burst starts again on every planner turn | Lost progress and repeated actions | Attempt the burst once per request; failed actions cannot satisfy progress |
| Up to 1,000 planner turns and another broad crawl | Excessive latency and token cost | 16 targeted browser turns, 4 broad-audit planner turns, 80 repair turns; cooperative browser action/time budgets |
| No-effect actions, missing results, and even report fallbacks default to passed | False confidence | Failed/unverified classification and reports that state their actual coverage |
| One connected tab aliased to other chat IDs; unrelated tabs closed | Tests interfere across chats | Own tab per chat, exact session lookup, popup cleanup limited to the originating tab |
| Provider cancellation checked only after the next token | Stop stalls with an idle provider | Poll cancellation while awaiting the next line; cancel and drain pending tasks |
| CDP timeout retains pending futures | Resource accumulation | Remove pending requests on timeout or cancellation |
| Deployment verifier uses `any()` healthy endpoint; absent probes imply healthy | Broken endpoints hidden | All provided endpoints must be healthy; absent probes produce a warning |
| `invoke_subagent` returns a canned completed message | Claims work that never ran | Return an explicit unsupported error |
| Model context loses field type/value/checked state | Poor form decisions | Preserve available compact control metadata; redact password values |
| Browser fast mode silently overrides an explicitly selected model | Selected provider/model behavior is lost | Preserve explicit model selection |

Browser reports deliberately describe observed effects rather than claiming business correctness. A changed URL, DOM, or control is useful evidence, but does not prove that the user's intended operation succeeded. Validation failures must be interpreted against explicit expectations for negative tests.

## Validation

All 33 regression tests passed locally, including nine Chromium fixture tests. Both development and production Compose files passed configuration validation using disposable CI environment values. The local AI service was restarted and its health endpoint and corrected subagent-tool response were verified through the running HTTP API.

The deterministic tests exercise evidence classification, budgets, date parsing, failed progress, cancellation, transport failure, session ownership, batch failure, and deployment verification. The opt-in Chromium tests use a disposable tab with an in-memory fixture; they never submit a real application form or call a model API.

Live cases cover single option dispatch, a checkbox, an unchanged button, validation rejection, text input, stale IDs, disabled and readonly controls, and delayed autocomplete selection. The email fixture measured approximately 2,760 ms before the input refactor and 210 ms afterwards in one pair of local runs. This is action latency, not an end-to-end provider benchmark; host load and application/network behavior change timings.

Run deterministic tests:

```powershell
$env:PYTHONPATH = "$PWD/ai-service"
python -m unittest discover -s ai-service/tests -p 'test_*.py' -v
```

Run live tests in the existing stack:

```powershell
docker compose cp ai-service/tests/. ai-service:/tmp/agent-qa-tests
docker compose exec -T -e AI_BROWSER_LIVE_TESTS=1 ai-service python -m unittest discover -s /tmp/agent-qa-tests -p 'test_*.py' -v
```

CI includes a deterministic AI job and the live fixture suite in the integration job. `websockets` is an explicit dependency rather than an incidental Uvicorn dependency.

Browser budgets default to 120 recorded actions and 180 seconds. Set `STACKPILOT_AI_TEST_MAX_ACTIONS` and `STACKPILOT_AI_TEST_MAX_SECONDS` on the AI service to increase them. These are cooperative bounds checked between actions; an already running network or browser operation can exceed the wall-clock deadline until its own timeout. Reaching a budget reports incomplete coverage. Restart the AI service after changing the source or configuration.

## What still needs to exist for comprehensive automated testing

This service is not yet equivalent to a mature coding/computer-use agent. An exploratory crawler cannot infer every business assertion. The next substantial work is a persisted test plan with expected outcomes, fixtures/test accounts, isolated browser contexts or separate browser containers, assertion-driven API/UI checks, and replayable tests with traces. Tabs now have separate ownership, but cookies, storage and the sandbox's H.264 display remain shared; tab separation is not tenant isolation.

The service still relies mostly on DOM observations. Canvas-only controls, closed shadow roots, iframes, native dialogs, visual regressions, accessibility, and complete backend/code test execution need dedicated coverage. Independent subagent scheduling is not implemented by the tool stub. Provider selection and latency require controlled model-backed end-to-end benchmarks, which were not performed in this audit.

Frontend and C++ sources were inspected along the agent request path; no frontend or C++ behavioral changes were made by this audit. Existing user edits were retained. The GitHub workflow changes require a remote CI run to validate the entire build/deployment environment.
## Broad website audit follow-up (September 27, 2026)

The previous portfolio run for the exact prompt `test the website` took 166.86 seconds, recorded only three routes, asserted hash URLs that the site intentionally left unchanged during smooth scrolling, submitted the contact form, and treated theme state as unverified. The new run uses the generic same-origin audit worker and a read-only executor policy. It discovers routes from the observed DOM, preserves full destinations, tests section visibility with an `in_viewport` oracle, records pointer reach separately from hover appearance, verifies theme state, and leaves forms, downloads, external links, and server-side effects in an explicit review ledger.

The final disposable real-provider run is stored in `docs/portfolio-agent-audit-final.jsonl`. Its acceptance criteria are page coverage and evidence quality, not a blanket claim that every business workflow is correct. The audit is deliberately finite and reports pending or review items when its page, action, or time budget is reached. A broad audit stops after the worker returns so the planner cannot reuse stale element IDs and issue redundant retries.

This separation follows the public patterns in [Playwright Test Agents](https://playwright.dev/docs/test-agents) (planner, generator and healer with verified selectors), [Playwright actionability](https://playwright.dev/docs/actionability) (visibility, stability, hit testing and enabled checks), [Claude browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) (accessibility references plus console/network diagnostics), and [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) (ordered action batches followed by a fresh screenshot). Those references describe interfaces and recommended control loops; they do not disclose a private competitor implementation or guarantee universal accuracy.

The desktop streamer now also waits for a connected viewer before starting FFmpeg and tears the encoder down after the last viewer leaves. This reduces idle CPU contention with Chromium; it does not promise 60 presented frames per second on every machine or network. The compose setup bind-mounts the producer source, so the running container should be restarted during the normal deployment/rebuild step before measuring the change.
