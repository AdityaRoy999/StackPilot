# AI agent

StackPilot's FastAPI service coordinates provider requests, repository tasks and browser tools. The backend supplies authenticated ownership, saved chat context and provider connections. Public clients and the CLI use backend APIs; they do not need an internal administrator service token.

## Configure

Create your account, open Settings, connect a provider and select its models. Environment configuration can also select NVIDIA NIM or an OpenAI-compatible API. Model support and availability depend on the configured endpoint. A local model server must be reachable from the AI service container and explicitly allowed by the configured network policy.

Fast and thinking modes select configured models. Browser planning uses structured tool calls, fresh control observations and explicit assertions. A model response, a screenshot or a queued build alone is not proof that a task succeeded.

## Workflows

- Inspect build and runtime failures, repository sources, logs and deployment state.
- Edit isolated task workspaces, run configured toolchains, collect verification evidence and queue a release when permitted.
- Provision task-owned Docker instances and coordinate scoped child work.
- Navigate websites, test safe interactions and form validation, observe current controls and verify outcomes.
- Preserve progress across permission pauses, cancellation and documented recovery paths.

Repository completion depends on requirements, available credentials, runtime support and actual validation. Unknown prerequisites remain blocked or unverified; the platform cannot infer a complete product from a tiny fragment reliably.

## Permissions and reliability

With **Ask first**, consequential operations request review of an exact step. Approval tokens bind the authenticated owner, chat/run and signed parameters. Browser approval also checks the current page/control. A changed page, expired token or missing prerequisites must produce a fresh review rather than executing an inferred replacement.

With **Full access**, the browser executes actions within the requested task without an additional permission card. **Autonomous (Never ask)** selects ordinary reversible UI choices and synthetic unsent input data without asking a clarification question. Broad audits exercise form choice buttons, fields revealed by UI actions and native input validation, restoring original input values afterward. They still report missing credentials and business expectations precisely: a general website audit does not authorize sending enquiries, making purchases or deleting data. Those operations need an explicit task and verifiable outcome.

The CLI prints the public action parameters, defaults confirmation to decline, and resumes the same backend session after acceptance. It never blanket-approves submissions because a user requested broad testing. The dashboard records permissions in the associated assistant message.

Provider timeouts, lost tool results and ambiguous dispatched actions remain unverified until reconciled. Builds are successful only after queue and runtime evidence exist; browser tests distinguish observed, passed, failed, blocked and untested coverage. See the [completion plan](stackpilot-completion-plan.md) for deferred work and the [streaming guide](browser-streaming-validation.md) for measured performance.

## Browser widgets and planning

The browser executor exposes verified transactions for common widgets:

- `choose_option` waits for current autocomplete choices, selects one unique label and checks that selection committed. Multiple matching stations or locations produce a clarification when questions are enabled. Typing alone is not a selection.
- Plain HTML lists under a focused custom autocomplete are scoped to that input and exposed as options, even without ARIA roles. If selection unmounts the input, `choose_option` checks the nearby field's changed display against the selected option before reporting a commit. An ambiguous or replaced option is never guessed; a uniquely reobserved replacement may be selected once before any input was dispatched.
- `choose_date` accepts an ISO date, respects native bounds and supports observed custom input formats or calendars with identifiable month navigation. It reacquires day references after each month transition and rejects unavailable or disabled dates.
- Observations identify the active popup, its visible button labels, native dialogs, session-owned tabs and frame contexts. Keyboard input focuses its specified target. Covered controls cannot be activated through a popup. Custom floating dialogs also use layout and hit-test evidence when ARIA roles are missing. Popup controls appear before background controls and the page scan limit, including visible delegated close icons. A blocked click returns the current popup controls so the planner can handle its form or close it instead of repeatedly targeting the launcher. Ordinary forms and fixed toolbars are not treated as blocking popups.
- Preserve a popup that belongs to the requested workflow. If it is dismissed or replaced, stale field actions return the previous popup context and current controls without typing elsewhere. The planner can find its launcher with `browser_observe` using a literal `query` and `scope=viewport` or `overlay`, reopen it and choose a fresh field. References from earlier runs expire; restarted workers allocate a new reference range. A replaced field cannot rebind into another popup.
- Observation pages retain all 80 control references through prompt compaction. Repeated scans of unchanged controls trigger targeted search and recovery reasoning; continuing the same scan cycle stops with an unverified workflow. Expected asynchronous changes can be checked with a bounded `browser_assert` timeout. A failed fresh observation remains unverified instead of exposing cached controls as fresh evidence.
- Native confirmations use a fresh dialog identity and an action-scoped approval. A dialog opening completes perception of the input even when Chromium withholds its acknowledgment until the dialog closes. Tabs can be switched without closing legitimate popup windows.
- Input assertions are checkpoints. Login, booking, search and other business tasks require result or confirmation evidence before an outcome can pass. Filling a phone number or OTP alone does not establish authentication. An unchanged consequential step cannot be replayed automatically under Full access; uncertain outcomes remain unverified.

