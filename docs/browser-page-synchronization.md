# Browser page synchronization and streaming investigation

## What the screenshot revealed

The viewport showed the portfolio, but its address bar and title described IRCTC. Two independent issues can produce this mismatch: delayed page metadata and a shared desktop capturing a different Chromium window. Faster model inference does not fix either issue.

## Findings and implemented changes

- Titles previously updated mainly during full interactive-tree extraction. The fallback checked only the URL once a second. A passive CDP Runtime binding now publishes document titles, including empty titles; CDP navigation events publish committed main-frame URLs, including history and hash changes. Iframe events cannot replace the main-page identity. The once-a-second check remains a recovery path and reads URL/title together.
- Full DOM scans can finish after navigation. A navigation generation and state revision now prevent those results from replacing newer state. Navigation clears stale controls, cached images, and titles. URL paths and queries retain their case.
- The React connection handler captured old props. Reconnection now attaches to the running session instead of navigating back to its initial URL. The current callback and URL use refs; intentional target changes while disconnected are queued separately. Address-bar editing preserves the user's draft.
- URL/title/session/tab-incarnation/revision now travel with normal JPEG and H.264 frames. The client rejects older revisions and events from another session/incarnation. This repairs missing metadata updates; it does not claim atomic capture/paint alignment. The existing H.264 timestamp is an arrival timestamp, not an independently measured capture timestamp.
- Replaceable control state is coalesced and prioritized in a bounded buffer. A growing console/cursor backlog cannot indefinitely delay the newest page identity. Full DOM element arrays are preserved across title-only updates only on the same route.
- The sandbox had Xvfb but no window manager. Isolated Chromium contexts open separate windows, and selecting a CDP tab was insufficient to ensure the root desktop actually showed it. Openbox is now installed and starts before Chromium, so window activation/fullscreen requests have a window manager to handle them. The running local container was qualified with Openbox without deleting preexisting browser tabs.
- Constant-rate encoding could duplicate frames to catch up after stalls. The encoder now uses variable-rate synchronization, which avoids manufacturing those duplicates and drops timestamp collisions. The producer and decoder retain bounded buffering and keyframe recovery.
- The injected 1-pixel repaint ticker was removed. An idle page should not be altered continuously to inflate frame activity. Global flags disabling background throttling were removed from the startup command so unused windows can yield resources.
- New contexts have a persistent browser-level owner connection and `disposeOnDetach: true`. Chromium disposes them when the owner disconnects, including a worker crash/restart. This prevents future context accumulation without disposing unrelated preexisting contexts.
- Presentation telemetry counts observed video callbacks; submitted frame counts alone do not establish smooth presentation. The latency tooltip explains that packet delivery excludes capture, encoding, and presentation. Clock skew still limits that delivery estimate.

## Verification

`ai-service/tests/test_browser_page_state.py` covers stale extraction, route/title replacement, iframe isolation, and control coalescing. `frontend/src/lib/browser-page-state.test.ts` covers revision/incarnation/session rejection and legacy compatibility. Isolation tests cover persistent ownership and real Chromium disposal on disconnect.

Final automated checks: TypeScript and diff whitespace checks passed; **98 frontend tests passed**; the backend discovery ran **152 tests with 50 skipped** (102 executed successfully); **5 producer/backpressure tests passed** separately on the host; the isolation suite with real Chromium enabled passed **6 tests**, including automatic context disposal after an owner disconnect. The temporary Next viewer route was removed after qualification.

`tests/integration/browser_page_state_smoke.py` runs against real Chromium with URL polling disabled. It covers dynamic/empty titles, pushState, replaceState, hash changes, rapid routes, iframe isolation, redirects, and reload. The final driver run passed 26 timing samples with a **30.75 ms median and 295.86 ms maximum**. These include the CDP action round trip and waiting for driver state, not end-to-end UI paint or LLM latency.

The actual React viewer smoke was extended to check route/title changes, clearing a title, full document navigation, and retaining the new route after reconnect even though its initial prop still points to the old document. It also checks changing pixels, native click feedback, and decoder-failure recovery. A functional run passed all of those cases; it measured about **409 ms** to observe a route/title update through the viewer, with a 200 ms polling interval. Its conservative presentation callback rate was **8.4/s** initially and **11.7/s** after reconnect; fallback was **2.2/s**. Compositor submission counts were higher. These must not be described as uniformly smooth 60 FPS.

A subsequent run under concurrent frontend checking failed the video performance threshold: 11 observed callbacks across roughly 7.7 seconds and a 3.4-second p95 callback gap. Pixels still changed. The worker then had approximately **3.7 GiB of 4 GiB memory in use and 369% CPU**, including preexisting orphaned Chromium pages. This failed measurement is retained; functional synchronization fixes are not proof of production video performance.

After the context-ownership and repaint changes, the final viewer run passed again: **339 ms** to observe the route/title change, **9.85 observed callbacks/s** initially, **12.28/s** after reconnect, and **4.19/s** on the intentionally forced JPEG fallback. Native callback p95 gaps were **250 ms** initially and **150 ms** after reconnect. Visible changing pixels, click feedback, empty title, full navigation, reconnect route preservation, and decoder recovery all passed. This remains a functional pass with limited video performance, not a 60 FPS qualification.

## Qualification still required

The shared local X11 surface supports one selected H.264 window at a time. Background sessions rely on tab-specific JPEG capture. Production concurrency should use a separate capture surface/process per worker/session or an explicitly isolated browser capture service. WebRTC with real capture timestamps and congestion control is a candidate transport once source ownership is isolated; replacing WebSocket alone would not repair wrong-window capture.

Qualify on a normal hardware-accelerated browser and a clean worker image, then run extended CPU/network throttling tests. Track capture-to-visible and click-to-visible latency, URL-to-visible latency, dropped frames, frame-gap p50/p95/p99, reconnect success, memory per session, and session cleanup. Measure fresh page identity independently of large DOM snapshots. Apply success thresholds before claiming 60 FPS or an overall 5–10x task improvement.

Website coverage and agent success are separate from viewer synchronization. Login, anti-bot challenges, third-party failures, external actions, and ambiguous expectations need explicit handling and measured outcomes. An unverified action must remain unverified; no infrastructure change makes every arbitrary website/test case pass.

## Primary sources researched

- [Chrome DevTools Page protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/): main-frame navigation, in-document navigation, screencast events and acknowledgements.
- [Chrome DevTools Runtime protocol](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/): addBinding, bindingCalled, and execution-context identity.
- [Chrome DevTools Target protocol](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-createBrowserContext): context ownership and disposeOnDetach.
- [Extended Window Manager Hints](https://specifications.freedesktop.org/wm/latest-single/): window-manager activation and fullscreen protocols.
- [W3C WebCodecs specification](https://www.w3.org/TR/webcodecs/): decode queues, frame lifetime, and latency optimization.
- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html): fps_mode, variable-rate versus constant-rate frame synchronization.
- [BrowserGym ecosystem paper](https://arxiv.org/abs/2412.05467): reproducible multi-benchmark evaluation of web agents. Its findings reinforce measuring task success and efficiency separately.
- [Observation reduction research](https://arxiv.org/abs/2605.29397): reducing observation cost can improve latency but lose task-relevant information. It does not justify aggressively pruning controls without coverage tests or promising the paper's speedup for StackPilot.

These sources informed the implementation and qualification strategy. They do not reveal proprietary Claude/ChatGPT internals or establish equal performance.
