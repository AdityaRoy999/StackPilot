# Browser agent reform and the path to an OS sandbox

Updated 27 September 2026. This is a local-first implementation and roadmap, not a claim of parity with Claude or ChatGPT computer use.

## Implemented locally

Each newly created browser session now owns a Chromium browser context. Cookies and origin storage are separated from other sessions. Closing the session disposes its context. Existing user tabs are not imported or closed. A live regression verifies cookies, local storage and context cleanup against real Chromium. This is storage isolation inside a shared browser process, not an OS security boundary.

Owned context windows enter fullscreen so the desktop stream and browser input share viewport coordinates. The viewer's decoder watchdog starts when H.264 arrives, rather than treating session creation/navigation as a decoder stall. The live streaming smoke now requires actual decoded/presented video, not merely received H.264 packets; cleanup disposes its exact owned context.

Browser runs now have a SQLite evidence journal with observing, planning, executing, recovering, waiting_for_user, interrupted and terminal states. A tool intent is committed before execution continues; a missing result remains uncertain. The next request receives that checkpoint and is instructed to observe the actual page before issuing input. Later no-op runs do not hide earlier unresolved commands. Raw prompts, credentials, URLs, selectors and assertion values are excluded from this journal; IDs, hashes, counts and timing metadata are retained. This does not redact other existing application logs or browser memory.

Two agent runs cannot control the same session concurrently in the current AI process. Failed journal initialization prevents browser execution. Stream cancellation retains pending commands and releases the session guard. Run completion records verification only when the existing executor reports verified completion with passed assertions and no outstanding commands. Assertions still need to describe the intended business result: merely finding a button is not proof that an account was created.

Local journal data lives under `ai-service/app/.runtime`, excluded from Git and image builds. The production Compose file mounts a dedicated volume and the image prepares its ownership. Compose configuration was validated; no production deployment was performed.

## Qualification and limits

The implementation passed 135 Python tests, including 41 live browser tests. These include real storage isolation, stale controls, occlusion, forms, action verification, stream handling and interruption/concurrency behavior. The real-provider isolated form smoke completed correctly in 7.68 seconds; one malformed JSON tool call required another planning turn. Previous warm runs were faster, but those results do not establish a stable 2–3 second guarantee.

The guard is process-local. Before running multiple AI workers, replace it with a leased session actor/queue. Manual viewer input is not yet serialized through that actor. The journal preserves uncertain metadata but does not restore browser cookies, page memory or implement automatic transaction reconciliation. Unresolved historical intents stay visible; resolving them needs a deliberate evidence-linked reconciliation operation rather than a blind replay.

Contexts remain transient. Restarting the browser loses their state. There is one shared X11 display/encoder, so only its selected session can supply the desktop video at a time. A context is insufficient for secure untrusted workloads, concurrent independent desktop streams, persistent identities or general desktop applications. Existing popup rewriting also needs replacement with explicit owned-tab tracking for OAuth and multi-tab workflows. No mailbox service, Gmail account, OS VM or cloud worker was provisioned by this change.

## Target architecture

Keep the planner separate from an execution worker. One worker owns one active run, its browser/desktop, files, input actor and stream. Give tools explicit observed targets and postconditions. Use DOM/accessibility for normal controls and vision for genuinely visual surfaces; keep those observations consistent with the displayed session. The executor must stop a batch at the first unresolved dependency, reacquire changed controls, distinguish transport failure from application failure and never report success without outcome evidence.

For desktop/file/application work, use a Linux VM or equivalent VM-backed sandbox with an unprivileged desktop user, browser, workspace, downloads, application launch and clipboard tools. Scope mounts, network credentials and secrets to the run. Do not expose the host Docker socket or host home directory. Give the worker useful capabilities explicitly instead of unrestricted host access. Use ephemeral run disks; keep a separately encrypted identity profile only when persistent login is requested. Account credentials are identity resources, not something to regenerate on every test.

Keep video independent of model turns. A worker streams its own display with bounded queues, measured frame age, a fresh keyframe on reconnect and an independent fallback. Move to a measured WebRTC transport when operating remotely; qualify actual capture-to-presentation delay and input feedback, not just encoder FPS. An OS sandbox alone does not fix model latency or video jitter.

## Email and identity

For apps we control, route test SMTP to a capture service such as [Mailpit](https://mailpit.axllent.org/docs/). Allocate a run-specific recipient and retrieve messages through its API. Match recipient, expected sender/context and creation time before selecting a verification link or OTP. Submit through the actual UI and verify the resulting authenticated state. Test expiry, wrong codes, duplicate messages, resend and delayed delivery. Mailpit is an SMTP test sink; it does not automatically receive public Gmail mail or messages from unrelated external websites.

For arbitrary external websites, provision a real test mailbox or receiving domain. Where Gmail is needed, use a dedicated account authorized through [Gmail OAuth](https://developers.google.com/workspace/gmail/api/quickstart/python), with appropriate permissions and tokens in a secret store. Mail content remains untrusted input. Do not execute instructions embedded in a verification email as agent commands.

The sandbox can assist with account creation, but it cannot promise unattended Gmail signup. [Google sometimes requires phone verification](https://support.google.com/accounts/answer/114129?hl=en_us_us). Phone checks, CAPTCHA and similar verification steps require an explicit waiting_for_user handoff, followed by observation of the actual resulting account state. Pre-provisioning a test identity is more predictable than creating a fresh Gmail identity during each website test.

## Delivery order and acceptance

1. Finish browser qualification: representative applications with dropdowns, calendars, nested scrolling, overlays, uploads/downloads, frames, popups, login and delayed navigation. Test repeated runs and fault injection; record task success and false-success rates, p50/p95 completion time and provider errors. Include genuinely unseen websites. Never require every website to pass regardless of application defects.
2. Implement the leased session actor, explicit reconciliation and authenticated owner-bound session lifecycle. Persist semantic goals and evidence securely before introducing unattended durable workflows. Add retention and deletion for journal/evidence storage.
3. Add controlled mailbox retrieval and identity provisioning, qualify complete signup/reset flows, and make handoff/resume visible in the UI. Keep destructive transactions governed by the user’s requested scope.
4. Introduce one local OS sandbox per worker and test file workflows, desktop apps and isolated video. Add explicit popup ownership and browser/vision observation consistency. Measure resources before choosing cloud instances.
5. Move workers to EC2 only after these local gates pass. Keep control plane, queue, identity vault and durable evidence outside disposable workers. Spot instances can reduce cost but do not intrinsically accelerate a given instance; design for interruption and uncertain transactions. [AWS interruption notices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html) are best effort, generally two minutes for termination/stop. Browser RAM is not a migratable checkpoint. Choose region proximity and encoder resources using measured latency and cost.

Production acceptance requires evidence of task accuracy, interruption behavior, isolation and stream latency. These changes are the foundation for that qualification, not an assertion that arbitrary website automation is already solved.