Fast browser planning disables generated reasoning for the supported Nemotron Super endpoint during routine steps. A distinct failed or uncertain step enables one recovery reasoning turn, then returns to Fast mode, including when recovery first chooses an observation. Repeating the same failure does not keep extending that allowance. Selecting Thinking keeps reasoning enabled. Other providers retain their supported model settings: an always-reasoning model cannot be made non-reasoning just by selecting Fast. Recent evidence stays available while old and nested tool output is compacted to reduce prompt growth.

The batch compiler removes a redundant click immediately before typing into the same observed editable field, ignores string description annotations, and moves an assertion's explicit target into its expectations. It preserves targets and expected values. The planner is asked for at most eight steps; the executor also accepts otherwise valid plans of up to 32 steps after validating the entire plan before any input. It observes each step and stops on an uncertain result or page/modal transition before further control input. A focused editable field is a preparation checkpoint, not a completed form or task.

An optional [Laya/Jev decision server](browser-decisions.md) can select a confident next click for a targeted Fast-mode task without a chat-model round trip. It uses the existing permission and verification path, and falls back to the planner for ambiguity, text entry, questions and recovery. Broad audits retain their coverage planner. The feature is disabled when its endpoint is empty.

Image-capable selected models can request a fresh screenshot. A text-only planner can use a separate compatible image model by setting `STACKPILOT_BROWSER_VISION_FALLBACK_MODEL` (or request runtime `browser_vision_fallback_model`). The fallback receives a fresh JPEG only for sparse, ambiguous, or occluded observations and returns descriptive evidence; the executor still requires a unique current target and verifies the action. No fallback model is assumed when this setting is empty.

Browser results expose `dispatch_state` and `verification_state` separately. A sent input with an uncertain response must not be replayed as though it never happened; a verified control change is a checkpoint, not the requested task outcome. The durable browser run journal accepts only explicit outcome assertions as task completion. Same-page rerenders can rebind a replaced control when exactly one current semantic match exists; navigation, frame changes, and duplicates require a fresh choice. A transient disabled or hidden control gets a bounded wait before a native click. Harmless no-effect scroll or hover steps can continue a batch, but they cannot establish its outcome.

Fast clicks on ordinary inputs and pickers observe their effect immediately instead of waiting for unrelated page animations; a no-effect observation gets one bounded settling retry without another click. Navigation and submit actions keep their longer completion wait. Short wrapper captions label otherwise unnamed inputs such as a custom station field's “From” control.

This is not a guarantee of every website scenario. Canvas-only controls, closed shadow roots, ambiguous unlabeled calendars, transformed frame geometry, CAPTCHA, credentials and missing business preferences can still require additional support or human input. Frame coordinates account for process boundaries and are hit-tested against parent pages; unavailable or transformed geometry fails before input. A general testing request does not authorize inventing credentials or bypassing site protections.

Back and forward use exact browser history entries. Returning from a detail
view is a separate operation that checks the original parent controls, including
same-URL animated views. Audits distinguish repeated buttons by their card
headings, explore bounded nested views and restore the starting page. A failed
assertion cannot replay an already dispatched form submission. See the
[navigation review](browser-navigation-review.md) for causes and qualification.

Regression fixtures cover stacked popups, delayed/ambiguous/replaced suggestions, no-effect selections, leap dates and bounds, calendar year transitions and disabled days, explicit keyboard focus, query permissions, native-dialog approval, tab switching, frame occlusion and business-result assertions. Run unit tests with `python -m unittest discover -s ai-service/tests -p 'test_browser_*.py'` after installing the AI service dependencies. The live widget suite additionally requires `AI_BROWSER_LIVE_TESTS=1` and `BROWSER_SANDBOX_URL` pointing to a test Chromium endpoint; run `test_browser_widgets.py` and `test_browser_live.py`. These tests create synthetic pages and never book, pay or send external messages. To aggregate a saved SSE/JSONL browser run without printing prompts, URLs, or form values, run `python scripts/browser_eval.py path/to/events.jsonl` from the `ai-service` directory.

## Long website tests

Use `/test-long https://your-site.example` in a browser chat, or request a test of 100+ pages or several hours with a selected target. StackPilot queues a durable background campaign and returns a progress card in the same assistant message. The campaign runs independently of the chat connection. Its default limits are 250 discovered pages, four hours, 20,000 browser tool operations and a 1,000,000-token allocation. The card provides pause/resume, stop, questions, exact permissions, paginated results and server replay.

