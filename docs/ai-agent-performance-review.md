# StackPilot agent performance and correctness review

Historical snapshot: several findings below have since been repaired. See [the September 27 follow-up](browser-agent-research-and-fixes.md) for implemented fixes, current evidence and remaining gaps; source line numbers below are from the earlier audit.

Reviewed September 27, 2026. This supplements `ai-agent-testing-audit.md`, which records the implemented fixes and 33 passing regression tests. Findings below describe remaining gaps after those fixes. No benchmark against a running Claude or ChatGPT agent was performed. This is a source audit and a limited local transport measurement, not a numerical ranking of competing agents.

## Assessment

StackPilot currently combines a browser automation driver, a model tool loop, heuristic micro-decisions, a crawler, and a live desktop viewer. It is not yet a general computer agent or a dependable autonomous end-to-end test system. The components are useful, but their observation, planning, execution, verification, and session boundaries do not yet form one consistent contract.

The most consequential accuracy problem is the absence of explicit task postconditions. The most consequential speed opportunity is reducing model round trips for known workflows. The most consequential streaming problem is shared display capture and incomplete queue control, rather than an insufficient nominal FPS setting.

Claude Code and computer use are different comparisons. Claude Code uses file, search, shell, and test tools in a context/action/verification loop. Computer-use APIs consume observations such as screenshots and return interactions for an execution harness. Matching a product's UI or tool names does not reproduce its model capabilities or reliability. See the official [Claude Code architecture](https://code.claude.com/docs/en/how-claude-code-works), [Anthropic computer-use documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), and [OpenAI computer-use documentation](https://developers.openai.com/api/docs/guides/tools-computer-use).

## Confirmed remaining findings

