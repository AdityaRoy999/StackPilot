# Live browser streaming repair

**Current remote qualification (October 4):** the CPU-only remote fixture displayed 41.17 FPS idle, 48.68 FPS during DOM actions and 51.90 FPS during actions with screenshots; receiver decoding during actions was approximately 60 FPS. See [the measurement and action fixes](remote-browser-actions-2026-10-04.md). The previous local qualification remains in [the service follow-up](ai-service-reliability-audit.md#streaming-qualification). Neither result establishes uniformly smooth 60 FPS on all devices. Some earlier values below used submitted-frame counts and are historical.

## Changes

The viewer now waits for fresh H.264 keyframes, bounds encoded/decoded work, discards stale asynchronous image completions, and recovers a stalled decoder without reloading the website or repeating input. It uses a native video compositor where supported, with canvas presentation otherwise. FPS counts presented frames rather than arriving packets; the initial callback establishes a new counter baseline.

The AI WebSocket keeps only the newest independent JPEG and drops overloaded H.264 dependencies until a fresh keyframe. The shared X11 feed is attached only to the explicitly displayed session. Creating a background browser session restores the displayed tab. Every session retains a tab-specific CDP image stream for fallback. Transport health and a client watchdog detect silence. A recovery request continues with fresh screenshots if Chromium refuses a redundant screencast start (`Screencast is already active`); that exception previously closed the viewer socket.

## End-to-end evidence (2026-09-27)

`tests/integration/browser_stream_smoke.py` runs a separate disposable headless Chromium viewer against the actual React component, AI WebSocket, Chromium source tab and encoder. The source animates, then changes a visible region after a native browser click. The test checks changing pixels, forced socket reconnection and an intentionally broken WebCodecs decoder. It neither invokes an AI provider nor uses website-specific action logic.

The final functional run before the compositor counter-baseline adjustment passed:

| Path | Observed presentations | Measured rate | Result |
| --- | --- | --- | --- |
| H.264 native video | 253 over roughly 4.25 s | 59.47 FPS | Pixels changed; click response visible |
| Reconnected video | 231 over roughly 4.26 s | 54.26 FPS | Fresh moving video |
| Forced decoder-failure JPEG | 28 over roughly 4 s | 7.09 FPS | Live changing images; socket retained |

Repeated software-only viewer runs showed approximately 49�59 FPS on the native path; the earlier canvas-copy path typically managed about 10�22 FPS. These are short local smoke measurements, not a production benchmark or guaranteed 60 FPS. The software-only renderer had substantial callback gaps (p95 callback gaps in the final run about 250�350 ms), so average rate alone does not establish smooth frame pacing. Further qualification should use a normal hardware-accelerated browser, longer runs, simultaneous chat rendering, CPU/network throttling and click-to-visible latency distributions.

## Remaining limits

The native generator API is feature-detected; unsupported browsers use canvas. The emergency JPEG fallback prioritizes continued visibility and is not 60 FPS. The global local X11 display can serve only one selected H.264 tab at a time; other sessions use tab-specific images. This is not multi-tenant sandbox isolation. Capturing CDP images alongside H.264 still consumes extra CPU. Replay continues to depend on recorded JPEG snapshots and does not provide complete H.264 recording. Agent task accuracy, provider latency and arbitrary website coverage are separate from this transport repair.

## Follow-up: producer joins and capture demand

The producer now waits for a fresh live keyframe on each join instead of pairing a stale cached keyframe with deltas missing intermediate dependencies. Encoder restart clears codec caches and reaps the previous process. Unviewed sessions do not consume the desktop video feed. JPEG capture is enabled according to viewer demand or video loss, rather than running continuously beside healthy H.264; the duplicate-capture limitation above describes the preceding implementation.

The actual React viewer/source/encoder smoke passed after these changes. Final measurements were **59.99 FPS** native, **56.55 FPS** after reconnect, and **8.88 FPS** in forced JPEG fallback. Corresponding p95 presentation-callback gaps were **99.9, 83.3 and 265 ms**. Visible animation and native click feedback passed. A preceding follow-up run measured 53.59/56.97/15.57 FPS, showing variation under software rendering. Near-60 average presentation does not prove uniformly smooth 60 FPS or capture-to-paint latency. The temporary Next test route was removed afterward; preexisting user tabs were preserved.

## Isolated context qualification

New session-owned browser contexts revealed two further issues: their windows did not inherit startup kiosk layout, and the presentation watchdog could fall back before video arrived during session initialization. Owned windows now explicitly enter fullscreen; the watchdog begins when H.264 arrives. The smoke requires actual decoding/presentation rather than treating received packets as video success, and disposes only its owned context.

The stricter final smoke passed native animation, click-to-visible feedback, reconnect and forced decoder fallback. It measured **45.27 FPS** native, **56.43 FPS** reconnect and **6.17 FPS** JPEG; p95 callback gaps were **266.7, 166.6 and 386.1 ms**. These figures were worse than the prior run, with substantial local development load. One earlier attempt hit transient dev JavaScript asset errors; another exposed the window-coordinate issue. These failures are retained here rather than interpreting the final pass as reliable 60 FPS. Dedicated worker resources and longer latency/pacing qualification remain necessary.
