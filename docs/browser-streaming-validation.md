# Browser streaming and qualification

The browser viewer uses WebRTC/native video where available, with WebCodecs/canvas and JPEG recovery paths. Capturing 60 frames per second does not guarantee that every client presents 60 distinct frames per second.

## Current measured result

On October 4, 2026, an owned CPU remote browser fixture was tested through the actual React viewer and browser action path:

| Scenario | Previous displayed FPS | Updated displayed FPS |
| --- | --- | --- |
| Idle animated page | 22.63 | 41.17 |
| DOM interactions | 6.72 | 48.68 |
| Interactions with screenshot observations | 10.05 | 51.90 |

Receiver decoding during action scenarios was approximately 60 FPS. All 45 tested actions passed; action scenarios showed no freezes, while the idle sample still showed three freezes. These are short fixture measurements on one configuration, not universal frame-rate guarantees or hardware-accelerated mobile qualification.

## Implemented behavior

- Preserve source timestamps across remote transport so SSH arrival bursts do not distort video pacing.
- Buffer bounded H.264 dependencies, discard expired chains and request a fresh keyframe before recovery.
- Avoid redundant screenshot work when an action requests only DOM evidence.
- Count presented frames separately from received and decoded frames.
- Attach the shared display stream only to the owned, displayed browser session.
- Use tab-specific screenshots for fallback; recover decoder or transport silence without repeating input.
- Re-observe controls after navigation and rematch only unambiguous semantic identities.
- Verify action outcomes, preserve critical step approvals, and avoid automatically replaying uncertain mutations.

## Reproduce

`tests/integration/browser_stream_smoke.py`, `browser_stream_smoke.py` and `remote_browser_capture_probe.py` exercise functional recovery and performance. Use a disposable owned browser session and the documented integration prerequisites. Store generated measurements in ignored `tests/artifacts/`; include durable result summaries and relevant conditions in this guide.

Longer qualification should measure p95/p99 pacing and input-to-visible latency, concurrent AI/chat work, throttled networks, hardware decoding and real phones. Dedicated workers, GPU encoders and stronger instances can change the bottleneck, but do not establish smoothness without client presentation measurements.
