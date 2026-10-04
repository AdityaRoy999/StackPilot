# Browser optimization implementation

The default Docker browser now starts capture at 30 FPS, drops to 8 after six
seconds without activity or when viewers are hidden, and attempts 60 only with
recent healthy client pacing/queue/RTT and encoder-speed feedback. Encoder load
or slow clients reduce the active rate to 15. No viewers still stops capture.
Rates change by a bounded encoder restart, no more often than every three
seconds; restart needs a fresh keyframe and can cause a brief presentation gap.
FFmpeg flushes each output packet so static pages do not wait for a large buffer
to fill. Filter threads are bounded, and the initial zero-speed warmup report
does not trigger another rate change before the encoder has emitted video.

NVENC is selected only after a real one-frame encode succeeds. Software H.264
remains available. The default Chromium entrypoint requests a hardware graphics
path when `/dev/dri` or an NVIDIA device is exposed; otherwise it uses SwiftShader. The GPU deployment
uses the same adaptive producer. Host Chrome is an optional dedicated worker,
with its own profile and authenticated CDP proxy. Local, host and remote endpoints
are owned by the session rather than shared mutable globals. A live chat cannot
silently switch workers.
The browser choice survives frontend reloads, and both streamed and ordinary
backend AI requests forward it. Start the dedicated worker using
[`native-browser/start.ps1`](../native-browser/start.ps1); its configuration is
loaded by recreating ai-service, as described in the worker README.

The GPU Compose preset shares the StackPilot project/network and replaces its
browser service. Build the GPU image with:

```powershell
docker build -f browser-sandbox/Dockerfile.gpu -t stackpilot/browser-sandbox-gpu:latest browser-sandbox
```

Runtime use requires the
NVIDIA Container Toolkit and an exposed device; the normal Docker browser still
works without either. Its published CDP/video ports default to loopback.

The live viewer negotiates WebRTC through its existing signed, expiring browser
WebSocket capability. Input, page metadata and console events stay on that
connection. Existing encoded H.264 is packetized into SRTP without re-encoding;
host mode currently converts CDP JPEG to H.264. The viewer switches only after a
WebRTC video frame is presented. Timeout/disconnection falls back to the existing
H.264/JPEG path without reloading the website or repeating input.

The development Compose configuration publishes UDP 8011–8026 on loopback and
advertises `127.0.0.1`. This fixes otherwise inaccessible random ICE ports on
Docker Desktop. The bounded socket adapter targets pinned aiortc 1.15.0 and
aioice 0.10.2 APIs. For remote users, set `BROWSER_RTC_ADVERTISED_IP` to an IPv4
address reachable by the viewers and publish/allow the same UDP range, or
configure `BROWSER_RTC_ICE_SERVERS` with STUN/TURN credentials. Production
configuration has no loopback default and does not expose those ports publicly.
TURN is required where direct ICE connectivity cannot cross the network/NAT.
`BROWSER_WEBRTC_ENABLED=false` retains only the existing stream.

The toolbar reports control RTT using one client clock. The input timing metric
is p95 from input submission to the next presented frame after server dispatch
acknowledgment, over up to 60 samples. It includes waiting for dispatch and
presentation, but is not proof the requested visual change occurred. That still
requires application assertions. Packet-time estimates are kept separate and
explicitly exclude capture, encoding and display. Frame rate counts actual video
callbacks/canvas draws. Routine DOM tools can explicitly omit screenshots;
planner instructions prefer structured observations and condition-based waits.
The optional `include_frame` field is exposed in the observation/action/batch
tool schemas, and the main planner respects false instead of overwriting it.
View-only capabilities can negotiate media without gaining control permission.

Qualification so far:

- AI regression suite: 245 collected, 199 passed and 46 intentionally skipped
  opt-in browser/hardware checks. Later focused checks cover viewer permission
  and cleanup, screenshot omission and encoder warmup (14 producer/planning
  checks plus the viewer boundary check passed).
- Backend production and unit-test images build; 203 C++ tests pass. Normal and
  GPU browser images both build; only the normal runtime was activated.
- Actual peer tests receive/decode changing H.264 from encoded packets and the
  CDP-JPEG conversion path, and release listeners when closed.
- Docker-to-Windows synthetic media fixture: 91 decoded changing frames over a
  three-second sampling window; first frame in 1.04 seconds. This proves ICE,
  DTLS, SRTP and decoding across Docker's UDP mapping, not visible UI smoothness.
- Frontend telemetry/peer lifecycle, existing video fallback and page identity
  checks: 17 tests pass. The Next production build generates 27 static pages;
  TypeScript and targeted new-module lint pass.
- Running static-page producer: 29.96 packets/s nominal, 14.96 congested,
  60.21 healthy and 7.72 hidden, with fresh keyframes in every sampling phase.
  These are delivery rates, not visible presentation. The test performs no
  browser actions. See [capture qualification](browser-capture-policy-qualification-2026-09-30.json).
- Rebuilt backend, AI and Docker browser services are active. Backend, AI
  readiness and frontend health endpoints return HTTP 200. No deployments or
  agent runs were active during service replacement.

Host Chrome itself has not been launched or benchmarked here. Browser UI access
was unavailable in this session; no interactive UI/frame-pacing claim is made.
Physical GPU encoding/rendering remains conditional on devices/drivers actually
being exposed. Full production NAT/TURN qualification and long-run visible
input-response distributions remain deployment-specific checks.
