# Browser smoothness and agent reliability — 1 October 2026

Updated 2 October 2026 with actual viewer and selected-model qualification.

## What was wrong

The latest stored portfolio test visited six same-origin pages but left eleven controls unverified. These included ordinary navigation, theme switching, and form behavior. It correctly reported incomplete coverage, but a special audit path ended the run immediately after its crawl, preventing the planner from continuing into workflow tests. A previous run also hit the provider's thirty-second response timeout.

The stream had a separate performance defect: a visible page fell to eight frames per second after six seconds without mouse or keyboard input. Animations and an agent's slower reasoning therefore looked choppy even with a healthy connection. The adaptation loop also interpreted its own low frame rate as network congestion. Cursor movement generated repeated UI state updates, and click feedback could precede the actual native input.

A real viewer qualification then exposed a reconnect defect: a disconnected browser session could remain cached. WebSocket initialization attempted to display it before accepting the new attachment, repeatedly failing with `No connected tab to display`.

The next full-component run exposed a second recovery race: an auxiliary H.264 watchdog forced JPEG while WebRTC was still negotiating. Delayed callbacks from an old peer could also close its replacement. The viewer now scopes signaling/callbacks to the connection generation and gives one video track exclusive ownership. Capture demand follows the active RTC codec; a cached JPEG preference no longer keeps both capture paths running.

## Published OpenAI guidance and its application here

OpenAI describes an observation/action loop: inspect the current screen, choose actions, perform them, and inspect the resulting state. Its published CUA research also describes self-correction and user confirmation for sensitive actions. This is evidence about the agent loop, not a specification of ChatGPT's private video transport, encoding infrastructure, or cursor compositor. No public source establishes that StackPilot has matching task reliability. [OpenAI CUA research, published January 2025](https://openai.com/index/computer-using-agent/)