| Priority | Evidence in the current source | Consequence and recommended change |
| --- | --- | --- |
| P0 | `main.py:5930` accepts the browser WebSocket without route-level authentication or session ownership validation. A local anonymous handshake with a random nonexistent session ID was accepted; no control message was sent. | Protect both viewing and takeover before accepting. Issue short-lived, session-bound viewer/control tickets from the authenticated backend, validate ownership server-side, and test cross-user rejection. HTTP middleware is not sufficient for WebSockets. Deployment exposure determines external reachability. |
| P0 | `entrypoint.sh:4,16,64` launches one display and Chromium profile. `browser_driver.py:210` attaches session video readers to the shared streamer. | Separate tabs do not isolate cookies/storage or the captured foreground desktop. Concurrent sessions can observe a different tab from the one their CDP actions target. Use separate browser contexts for state and a session-specific rendering/capture target; a desktop agent needs a separate display or sandbox per active session. |
| P0 | `main.py:3105,3362,4279` removes `frame` and `som_frame` from model context. Initial user images can be attached at `3008,3022`, but the ordinary browser tool loop does not append fresh screenshots as model image observations. | The viewer sees video while the planner usually sees DOM text. A vision-capable model does not fix missing visual observations. Provide current, session-bound screenshot observations at decision checkpoints and on escalation, with dimensions and coordinate mapping. |
| P0 | `apv_engine.py:249–362` verifies observable deltas including DOM, control, route, modal, focus, and scroll changes. | An observed effect is not proof of the requested business outcome. Introduce typed expected conditions, retry them to a deadline, and distinguish dispatch, effect, assertion, and task completion. An unrelated mutation can otherwise support the wrong conclusion. |
| P0 | `apv_engine.py:258` treats detected validation errors as failed action outcomes. | Expected rejection is a valid negative-test outcome. Specify the expected error and absence of persistence; do not classify all visible errors identically. |
| P1 | `tools.py:1023` skips the pre-snapshot for all clicks; element clicks have their own verification, coordinate clicks do not. | Coordinate/vision actions need the same before/after observation and explicit assertion contract. Current coordinate click dispatch cannot establish completion. |
| P1 | `browser_driver.py:1849` clamps fast-mode action waits to 250 ms; old requests are removed after 1.5 seconds, and a short period without network events can end waiting while a request remains active. | Quietness is not application readiness. Wait for the expected visible/API condition. Keep short readiness checks for interaction, without treating them as a business assertion deadline. |
| P1 | `system1_decision_engine.py` describes a universal probabilistic engine, but local decisions use keyword/regex rules and fixed confidence values such as 0.95/0.98. | Those numbers are not calibrated probabilities. Restrict local automation to proven workflow contracts, measure its error rate, and escalate ambiguous targets. Do not use high constant scores as authorization for blind progress. |
| P1 | `main.py` hosts the model loop, micro-decision burst, and broad crawler as overlapping controllers. | Repeated navigation, lost intent, and divergent completion criteria remain possible. Use one persisted run state with a goal, plan, current step, expected outcome, evidence, and recovery history. |
| P1 | `streamer.py:59` broadcasts with `write()` and no ongoing `drain()` or bounded per-client sender queue. | A slow reader can accumulate stale buffered video. Give each client a bounded sender and disconnect/resynchronize stalled clients without blocking all other viewers. |
| P1 | `main.py:5935` allows 60 queued packets; `safe_send_bytes` can drop a packet without setting the GOP resynchronization state. Video and control share one socket/send lock. | Backlog can approach one second before recovery; dropped H.264 references can corrupt subsequent frames. Bound latency rather than count alone; recover at a keyframe after any dependency-breaking drop. Separate media and reliable control transport where appropriate. |
| P1 | `InteractiveBrowserCanvas.tsx:338–339` disables the worker. Active decoding/rendering runs on the main thread. No `decodeQueueSize` bound is enforced. | UI work can contend with rendering, and queued decoding can grow despite discarding previously decoded frames. Add a bounded decoder and explicit resynchronization. Validate worker rendering before enabling it. |
| P2 | The dormant worker can prefer `bitmaprenderer`, while its H.264 callback only draws through `ctx2d` and still increments its frame counter. | Enabling the existing worker blindly can produce a blank H.264 canvas with reported FPS. This is a dormant code defect, not the current active rendering path. |
| P2 | The active H.264 branch returns before `recordFrame`; recording currently occurs on JPEG paths. | A live H.264 viewer does not establish that playback evidence is retained. Implement actual encoded recording or a separate capture path and validate replay. |
| P2 | The FPS label can fall back to network packet rate; binary heartbeat accounting and decoded/painted frames are different. `browser_driver.py:238` timestamps after stream reception. | Current displayed latency is not capture-to-paint or click-to-visible-result latency. Track capture, encode, receive, decode, paint, input dispatch, and observed result separately; account for clock offsets. |
| P2 | `streamer.py` declares `BITRATE`, but the CPU encoder command uses hardcoded maxrate/bufsize. | Tuning `STREAM_BITRATE` does not change that path as intended. Expose supported settings and confirm the actual encoder command and measured output. |
| P2 | Unsupported WebCodecs/H.264 paths return without an explicit fallback negotiation. | Validate codec support and request a supported fallback; a connection alone must not be shown as working video. |

These are the highest-impact confirmed findings, not a claim that every defect in the repository has been enumerated. Cross-origin frames, shadow DOM, canvas interaction, desktop dialogs, long-running recovery, prompt injection, and provider-specific tool behavior require dedicated scenario tests before claiming general support.

## What was measured

A passive 10-second read from the running sandbox's TCP video producer yielded:

| Metric | Result |
| --- | --- |
| Received packets | 602 |
| Rate | 60.1 packets/second |
| Median receive gap | 16.68 ms |
| p95 / p99 gap | 18.00 / 19.38 ms |
| Maximum gap | 23.78 ms |
| Keyframe-marked packets | 21 |
| Mean payload / payload bitrate | 114 bytes / 0.055 Mbps |

This was an idle/low-motion stream read inside the AI container. It did not exercise browser presentation, high-motion rendering, remote network congestion, or input response. Packets are not an independent measurement of unique presented frames. It establishes that the producer can deliver approximately its configured packet cadence locally; it does not establish smooth 60 FPS end to end.

