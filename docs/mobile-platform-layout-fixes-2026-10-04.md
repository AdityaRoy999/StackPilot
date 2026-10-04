# StackPilot phone layout fixes — October 4, 2026

The phone computer now occupies the dashboard content area instead of floating over the conversation in a desktop window capped at 640px. The platform navigation stays available, and **Back to chat** returns to the mounted conversation and its draft. Hidden chat content does not run the follow-bottom scroll update; returning to chat follows the latest answer only when the user was already following it.

The browser viewer offers **Fit / 2× / 3×**. Zoom changes display dimensions only, retaining the agent's 1280×720 viewport, cursor mapping, capture pipeline, and browser session. Swipe to pan while observing; choose **Take browser control** in Browser options to tap or swipe the remote page. A swipe does not generate an extra click. Options also contain element tags, console, and available recordings. This work does not change or claim a stream FPS increase.

Phone assistant text is 13px, with smaller padding, avatars, and message spacing. Completed thinking starts collapsed on phones; expanded diagnostics have a single bounded scroll area. Composer selection controls and Send/attachment/voice controls use separate rows on phones, retaining touch targets and readable labels. Permission buttons wrap within narrow bubbles.

Infrastructure Refresh stays at the right end of its target toolbar, with a busy spinner and no “Reading target…” text. Kubernetes tabs retain the width of their labels and scroll within their own row. Tables retain their own horizontal scrolling. The sweep also corrected Cluster Builder action wrapping, project search/header widths on tablets, visualization controls, Theme Studio editor controls, and Icon Studio toolbar wrapping. Large dashboard headings scale down on phones. Standalone theme/icon editors and browser previews share the phone touch/input sizing rules.

## Validation

- Production Next.js build and TypeScript compilation passed; frontend image `7494d8141e7b0ab0274ca4e1b4650f61a44cd331b8f4bed8e161fbb4d10db895` is deployed locally.
- 28 targeted tests passed across browser viewing, cursor/peer handling, chat continuation, and Markdown. The new interaction regression verifies that zoom retains one WebSocket, taps map to the original viewport, observing does not dispatch clicks, and a manual swipe sends scrolling without an extra tap.
- `mobile_platform_layout_smoke.py` audits all 29 page routes, including redirect aliases and fixture parameter routes, at 320×740, 375×812, 390×844, 844×390, 768×1024, and 1280×800: 174 route/viewport checks. The 375px pass also uses a 20px root font and reduced motion. Assertions cover document/main overflow, clipped controls, runtime errors, readable Kubernetes tabs, refresh placement while loading, bounded reasoning, draft retention, computer bounds, zoom containment, and console opening.
- APIs and browser transport are intercepted in an owned Chromium context. Fixtures include long project/resource names, deployment rows, Kubernetes nodes/pods, and long reasoning. Callback/invitation/preview routes use fixture parameters; this does not validate real OAuth exchange or a real deployment lifecycle. No user project, AI provider call, or deployment was used by these layout checks.
- The deployed build also passed the desktop chat approval/scroll/Markdown regression and the phone pairing/navigation/approval/recovery regression. Approval continues in the same message, dispatches once, and restores correctly on the phone. Frontend and backend health endpoints return 200. Only the frontend was recreated; the temporary UI preview container was removed after testing.

The checks emulate phone viewports. Physical iOS/Android keyboard behavior, device safe-area cutouts, and real stream frame pacing require device testing.

Results: [qualification](mobile-platform-layout-qualification-2026-10-04.json). Screenshots: [chat](mobile-chat-2026-10-04.png), [computer](mobile-computer-2026-10-04.png), [infrastructure](mobile-infrastructure-2026-10-04.png).
