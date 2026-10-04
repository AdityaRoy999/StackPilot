# Browser FPS during AI interaction — 3 October 2026

The AI service, native Host Chrome proxy, production frontend and private remote
SSH forwarder have been updated locally. The changes preserve fresh screenshots,
element identity, action verification, permissions and session ownership.

## Causes and changes

1. A full browser observation rewrote unchanged `data-sp-id` attributes. On the
   owned fixture, this generated 10,890 attribute mutations in a 12-second Local
   action phase and 6,534 in the Host phase. IDs now change only when needed;
   repeated observations produce zero attribute writes, retain identity, and
   still read current values. Replacement controls receive new IDs.
2. Scroll notifications could schedule overlapping full DOM observations.
   Passive refreshes now coalesce, explicit snapshots serialize, and an active
   agent supplies its own fresh post-action observation. The unused CDP DOM
   domain is no longer enabled.
3. Host JPEG capture used the general WebRTC encoder and shared executor.
   A dedicated bounded worker now decodes and encodes the latest independent
   JPEG using a two-thread, zero-lookahead H.264 encoder. The CPU default is
   30 FPS, with regular independent recovery keyframes and no growing image
   backlog. `BROWSER_HOST_MEDIA_FPS` can request 5–60 FPS; it is a limit, not a
   throughput guarantee. Local and Remote H.264 remain encoded pass-through.
4. The production browser canvas now has a React memo boundary and stable
   callbacks in the AI page. Unrelated parent chat updates avoid rerunning the
   viewer; real session, sandbox, URL and viewer-state changes still apply.
5. CDP/JPEG and already compressed media no longer incur WebSocket deflate in
   the AI server and native proxy.
6. Remote CDP and H.264 originally shared one SSH TCP connection. Screenshot
   traffic coincided with video bursts and dependency-safe queue overflow:
   the first Remote vision phase accumulated 29 overflow resets and 651 rejected
   delta frames, with a 2.5-second maximum presentation gap. CDP and media now
   use separate SSH connections, with compression and SSH multiplexing disabled.
   Pinned host verification, restricted forwarding credentials, loopback remote
   listeners and private Docker endpoints remain in use. Either connection
   failing stops its sibling so Docker can restart the whole worker transport.

## Actual viewer measurements

The probe renders the deployed React AI page in an owned native Chrome context,
attaches to the real AI WebSocket/WebRTC pipeline, and executes actual
`browser_interact` click, type and scroll tools against an owned animated fixture.
API fixture data avoids user accounts, cookies and project writes. No provider
calls or external website actions are involved. FPS counts actual distinct
`requestVideoFrameCallback` presentations, not repeated draws or a configured
capture rate. Every dispatched fixture action must verify as passed.

| Worker / phase | Earlier displayed FPS | Final 12-second displayed FPS |
| --- | ---: | ---: |
| Host / idle | 19.29 | 28.58 |
| Host / DOM actions | 14.25 | 27.14 |
| Host / screenshot actions | 15.17 | 27.80 |
| Local / idle | 25.82 | 27.83 |
| Local / DOM actions | 22.32 | 23.39 |
| Local / screenshot actions | 38.34 | 25.73 |
| Remote / idle, shared → separate SSH | 47.09 | 51.96 |
| Remote / DOM actions, shared → separate SSH | 36.76 | 52.39 |
| Remote / screenshot actions, shared → separate SSH | 10.07 | 54.59 |

Host DOM action median duration fell from 543 to 295 ms; screenshot action median
fell from 908 to 390 ms. Host DOM p95 presentation gap fell from 166.6 to 66.6 ms.
The Remote screenshot phase p95 gap fell from 483.4 to 33.3 ms and maximum gap
from 2,500 to 50.3 ms. Remote sender overflow/rejected counters stayed unchanged
through all three final phases; four earlier warm-up overflows preceded sampling.

A separate 20-second-per-phase Remote repeat measured 57.31 FPS idle, 55.91 FPS
during DOM actions and 53.02 FPS during screenshot actions. All 63 actions
verified as passed. Maximum gaps were 50.1, 50.1 and 66.7 ms, respectively;
there were no page errors and owned contexts were disposed. See the
[longer Remote repeat](browser-interaction-remote-final-2026-10-03.json).

Local uses an adaptive 30→60 FPS producer. Its phase order, CPU load and encoder
transitions confound direct FPS comparisons: an intermediate DOM run measured
37.68 FPS, while the final run measured 23.39. This is not evidence of a stable
Local 60 FPS experience, or improvement in every Local phase. The mutation and
overlap defects are fixed; Local rendering/encoding remains load dependent and
occasional longer gaps remain. The existing producer adaptation is preserved.

These results qualify short fixture workloads on this machine and the configured
two-CPU Remote worker. They do not qualify every website, simultaneous provider
token streaming, multiple active viewers, long internet outages, or presentation
on the user's physical monitor. The separate React test checks 30 parent chat
updates without viewer render work and verifies that a real sandbox change
still reconnects. No sustained visible 60 FPS claim is made.

## Verification and evidence

- 62 targeted AI tests: codec output/keyframes/resize, observation pacing,
  pointer order, capture recovery, page state, transactions, run state and actual
  WebRTC decoding.
- Three Linux tunnel lifecycle tests: either SSH child failing stops its sibling;
  service termination stops both. These use fake SSH, without network access.
- Four live Chromium checks: observations stay fresh without mutation churn,
  cloned controls reject old references, a no-effect click remains unverified,
  and typing produces fresh evidence.
- 31 targeted frontend tests: memo boundary, cursor, video sinks, WebRTC recovery
  and sandbox selection. Production Next build and TypeScript pass.
- Frontend, AI service and remote forwarder report healthy after replacement.

Evidence:
[Host baseline](browser-interaction-host-before-2026-10-03.json),
[Host final](browser-interaction-host-final-2026-10-03.json),
[Local baseline](browser-interaction-local-before-2026-10-03.json),
[Local final](browser-interaction-local-final-2026-10-03.json),
[Remote shared-connection run](browser-interaction-remote-first-2026-10-03.json),
[Remote separate-connection run](browser-interaction-remote-after-2026-10-03.json).

Refresh the StackPilot page once to load the rebuilt viewer bundle. The settings
continue to support Local, Remote and the dedicated Host Chrome profile in the
current chat. GPU hardware or additional EC2 instances were not provisioned.
