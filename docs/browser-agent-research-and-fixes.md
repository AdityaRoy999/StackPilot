# Browser agent research and repair, 27 September 2026

## Assessment

StackPilot is not yet equivalent to Claude or ChatGPT computer use. The browser executor is materially better after this pass, but task success still depends on the planner, supported widget types, observations, test data and expected outcomes. No competitive benchmark was run. Neither universal website success nor a 5–10x speed improvement has been established. Earlier descriptions implying that the agent could handle everything were too strong.

The work stays local. No EC2 resources were provisioned. Website-specific selectors, routes and travel vocabulary were not added to the production executor. The test fixtures deliberately contain known controls and expected outcomes; those are regression tests, not production workflow rules.

## What the published designs establish

[Claude Code](https://code.claude.com/docs/en/how-claude-code-works) describes gathering context, acting and verifying in an adaptive tool loop, with a model and a harness managing tool execution and context. That is an architectural pattern, not an implementation recipe for matching its model's ability.

[Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) describes a client implementing actions and returning screenshots. Its documented limitations include latency and interaction accuracy. [Anthropic browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) additionally describes browser observations, element references and sequential action batches that stop on failure. This supports refreshing references after changes and batching only known dependent steps.

[OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) documents persistent execution and an action/observation loop. Custom browser tools can fit that pattern. Fresh observations belong in the model's context; streaming video to a human viewer is not a substitute for supplying observations to the planner. These are public API designs; this review does not claim access to private ChatGPT internals.

## Confirmed issues and implemented changes

| Issue found in this code | Repair |
| --- | --- |
| The default NIM browser model was Llama 3.2 11B Vision, while the harness expects native tool calls. | Reject that known incompatible deployment for this loop and route to a configured planner, emitting the reason. Prefer `NVIDIA_NIM_BROWSER_PLANNER_MODEL`, then the configured thinking model. Missing compatible configuration is an explicit error. A custom tested endpoint can declare its tool capability. |
| Browser planning forced fast mode regardless of the request. | Preserve the requested mode. Allow sufficient tool-call output tokens; GPT-OSS fast/thinking modes request low/high reasoning effort. |
| Images returned by mutation tools were discarded as model observations. | Forward current action-result images to compatible vision planners; retain a bounded recent image history. Text-only planners receive DOM evidence. |
| Existing sessions could begin planning from stale history. | Observe the current tab before planning. Reuse a newly opened tab's observation instead of capturing it twice. |
| Repetition prevention blocked ordinary repeated observations and terminated tasks after repeated clicks. | Exempt read-only observations/assertions, fingerprint observed state for repeated actions, reject unchanged mutations and allow bounded replanning. |
| Multiple model-issued tools could continue after a failed prerequisite. | Return matching skipped tool results and replan after failure. |
| The real provider generated `session_id: default` for a request belonging to a different tab. | Bind every browser tool to the request's session; nested batch actions inherit that binding. A model-generated session ID cannot redirect input. |
| `scroll_to(element_id)` did not honor the ID. | Scroll the actual element, including inside nested overflow containers; refresh controls. |
| Hit testing assumed the center and could consider an ancestor a valid hit. | Inspect current bounds and exposed points, including shadow DOM. Dispatch one native click only. Return disabled/hidden/occluded/stale reasons, blocking UI and invalid native form fields. |
| Prior recovery could automatically accept or remove arbitrary dialogs. | Remove automatic dismissal from navigation/click recovery. The planner must select an observed control according to the dialog's meaning. |
| Autocomplete could silently commit a fuzzy or shorter match. | Typing returns options with IDs; only an explicitly requested unique option is committed. Associated ARIA popups take priority. Missing or ambiguous options require another decision. |
| Ordinary fields incurred a fixed autocomplete wait. | Probe ordinary fields immediately; use bounded progressive waits for declared comboboxes. Remove redundant scroll animation delay and suggestion delay. |
| Native select fallback could choose the first option when no match existed. | Match exact value or label, reject duplicates/missing/disabled options, quote values safely, dispatch input/change once and read back selection. |
| Defined custom elements' shadow roots were missed; typing did not recognize nested focus. | Traverse defined open shadow hosts, recognize deep active focus and resolve explicit assertions through current element references. |
| Assertion transport timeouts erased previously observed mismatches. | Preserve the last captured evidence through a transport timeout. A never-observed result remains unverified. |
| A checkbox value of `on` could pass while unchecked; invalid assertions waited for the full deadline. | Require a checked-state boolean for checkbox/radio verification. Return unsupported assertion feedback immediately and retain batch recovery evidence. |
| Screen overlay injection added redundant capture/DOM work. | Use current DOM IDs and normal screenshots; remove inaccurate instructions claiming numbered overlays exist. |
| Video producer had unbounded writes to slow clients; configured bitrate was ignored. | Bound per-client transport backlog; disconnect overloaded clients so reconnect starts at a keyframe. Apply configured bitrate/buffer settings and bound initial keyframe drain. |

[NVIDIA's VLM release notes](https://docs.nvidia.com/nim/vision-language-models/1.7.0/release-notes.html) document the Llama 3.2 Vision deployment's lack of function calling and restrictions on image requests. The capability correction does not mean every hosted wrapper has identical behavior; an explicitly tested custom parser may differ. [NVIDIA's GPT-OSS API reference](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer) documents tool calls and low/medium/high reasoning effort. Capability compatibility does not prove reliable planning.

## Verification and measurement

The opt-in suite exercises real Chromium in separate disposable tabs. It covers single dispatch, checkbox state, native text/date controls, delayed results, validation rejection, stale IDs, autocomplete ambiguity, associated popups, nested scrolling, partial/full occlusion, required fields, native dropdowns, open shadow DOM, fresh screenshots and batch failure handling. Mock-provider integration tests separately check evidence forwarding, repeated observation, replanning, requested mode and tool-protocol ordering. Video producer tests check slow-client isolation.

Before the final model-routing additions, all 99 tests passed with the live suite enabled, including 31 Chromium cases. The subsequent unit run passed 102 tests with 31 live cases skipped. The final validation result is recorded below. Printed `failed` or `unverified` action results in negative fixtures are expected; suite success depends on assertions about their behavior.

During the broad live run, browser-sandbox CPU was approximately 340% (about 3.4 cores) and memory approximately 1.74 GiB. The development frontend consumed approximately 1.69 GiB. This is a point measurement under fixture activity, not a steady-state capacity benchmark. Software graphics, multiple active tabs, CDP screenshots and continuous software encoding compete for resources.

`tests/integration/browser_agent_model_smoke.py` exercises the actual configured provider on a disposable HTTP fixture and checks its final state independently. It is a small functional check, not evidence of arbitrary website coverage. An initial attempt used an invalid synthetic URL while the tab was actually about:blank; that setup allowed navigation away from the fixture and was invalid as a task-success evaluation. Its timings still showed real planner round trips of approximately 2–23 seconds. The corrected runner serves a real reachable fixture. Do not use the invalid attempt as an accuracy result or an before/after speed benchmark.

The reachable-fixture run then exposed the wrong-session bug: after 41.18 seconds the original tab remained unchecked with an empty Email field, while the planner used `default`. After binding browser tools to the request, the same simple prompt completed with independently observed `checked: true` and `email: qa@example.com` in 42.00 seconds. The action batch took 911 ms, but the planner required several attempts to formulate a valid checkbox assertion. It eventually used the correct checked-state expectation. This is concrete evidence of a session repair and remaining planner weakness; it is not a speed win. Subsequent changes add assertion guidance and immediate unsupported-contract feedback.

### Previous-pass validation

- **107 tests passed**, with **33 live Chromium cases enabled**, in 43.607 seconds. Python sources compiled; `git diff --check` passed (existing Windows line-ending warnings remain).
- **Actual-provider smoke passed in 20.03 seconds** after the assertion feedback/guidance changes. Independent readback confirmed the checkbox and Email values. The model first attempted an invalid assertion using `#2`/`#3`, then recovered with current element IDs and a checked-state boolean. Its four planner turns took approximately 2.1–2.4 seconds each; the action batch took 1.70 seconds during concurrent fixture testing. These are individual runs with variable load, not a statistically controlled speed comparison. Time excludes serving/navigating the fixture before the task begins.
- Restarted the AI service and only the video producer/encoder. Chromium's profile and user tabs were retained; disposable fixture tabs were closed. AI health returned `ok`; CDP remained reachable.
- A passive three-second read from the restarted video producer received 185 packets and seven keyframe packets, approximately 61.5 packets/second including cached startup data. This proves the producer is live; it does **not** establish smooth 60 FPS at the viewer or capture-to-paint latency. No new client presentation benchmark was performed for this producer-only change.

## What still prevents production parity

1. **Planner qualification and vision:** the configured fallback GPT-OSS 20B can use tools but cannot consume screenshots. Novel visual widgets need a tested model supporting both images and tools, or a separately integrated visual analyst/coordinate executor. The existing chat-completion provider layer does not implement native Anthropic Messages or OpenAI Responses computer tools. A capability probe should gate deployment, with task evaluations deciding model choice.
2. **Coverage and task correctness:** DOM changes are not business outcomes. Login identities, route/date/entity matches, persisted state and negative cases need explicit expectations. An unknown site's correct prices, permissions or API contracts cannot be inferred solely from a screenshot. Broad prompts need a finite coverage inventory and a report of untested areas.
3. **Widget and window coverage:** closed shadow roots, cross-origin frames, canvas-only controls, file chooser/upload/download workflows, popup switching and complex virtualized controls are not comprehensively implemented or qualified. Right/double click and hover still need the same current-target checks as ordinary clicks. DOM extraction limits must not hide controls from coverage planning.
4. **Isolation and access control:** local shared Chromium profile/display is not a tenant sandbox. Session-specific display ownership improves viewing but does not isolate cookies/storage. Authenticate and authorize viewer/control sessions and use one isolated browser context/display per run before multi-user deployment.
5. **Durable execution:** in-memory session state and bounded retries do not provide crash recovery. Persist goal, selected entities, expected conditions, action evidence and recovery history. After a crash, inspect the actual state before replaying a mutation.
6. **Streaming:** earlier smoke runs measured roughly 49–59 average native presentations per second, with significant pacing gaps; JPEG fallback was about 7 FPS. They do not establish smooth 60 FPS. This pass bounds producer buffering but does not introduce WebRTC, complete video recording, hardware encoding or remove duplicate CDP capture.
7. **Evaluation:** run at least 50 held-out workflows, multiple times, with independent grading, fixed starting state and failure injection. Measure task success, false passes, wrong-target actions, recovery success, p50/p95 duration, planner calls, cost and presented-frame pacing. A comparison to another product requires running it on the same tasks.

## Recommended next implementation sequence

First qualify a tool-and-vision planner on the held-out suite and profile the new planner/tool timing events. Then implement frame/window targeting, generic widget recovery and durable run checkpoints. Add session isolation and authenticated viewing/control before external multi-user use. Finally qualify streaming under motion, CPU contention, reconnects and constrained networks, and optimize the measured bottleneck.

Use short observed-state batches to reduce remote model calls. Keep an accuracy gate: reducing calls, lowering reasoning effort or increasing action throughput is acceptable only while independently graded correctness remains adequate. A 60 FPS viewer and a fast task planner are separate performance requirements.

## EC2 Spot assessment

Moving browser workers off the local development machine can reduce contention if they receive enough dedicated CPU/memory and are placed close enough to the viewer and target websites. Start qualification with an 8-vCPU/16-GiB worker for one active browser and software encoder; this is a sizing experiment, not a capacity guarantee. Use production frontend builds. Consider GPU rendering/encoding only after profiling proves those costs dominate.

Use a stable On-Demand control plane for API, queue and durable state, with warm disposable Spot browser workers. Store artifacts/checkpoints outside the worker. Stop assigning work on interruption, preserve verified evidence, and retry from a checkpoint only after reconciling state. Browser RAM/live sessions do not migrate automatically, and replaying an uncertain purchase or submission can duplicate effects. Keep an On-Demand fallback for uninterrupted interactive runs.

Spot is a cost/capacity choice. AWS states that an instance has the same performance as an equivalent On-Demand instance; Spot itself is not faster. Its interruption warning is best effort and generally about two minutes, with different hibernation behavior. See [Spot best practices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-best-practices.html) and [interruption notices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html).

For remote viewing, benchmark the current transport and evaluate WebRTC with separate reliable control if congestion/frame pacing warrants it. Hosting alone cannot fix planner capability, incorrect verification, ambiguous input or a faulty website.

## Follow-up implementation: latency, precision and video (2026-09-27)

This follow-up changes the existing local architecture. It adds no site-specific route, control name, date, ticket-search script or automatic form submission. Website examples are confined to disposable tests.

### What was repaired

- **Lost streamed text tool calls:** the parser inspected `iteration_content` before buffered JSON was assembled, and discarded incomplete tool JSON after only 400 characters. It now parses the assembled response, bounds candidate buffering at 64 KiB, and has regressions for a long chunked valid call and an incomplete call that must not execute.
- **Unnecessary remote calls:** a fully observed targeted workflow can plan actions plus all terminal assertions in one local batch. `complete_task=true` permits immediate evidence reporting only after independently evaluated step results and a final explicit outcome assertion pass. Broad audits cannot use this shortcut to claim exhaustive completion. Invalid assertion contracts are checked before any batch mutation.
- **Planner overhead and identity ambiguity:** browser tasks receive a browser-specific prompt rather than the general DevOps prompt. Session ownership is bound by the harness and removed from generated tool schemas. Already-open sessions do not expose another open-session tool. Observations include `element_id`, and schemas distinguish opaque tool references from CSS selectors. The qualified GPT-OSS fast lane uses low reasoning effort, requires a tool on the first turn, and requests a single tool call per turn; the batch still executes several known steps locally.
- **Checkbox retries:** `set_checked` reads the current native or ARIA state, dispatches at most one native click when needed, and checks the requested boolean state. A retry cannot undo an already selected checkbox.
- **Stale references:** IDs advance across documents within a browser session and are preserved only by DOM node identity. A cloned control cannot inherit the old reference from copied attributes. Input, selection, scrolling, hit testing and assertions no longer resolve opaque IDs through a copied CSS attribute. Tests cover replacement and navigation, including rejection of a false pass on a removed target.
- **Ambiguous labels and stale pointer coordinates:** multiple matching labels require an explicit observed target. A missing supplied reference cannot fall back to another field. Hover, right click and double click use current bounds and hit testing, including overlay rejection. Hovering a disabled but exposed control remains possible for tooltip inspection.
- **Vision capture cost:** a text-only planner skips screenshots it cannot consume. This does not disable the viewer's independent video stream. A model supporting images continues to receive bounded screenshot evidence.
- **Video joins/reconnects:** a cached keyframe followed by a much later delta lacks intervening H.264 dependencies. New producer clients now wait for a fresh live keyframe. Encoder restarts clear codec caches and require new keyframes for attached clients. Slow consumers are still disconnected rather than silently corrupting delta sequences.
- **Unnecessary video work:** unviewed/background sessions no longer read and discard the full shared desktop stream. JPEG screencasting stops while native H.264 serves all viewers, starts for JPEG viewers or video loss, and stops when no viewers remain. Capture transitions are serialized and mixed viewer demand is preserved.
- **Encoder lifecycle:** stderr is drained concurrently with bounded diagnostic storage. Shutdown and capture failures terminate and reap FFmpeg, escalating to kill only after a bounded wait. SIGTERM shuts down capture and proxy tasks. This prevents the orphan encoder observed during an earlier restart.
- **Provider degradation:** browser fallback models must be explicitly configured and tool-capable. A provider error no longer switches this workflow back to the known incompatible vision deployment.
- **Timing evidence:** planner events now include first-delta time, finish reason, tool count and generated character counts; tool events measure execution separately. Metrics do not expose raw provider reasoning in the benchmark record.

### Measured results and limits

The same disposable task is used throughout: tick a checkbox, enter a supplied Email value and explicitly check both. The provider and browser executor are real, and an independent DOM read grades the outcome. Timing starts after fixture navigation; it does not include browser cold start or an arbitrary external site's loading time.

The previous pass completed one run in **20.03 s**. After the one-call workflow and schema/parser repairs, five consecutive successful runs took **7.51, 2.18, 5.48, 2.51 and 2.81 s** (median **2.81 s**). After adding stale-reference and pointer protections, another five successful runs took **3.54, 6.63, 4.58, 4.44 and 4.13 s** (median **4.44 s**). Full traces for that later set are in `docs/browser-agent-final-smoke.json`. These small sequential samples have variable provider and machine load; they are not controlled proof of a universal speed multiplier. Do not select only the fastest run as the expected duration.

Most successful runs needed one planner call and a local batch of approximately **0.13–0.35 s**, with one later batch taking **0.64 s**. Some initial provider calls still returned malformed JSON; the harness rejected them without executing input, then obtained a correct plan. Disabling parallel tool calls prevents simultaneous planned tool execution but does not guarantee well-formed model output: its first qualification run still needed recovery and took **6.24 s**. The final three repeat runs all passed with one planner call in **3.25, 3.07 and 3.86 s**, median **3.25 s**. `docs/browser-agent-single-tool-smoke.json` records those traces. A reliable 2–3-second latency objective still requires qualifying the model/deployment against both task correctness and generation latency; changing an FPS setting or buying Spot CPU cannot remove hosted-model generation time.

The complete AI regression suite passed **126 tests**, including **40 live Chromium cases**, in **28.294 s**. The later single-tool setting passed all **16 planner/stream tests**. Frontend video modules passed **8 tests**, and frontend TypeScript checking passed. Disposable live cases include actual scrolling, autocomplete, native selection, shadow DOM, disabled/covered targets, replacement/navigation, negative assertions and idempotent state setting. A suite of synthetic regressions does not establish that every case on every website works.

The actual React viewer smoke passed twice with animation, visible native click feedback, reconnect and forced decoder failure. The latest run after demand-driven JPEG capture measured:

| Path | Presented FPS | p95 presentation-callback gap | Functional result |
| --- | --- | --- | --- |
| Native H.264 | 59.99 | 99.9 ms | Moving pixels and click feedback visible |
| Reconnected H.264 | 56.55 | 83.3 ms | Fresh moving video recovered |
| Forced JPEG fallback | 8.88 | 265 ms | Live changing images recovered |

The earlier follow-up run measured 53.59/56.97 FPS for native/reconnected video and 15.57 FPS for JPEG. This variation matters: a 60 FPS encoder and a near-60 average viewer rate do not establish uniformly smooth 16.7 ms presentation. Callback gaps are software-viewer measurements, not capture-to-paint latency. Tests use a separate headless software-rendered viewer on the local development stack. Longer hardware-browser, network-congestion and simultaneous-chat tests remain necessary.

The final local runtime was restarted with the edits. AI health and CDP connectivity passed. An actual SIGTERM lifecycle check confirmed that the producer exited, its FFmpeg child was reaped, and the original Chromium process remained alive. The producer was then relaunched with one encoder. The temporary viewer route was removed. The health endpoint's model field describes the general chat default; browser planner timing events report the separately resolved GPT-OSS model used in these runs.

### Research basis and next production gates

Public product documents describe an observation/action/verification loop and grounded tools; they do not reveal proprietary planner internals or prove StackPilot parity. See [Claude browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), and [Claude Code execution](https://code.claude.com/docs/en/how-claude-code-works). The reduced-round-trip design follows [OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization). The provider controls are documented in [GPT-OSS NIM](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer) and [NIM function calling](https://docs.nvidia.com/nim/large-language-models/1.6.0/function-calling.html). Video dependency/backpressure handling follows [WebCodecs](https://www.w3.org/TR/webcodecs/) and the current software encoder uses [FFmpeg codec options](https://ffmpeg.org/ffmpeg-codecs.html).

The biggest remaining accuracy gap is a qualified tool-and-vision planner: the current tool-capable GPT-OSS deployment cannot interpret screenshots. Cross-origin frames, new windows, canvas-only interfaces, uploads/downloads and closed shadow roots still need explicit implementations and held-out tests. The next production gates remain isolated contexts/displays, authenticated control, durable checkpoints with safe replay, independently graded multi-site workflows, and sustained presentation/latency testing. Broad testing also needs a finite coverage plan and an actual oracle for business correctness. These repairs improve the harness; they do not justify promising universal success or production parity today.