The previous input fix reduced one ordinary email-input fixture from approximately 2,760 ms to 210–331 ms in observed runs. This is a roughly order-of-magnitude improvement for that operation, not a general task speedup or a comparison with another agent. The 33 regressions validate specific implementation behavior; they do not measure open-ended task accuracy.

## Execution architecture

Use two independent flows: task execution and human viewing. The model needs selected fresh observations, not 60 screenshots per second. Human viewing needs low latency and correct session identity regardless of how often the model reasons.

1. Convert the user's goal into a structured workflow with inputs, scope, terminal conditions, and a bounded budget. Resolve ambiguity when it changes the expected result.
2. Collect a compact DOM/accessibility observation plus a screenshot when visual interpretation is necessary. Associate each observation with the session, target, navigation epoch, viewport, and capture time.
3. Let the planner propose a short validated script with explicit assertions. Validate tool schemas before execution; malformed arguments should return a schema error rather than silently becoming an empty object.
4. Execute native browser actions locally using stable locators. Use Playwright or an equivalent CDP abstraction for locator resolution and actionability. Re-resolve after navigation or DOM replacement; stop a batch when its assumptions fail.
5. Wait for the specific expected result. For browser flows, assert user-visible behavior. Where authorized test APIs are available, independently verify persisted state and returned IDs. Do not bypass the UI interaction under test merely to make it faster.
6. Continue locally through known states. Escalate to the planner on an unexpected state, ambiguous locator, failed assertion, or new workflow. Preserve the failed step and its evidence.
7. Store verified workflows as parameterized deterministic tests. On repeat runs, use the model for exploration or repair rather than every click. Require review/validation before accepting a changed test expectation, so the agent cannot redefine a bug into a passing test.
8. Record structured events and evidence separately from live video: action, locator, observation version, expected/actual outcome, timestamps, console/network failures, screenshots at checkpoints, trace, and fixture IDs.