The current API guide supports structured computer actions and application-owned code execution in isolated environments. It recommends retaining both runtime state and model conversation state, using actual screenshots at the correct coordinate scale, and verifying outcomes after actions. StackPilot already has native Chromium input, page observations, and durable run checkpoints; this change improves the continuation and input ordering around them. Short, safe action groups can reduce provider round trips, while consequential actions need separate boundaries. [Computer-use API guide](https://developers.openai.com/api/docs/guides/tools-computer-use)

The integration guide places permission checks in the runtime, independently of model prompts. It recommends stopping action batches at the first action requiring consent, completing safe preparation first, and treating page contents as untrusted. StackPilot now presents the specific browser step for approval and binds that approval to its owner, chat, action, and observed page/control state. Sending a message, committing a purchase, destructive changes, and ambiguous mutating gestures cannot inherit blanket approval from a generic website-test request. [Computer-use integration guidance](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

OpenAI's latency guidance recommends fewer serial model calls, smaller useful outputs, parallel independent work, deterministic operations where suitable, and responsive progress updates. Our implementation uses deterministic discovery for baseline coverage, followed by model-led workflow exploration rather than a provider call for every basic hover. Actual task completion still needs assertions, not an optimistic summary. [Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization)

Repeatable traces and behavioral evaluations are required to compare task reliability. A successful isolated test does not establish success across arbitrary websites, authentication states, or business workflows. The qualification fixtures below separate navigation, negative form validation, approval, cancellation, provider failures, and stream recovery. [Agent evaluations](https://developers.openai.com/api/docs/guides/agent-evals)

## Implementation

### Stream producer and viewer

- Visible viewers retain the configured base frame rate. Hidden or stale viewers can reduce capture demand. Frame-rate increases require fresh evidence of actual presented frames and bounded queue/network pressure.
- Encoder adaptation measures achieved throughput, uses warm-up and cooldown periods, and avoids restarting the encoder on every noisy feedback sample.
- H.264 frames retain all slices of a picture in one access unit. Existing dependency-aware dropping and keyframe recovery are preserved.
- Native video presentation and decoder/canvas presentation drive the displayed telemetry. The idle canvas loop is demand-driven, replay buffers are bounded, and decoder failure restores a working fallback without navigating the page again.
- WebRTC reconnect resets decoder/fallback state. Stale socket events, answers, and peer failures cannot close a newer peer. A stalled image capture restarts only after fresh demand and bounded cooldown; a static page is allowed to stop producing changed images. Stream diagnostics distinguish actual H.264 source FPS, image capture FPS, and displayed FPS.
- WebRTC requests a small receiver buffer where supported. This is a preference, not a guarantee: browsers retain network-dependent buffering requirements. [MDN receiver buffering](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget)
- Cursor movement uses one interruptible compositor animation per native movement, rather than React updates for every path sample. Native mouse movement remains ordered; a click cannot overtake its final movement. Click feedback follows mouse release. Drag cancellation releases the button at the latest dispatched position. Reduced-motion settings are respected.
- Scroll input retains actual normalized wheel distance instead of jumping a fixed amount on each event.

### Agent continuation and permissions

- The baseline site audit no longer terminates deeper exploration automatically. Safe navigation, tabs, theme controls, sections, and unsent form validation contribute explicit coverage evidence.
- Deep tests have a separate configurable budget: `STACKPILOT_AI_TEST_DEEP_MAX_SECONDS` defaults to 600 seconds and `STACKPILOT_AI_TEST_DEEP_MAX_ACTIONS` to 360 actions. Browser provider calls use `STACKPILOT_AI_BROWSER_PROVIDER_TIMEOUT_SECONDS`, defaulting to 120 seconds, subject to the service's general request timeout (90 seconds in the production compose default). These remain bounded and cancellable.
- Browser approvals are separate from terminal/deployment permissions. They identify the target site and exact consequential step. Safe preparation continues first; approval does not authorize a later send, delete, or purchase.
- Stop, New Chat, target changes, and stale approvals invalidate pending browser work. Old stream events cannot populate a new chat. Waiting, cancelled, failed, and unverified runs cannot create a successful completion banner.
- Reload does not persist a browser authorization capability in local storage or replay a consequential action automatically. A fresh review is required when the pending binding cannot be recovered safely.

## Measurements and qualification

An isolated synthetic animation on an owned Xvfb display compared the immutable running-image producer with the revised producer. No existing user context was navigated or changed.

| Producer measurement | Before | Revised |
| --- | ---: | ---: |
| Visible without input, delivered access units/second | 8.00 | 30.25 |
| Visible without input, p95 delivery interval | 130.75 ms | 40.37 ms |
| Healthy active phase, delivered access units/second | 46.50 | 48.25 |

These are **producer delivery measurements**, not Windows browser display FPS or a universal 60 FPS claim. The active phase requested 60 FPS but did not sustain it on this machine. The initial decode checks decoded every access unit, but concatenating phases with different frame rates produced muxer timestamp warnings. A separate corrected-timestamp check decoded 683/683 frames with no errors; that run overlapped another benchmark and must not be used as a fair throughput comparison.

Evidence: [baseline](browser-streamer-baseline-2026-10-01.json), [revised](browser-streamer-improved-2026-10-01.json), [clean decode](browser-streamer-decode-2026-10-01.json).

The real component qualification uses a disposable source and headless viewer, the actual signed WebSocket capability, H.264/WebRTC, click-to-visible pixels, reconnect, title/URL synchronization, and forced decoder failure. Its Docker-only WebRTC candidate rewrite maps the published Windows loopback candidate to the AI container's private address. It does not change production SDP and does not qualify the user's Windows browser or a remote NAT/TURN deployment.

On 2 October, the recovery qualification passed navigation/title synchronization, reconnect without rewinding the page, and forced decoder failure. Reconnect remained on WebRTC, replacing the earlier accidental JPEG mode. The earlier recovery run presented 7.89 FPS initially and 7.34 after reconnect. Its controller-polled click-to-visible measurements included CDP and polling delay and must not be interpreted as direct viewer-clock latency. Later qualifications used the same broad owned-source/full-viewer fixture after multiple recovery, capture-demand, feedback, and presentation changes. The comparison shows a measured improvement across those changes; it does not isolate one cause. [Earlier recovery evidence](browser-viewer-recovery-2026-10-02.json)

| Software Docker viewer qualification | Initial presented FPS | After reconnect |
| --- | ---: | ---: |
| Revised full viewer | 22.05 | 21.74 |
| Viewer-clock/source-draw instrumentation | 18.56 | 17.68 |
| Latest queue-diagnostic run | 20.57 | 19.51 |

All three runs preserved the functional recovery checks. These are separate software headless Chromium runs inside Docker, with the fixture-only private-address ICE rewrite. The best observed rate was approximately 22 FPS; it is not a sustained-rate guarantee. **None met the 720p/30 FPS presentation target, and none qualified the user's Windows browser or a remote TURN deployment.** [Revised viewer](browser-viewer-final-2026-10-02.json), [viewer-clock instrumentation](browser-viewer-clock-2026-10-02.json), [latest queue diagnostics](browser-viewer-queue-2026-10-02.json)

The latest eight click samples measured 772.35 ms median and 981 ms p95 on the viewer's monotonic clock, from its WebSocket send to matching streamed-pixel observation in the video-frame callback. The parallel controller-polled upper bound was 809 ms median and 985.4 ms p95, including CDP round trips and 40 ms polling. These medians were corrected from the original upper-middle summaries using the preserved raw samples; no probe was rerun for that correction. These are software frame/pixel observations, not physical monitor composition or human-perceived latency. In the same run, sampled encoded-frame receipt-to-submit age was about 0.12–0.31 ms, the sender queue was empty except for one sample containing one frame, overflow counts were zero, and reported TCP buffered bytes were zero. That evidence does not show a growing sender backlog during the clicks. It also does not rule out unobserved delays elsewhere. [Click and queue evidence](browser-viewer-queue-2026-10-02.json)

The source's recorded draw-issued timestamp preceded the matching viewer pixels by 364–795 ms. That timestamp is JavaScript bookkeeping after canvas draw commands inside an animation callback; it is not proof that the source compositor had presented those pixels. Capture, source rendering/composition, encoding, and viewer presentation therefore need further separation. [Instrumented fixture](../tests/integration/browser_stream_smoke.py), [draw-to-viewer samples](browser-viewer-queue-2026-10-02.json)

An isolated renderer A/B used a separate Xvfb display and Chromium profile, actual composed X11 pixels, and the current producer with a single-thread H.264 decoder. Eight clicks per mode measured source draw-issued-to-X11 median 117.48 ms with the forced SwiftShader GPU path versus 36.48 ms with CPU page rendering; draw-issued-to-producer packet median was 185.32 versus 90.81 ms. Chromium process-tree CPU was 177.95% versus 44.74%, with 100% representing one CPU core. Both modes created WebGL contexts. The experiment changed a rendering flag group, not one isolated flag, and did not include the full software viewer. [Owned renderer A/B evidence](browser-renderer-ab-2026-10-02.json)

Both browser entrypoints now use `swiftshader-webgl` with CPU page rasterization when no hardware device is exposed or software rendering is selected. Hardware mode retains its GPU flags. Chromium documents that this mode reserves SwiftShader for WebGL while ordinary rendering uses software, whereas `swiftshader` exercises GPU code paths entirely on CPU. Existing isolated-browser safeguards and the explicit SwiftShader opt-in remain necessary. [Chromium SwiftShader modes](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)

After activation, the full component test again passed navigation, all eight clicks, RTC reconnect and forced decoder fallback. Viewer-clock click median was 499.8 ms; p95 was 1526.5 ms. Initial RTC presentation was 14.01 FPS, reconnect 21.10 FPS, and JPEG fallback 17.57 FPS. Initial execution followed a fresh development-route compilation, so this run is not a controlled FPS comparison with previous warm runs. A separate owned production-browser context also created WebGL, cleared a pixel to green, and read back `[0,255,0,255]` with no GL error. That checks a basic WebGL path, not every shader or application. The isolated source improvement did not establish consistently low full-viewer latency or meet the 720p/30 target. These remain software Docker measurements, with no Windows display, T4 hardware, or ChatGPT reliability parity qualification. [Activated renderer full-component evidence](browser-viewer-software-renderer-2026-10-02.json)

The latest combined Python regression suite ran 395 tests in 62.975 seconds: 341 passed and 54 were skipped. The frontend focused suite passed 48 tests and TypeScript. The workflow-controller subset separately passed 55 distinct focused tests, and one additional owned live Chromium controller case passed. These checks exercise execution contracts and fixture behavior; skipped cases and unsupported environments remain outside that qualification.

The preserved 130.48-second selected Nemotron run discovered 3/3 pages and passed ten model-planned expectations, including invalid and valid native-email states. It never proposed the explicitly requested Send approval, so the strict workflow qualification failed and correctly remained unverified. No message was sent, no delete was performed, and no journal command remained uncertain. One no-tool model turn took 56.6 seconds, demonstrating a provider/planning delay that GPU video encoding cannot remove. [Preserved failed selected-model evidence](../tests/artifacts/browser-depth-selected-nemotron-2026-10-02.json)

After adding the finite original-goal workflow controller, one bounded selected-model retake met the owned fixture contract in 60.11 seconds. All six planner turns used `nvidia/nemotron-3-super-120b-a12b` through NVIDIA NIM without fallback. It discovered 3/3 pages and planned two unique passed validity assertions, one invalid and one valid; nested tool-step events repeat those results and are not additional unique assertions. The model finished without proposing Send, so the controller refreshed the exact current target and prepared its permission card. The run paused as `waiting_for_permission` with `verified=false`; no permission was approved, no POST/delete occurred, and the journal had no pending dispatch. This qualifies safe preparation and approval handling, not successful submission or business/server behavior. [Controller-qualified selected-model evidence](../tests/artifacts/browser-depth-controller-nemotron-2026-10-02.json)

The model encountered a stale element reference and an invalid batch-assertion schema; both were rejected before the invalid input dispatched, and it recovered to complete the native checks. Its theme read was an observation, not a verified theme outcome. This model lane has vision disabled, so screenshot-based visual correctness and canvas-only interaction are not established by the qualification. The earlier failed result remains preserved and is not relabelled as a pass. [Depth and permission details](browser-depth-and-approvals-2026-10-01.md)

## Local versus a g4dn.xlarge

The inspected laptop has an Intel i7-1165G7 and Iris Xe. The current Docker browser uses software graphics; no NVIDIA or render device is exposed. Development compilation and simultaneous browser/encoder tests contend for the same CPU. A stable 720p/30 FPS interactive profile is the sensible starting point here; adaptation should enable higher rates only when achieved throughput and actual presentation support them.

Chromium's media pipeline distinguishes demuxing, decoding, rendering, and platform hardware acceleration. Moving one stage to a GPU does not automatically remove all CPU copies or fix the other stages. Native Windows Chrome might use the laptop's graphics more effectively, but StackPilot's native-browser capture path still needs its own latency measurements; using a personal browser profile is not a performance strategy. [Chromium media architecture](https://www.chromium.org/developers/design-documents/video/)

A g4dn.xlarge provides four vCPUs, 16 GiB RAM, and one NVIDIA T4 with 16 GiB GPU memory. It is a plausible browser/rendering/encoding host, but its CPU count is modest and its value depends on actual GPU usage. It does not accelerate a remote model provider or improve that model's decisions. [AWS accelerated instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html)

For a GPU streaming deployment, colocate Chromium, capture, encoder, and media relay; verify the graphics renderer and an actual NVENC encode; retain software fallback; use the existing low-latency encoder settings; and qualify the direct WebRTC path plus TURN recovery from the user's network. NVIDIA documents GPU-enabled FFmpeg and low-latency encoding configurations. This deployment recommendation is our inference from the pipeline and documentation, not a measured result on a T4. [NVIDIA FFmpeg guidance](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html)

Keep CDP and internal streaming/control endpoints private. A hosted browser needs secure routing to local development applications; a remote container's `localhost` is not the laptop. Prefer a browser host near the user and measure RTT, presented-frame gaps, queue pressure, and click-to-visible delay separately from provider latency.

Spot interruption notices are best effort; supported termination/stop cases usually allow a short warning, while hibernation differs. A Spot streaming worker needs draining, checkpoint preservation, a replacement worker, and reconciliation of an action whose result became unknown during interruption. Do not replay a pending send or purchase merely to restore a session. No EC2 instance was provisioned for this change. [AWS Spot interruption behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html)

## Remaining limits

Deeper exploration is still bounded and depends on the selected model. Authenticated workflows require test accounts and known expected outcomes; MFA, CAPTCHA, protected credentials, and external side effects require appropriate handoff or approval. Cross-origin integrations, desktop/file workflows, unusual canvases, and remote networks need their own qualification. Exhaustive correctness for every website is not inferable from a crawl, and no percentage of ChatGPT-equivalent reliability has been established.

The next useful comparison is a repeated task dataset on the same sites, accounts, model, and hardware: assertion success, missed controls, incorrect mutations, approval correctness, completion time, sustained presented FPS, and p95 input latency. That evidence should determine whether a GPU host, different model, or another transport change is worth deploying.