Completed page discovery and verified workflows have separate counts. A campaign finishing its queue is not a pass for every business scenario. Each workflow needs an observed outcome assertion; missing prerequisites, failed steps and unverified cases remain visible. An expired discovery lease can resume safely. Interrupted workflows require live reconciliation, and further input requires a fresh exact review even if Full access was selected. Cookies and origin storage can restore into a new owned browser context; in-memory editor state and site-side submissions cannot be reconstructed automatically.

See [background browser campaigns](browser-campaigns.md) for architecture, limits, storage and qualification instructions.

## Browser completion checks

A bare `test` or `/test` request audits the selected website. A continuation keeps that original scope, including after restoring the goal from chat history. Page discovery and individual workflow outcomes remain separate; one passing batch cannot complete an audit.

The executor retains a bounded baseline of observed control captions and page markers for each task. An unchanged button caption, existing control visibility, focus, or unchanged title/URL remains a passing checkpoint rather than proof that an action succeeded. This applies to standalone assertions and assertion-only completion batches. Explicit requests to check a title or label can still verify that observation, and changes to a control caption retain the original baseline across an observed ID replacement.

For section navigation, assert that the destination section is in the viewport. For a form or sign-in workflow, assert the observed response or resulting state. The guard does not infer arbitrary business requirements or guarantee all-site coverage; unverified requirements remain in the report. Fast tasks with real outcome checks still finish without another synthesis request. The optional Laya/Jev adapter is not required by this guard and remains inactive unless separately configured.

## Browser test replay

Live App captures screen replay for JPEG, H.264 and WebRTC, including cursor metadata. Replay is available on phones and desktops. Capture stops synchronously when the agent emits its final completion event, fails, or is stopped; the live browser remains usable. Permission and question pauses stop capture until the same test resumes and do not mark the test as passed. Short runs can use the screenshot already returned by a browser tool if the viewer has not connected yet.

Screen replay samples up to five frames per second at a maximum width of 720 pixels for decoded video, independently of live-stream FPS. Each test uses at most 32 MB and 1,800 frames; longer recordings gradually reduce sampling while preserving their beginning and latest frame. The latest replay for a chat survives closing/reopening Live App. IndexedDB retains up to five chat recordings for seven days, within 64 MB, on the browser that captured them. Restoring a replay requires authorization for the chat. Storage failures keep replay in the current tab and show a notice. Old unrecorded runs cannot be recovered, and recordings do not transfer between devices or capture website audio. Capture continues when you hide Live App during an active test; closing the dashboard stops client capture.

Background campaigns also save an encrypted server recording, sampled every two seconds with a 512 MB limit per campaign. It can be replayed by an authorized device after the campaign ends, including runs whose dashboard was closed. Recording stops on completion, pause, cancellation or budget exhaustion. Ended campaigns and their evidence expire after seven days by default. This sampled evidence is independent of the live stream's frame rate and does not include website audio.

## Live browser gestures

The agent announces one bounded native cursor trajectory per movement. Live App interpolates it at the display refresh rate, adds a subtle directional lean and shows press feedback after Chromium releases the click. Fast agent mode retains the glide; it controls page settling independently. Cursor transforms run outside React, and idle viewers do not run a perpetual animation loop. Reduced-motion preferences disable the sway, glide and press effects.

Text is inserted into the actual focused control progressively, with up to 40 native batches and approximately 34 ms between batches. Larger programs use larger batches so animation does not require a round trip for every character. Unicode combining marks, common emoji sequences and CRLF pairs stay together. Each batch checks the focused editor and its exact current prefix; focus loss, unexpected transformations, cancellation or uncertain input stops remaining text. A completion event requires exact document readback. Number and segmented date/time controls retain atomic fills because incomplete values can be rejected by the browser. Cursor feedback sends no field text, including passwords. Screen replay preserves the typing indicator.

## Voice input and playback

The dashboard microphone records audio alongside browser speech recognition. Stopping voice input creates a playable preview; sending saves the recording with its user message for playback after reopening the chat. Recording stops automatically after two minutes and is limited to 8 MB. You can also attach one audio file per message. The transcript or typed message is the agent's input; raw audio is stored for playback, not sent to the model. Browsers without speech recognition need a typed message alongside the recording.

Microphone capture requires HTTPS or localhost and browser permission. Switching chats or leaving the page releases the microphone and discards unfinished capture. Previously transcribed messages have no recording to recover. The shipped API configuration allows 16 MB request bodies to accommodate base64 audio; custom reverse proxies must allow the same request size.