[Playwright actionability](https://playwright.dev/docs/actionability), [retrying assertions](https://playwright.dev/docs/test-assertions), and [trace viewing](https://playwright.dev/docs/trace-viewer) provide established mechanisms for browser testing. Adopting them improves the execution contract; it does not automatically solve planning or business test coverage.

For arbitrary desktop work, add an explicitly separate OS adapter with screenshot-based controls and a session-specific desktop sandbox. Browser DOM support alone cannot handle every application. Select shell/API/browser/desktop tools according to the task rather than forcing everything through pixel clicks.

## A realistic 5–10× speed strategy

First instrument model request latency, observation extraction, action dispatch, assertion wait, recovery, and queue delay. Optimize the dominant measured component. Faster model generation cannot remove website/backend latency.

Illustrative calculation only: 30 actions with one 3-second model call and 250 ms of execution each take 97.5 seconds, excluding other costs. Three planning calls plus the same execution take 16.5 seconds, about 5.9× faster. One planning call takes 10.5 seconds, about 9.3× faster. Unexpected states, assertions, navigation, and slow APIs reduce these gains.

Priorities:

- Compile familiar workflows into short local scripts; replay proven tests without model calls.
- Use stable roles, labels, and test IDs rather than repeatedly scanning the full page or guessing coordinates.
- Reuse observations within the same valid state; invalidate after mutation/navigation. Cache stable prompt prefixes where the selected provider supports it.
- Use a strong planner for novel tasks and a faster executor only on measured, unambiguous workflows. Choose models from task evaluations, not names or fixed confidence scores.
- Remove redundant screenshots/DOM extraction and ornamental cursor delays from the critical path. Animate the viewer independently when useful, without misrepresenting the actual input timing.
- Parallelize independent isolated test cases, never dependent steps or shared-profile mutations.
- Maintain an accuracy gate while reducing latency. A faster false pass is a regression.

A 5–10× improvement over the old StackPilot loop is plausible on suitable workloads. A claim of 5–10× faster than Claude or ChatGPT at equal task success is unsupported until measured on the same tasks and conditions. Narrow, repeated workflows are the most credible opportunity to outperform a general agent.

## Smooth live video

Keep capture/encode/decode/presentation timing and action timing independent. At 60 FPS, one presentation interval is about 16.7 ms; this does not mean model decisions or network-backed clicks finish in 16.7 ms.

For the current transport, add bounded per-client encoding/sending queues, keyframe-safe recovery, explicit codec negotiation, a bounded WebCodecs decode queue, and accurate presented-frame telemetry. The [WebCodecs specification](https://www.w3.org/TR/webcodecs/) exposes decoder queue state and key-chunk requirements. Do not indiscriminately discard encoded H.264 delta frames; drop safely by resetting and waiting for a keyframe, or discard already-decoded stale frames.

Evaluate WebRTC media with a separate control channel for remote viewers if the current WebSocket transport cannot meet measured latency under congestion. This is an architecture option, not a guarantee. Use session-specific capture in either implementation. Hardware encoding can reduce encoder cost if profiling shows it is the bottleneck; it does not improve planner reasoning or assertion correctness.

Suggested product targets, not current measured results: 55–60 presented FPS on a defined 60 Hz reference client during motion; under 150 ms p95 capture-to-paint and under 200 ms p95 input-dispatch-to-visible-local-response on a defined local network. Measure application/API completion separately. Include CPU throttling, multiple viewers, reconnects, unsupported codecs, and slow networks. Log drops and stalls rather than displaying a packet counter as rendered FPS.

## End-to-end testing contract

Example: “Test login and adding two items to a cart.”

1. Reset a disposable test account and cart. State expected credentials, prices, stock, and fixture IDs.
2. Submit invalid credentials; assert the expected error, no authenticated session, and no unexpected server failure.
3. Submit valid credentials; assert the correct user identity and authenticated route/state.
4. Add a fixture item twice; assert the correct item and quantity, expected total, and the corresponding persisted cart through an authorized test API.
5. Reload; assert persistence. Exercise a simulated backend failure; assert the error UI and absence of incorrect persisted state.
6. Collect failed assertions, console exceptions, relevant requests/responses with secrets redacted, checkpoint screenshots, and an execution trace. Restore fixtures in cleanup.
7. Report each assertion as passed, failed, or unverified, and explicitly list untested requirements. A navigated page or successful HTTP dispatch alone cannot pass the scenario.

For a repository-wide testing request, inventory existing unit/integration/UI tests and requirements first, then build a coverage matrix. Add functional, negative, role/permission, persistence, accessibility, visual, and performance cases where relevant. “Everything” is not a finite test specification; expose the coverage boundary rather than claiming exhaustive correctness.

Benchmark the planner on at least 50 representative scenarios with multiple runs, independent expected-outcome grading, fixed starting data, comparable browser/network conditions, and recorded time/cost budgets. Include forms, autocomplete, delayed UI, validation, modal/popup, reload persistence, negative API responses, canvas/iframe boundaries, cancellation, and concurrent sessions. Report task success, false passes, wrong-target actions, recovery success, p50/p95 completion time, model-call count, and cost. A competitor comparison must run the competing agents on the same scenarios; source documentation cannot supply those results.

## Implementation order and completion criteria

1. **Trust and correctness:** authenticated session-bound WebSockets; isolated state/capture; explicit assertions; fresh screenshot escalation. Prove no cross-user viewing/control, correct concurrent-session visuals, delayed-success handling, and expected negative-test results.
2. **One execution loop:** persisted typed run state, schema validation, local scripts, deterministic replay, recovery checkpoints. Prove fewer model requests at unchanged or improved independently graded task success.
3. **Streaming:** bounded transport/decoder, recovery, accurate telemetry, recording. Validate actual presented FPS and end-to-end latency under motion and congestion.
4. **Optimization:** model selection, prompt caching, observation reuse, parallel isolated scenarios. Compare the measured suite before and after; reject latency wins that raise false passes.

The earlier executor and reporting fixes are implemented. The architectural items in this review remain a roadmap, not completed features.
