# Remote browser action and streaming repair

The latest cancelled website test exposed stale element IDs after returning to previously visited routes, navigation missing from the batch contract, a timed-out input focus probe reported as a disabled field, and repeated assertions using the home page title on the contact page. The cancelled provider run was not replayed.

The audit now reacquires a unique control from the current document using its semantic identity and landmark scope. A returned page cannot reuse an old list's IDs. Header/footer duplicates can be distinguished, while genuinely ambiguous controls remain untested. Batch navigation supports page assertions, but rejects subsequent element IDs before dispatch until a new observation supplies current IDs. Typing retries a lost read-only focus observation once, before any text input. Disabled controls expose their enabling prerequisites. Planning instructions require route-specific expectations and prohibit replacing a failed expectation with the observed value merely to pass.

A live retest also found hover navigation flyouts covering FAQ controls after scrolling. Pointer preparation now leaves a covering navigation menu with a native mouse move, then rechecks the same target for up to 400 ms. It never removes an overlay, forces DOM state, replays a click or dismisses a modal. A live fixture verifies one FAQ click and checks that a covering dialog still blocks input.

## Streaming measurement

Remote encoder output already ran at approximately 60 FPS. A three-frame relay queue discarded normal SSH bursts and waited for another keyframe; timestamps based on local packet arrival also collapsed burst frames into nearly identical presentation times. The relay now tolerates twelve frames, expires delayed dependencies at 150 ms, and maps opt-in worker timestamps onto the WebRTC media clock. The worker extension preserves the original wire format for legacy clients. DOM-only batch/audit progress respects `include_frame:false`, avoiding redundant JPEG captures and large screenshot events.

Measured the deployed React viewer against an animated remote fixture while executing actual browser tools. The CPU-only remote worker was used; no GPU was provisioned. The viewer used a dedicated Host Chrome context. [Condensed measurement data](remote-interaction-comparison-2026-10-04.json) contains frame callback and receiver statistics without signed browser tickets.

| Phase | Previous displayed FPS | Current displayed FPS | Current decoded FPS | Current median tool duration |
| --- | ---: | ---: | ---: | ---: |
| Idle | 22.63 | 41.17 | 57.23 | — |
| DOM actions | 6.72 | 48.68 | 59.78 | 0.520 s |
| Actions with screenshots | 10.05 | 51.90 | 60.01 | 0.651 s |

All 45 current click/type/scroll actions passed. No new receiver freezes or dropped frames occurred during the two action phases. The idle phase had three freezes, so the stream is not uniformly smooth. Current p95 displayed frame gaps were approximately 36/34/33 ms, compared with 117/383/267 ms previously. These short runs used the same fixture, but differing durations and numbers of actions. Docker Desktop recovery and host load also changed between measurements, so the comparison does not isolate one code change.

This establishes improvement during real executor actions, not a guaranteed 60 FPS display on every phone or network, nor proof that an AI provider chooses correct actions on arbitrary websites. Critical forms, payments and account changes still require scoped approval and explicit expected outcomes.

## Deployment and regression checks

The remote worker script and future CPU image were updated. The AI service was rebuilt for the media clock fixes; the local Compose source mount contains the follow-up pointer recovery and audit scope fixes. Docker cache cleanup and host storage limitations are recorded in [the cleanup report](docker-cleanup-2026-10-04.md).

Validation before the final pointer follow-up: 230 browser unit/contract tests passed (51 opt-in or environment skips), 42 live Chromium tests passed, 10 live audit/contract tests passed, and 55 stream/producer tests passed (one skip). The final pointer/scope follow-up passed 23 relevant tests, including live hover-menu recovery, modal blocking, duplicate landmarks and IDs after document replacement.

Final browser unit/contract discovery passed 233 tests (53 opt-in/environment skips). The read-only remote retest of Navrobotec recorded 54 passed cases with no failed, unverified or stale cases. It visited four of six discovered pages before the time budget expired; two routes remain pending, and critical submissions and business workflows remain explicitly untested. [The condensed audit result](remote-site-audit-2026-10-04.json) preserves that incomplete coverage. This is an executor/audit retest, not a new model-provider run.
