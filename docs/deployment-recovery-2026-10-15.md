# Deployment recovery audit — 15 October 2026

This records observed failures, implemented fixes and verification scope. A passing build or render smoke does not prove all business workflows.

## Wrong Live App and automatic browser opening

The AI page selected an arbitrary running deployment when the repair target had no runtime. Saved chat loading and browser tool activity also opened the viewer automatically. That could show the unrelated DocPilot release on port 58181 while the SRE chat concerned TalentMatch.

Saved chats now bind to their stored project and deployment, clear stale custom URLs and leave Live App closed. New Chat clears those targets. Stream and mutation requests derive the project from the selected deployment before the picker. Only an explicit Live App action or browser-open link opens the viewer.

`tests/integration/repair_chat_target_ui.mjs` passed against the running production frontend at widths 1440, 1920 and 768. It places another running project first, loads a failed repair session, checks the selected target, checks zero browser API allocations and checks New Chat clears it.

## Browser interruptions and capacity

An uninitialized `continuing_browser_task` caused browser testing to stop after connecting. Initialization now precedes its first use. Live agent runs are protected from session reclamation. Release verification has a separate bounded pool, so an interactive viewer cannot consume all verification slots. Unviewed, inactive interactive sessions can be reclaimed; viewed or actively used sessions remain protected. Allocation is committed while holding the display lock.

The browser isolation regressions passed. A real Chromium verification also passed while the interactive pool was full and retained its existing viewed session. This is browser/runtime qualification, not a completed Janux business E2E audit.

## Recovery source and execution

The failed TalentMatch project used a development Compose definition requiring an absent `.env`, while its unambiguous root `render.yaml` declared a production Docker web service. The planner now recognizes that narrow production recipe, preserves the original Dockerfile and selects its actual port 8000. Explicit Compose selection, development context and ambiguous manifests are preserved. No credential values are fabricated or exposed to the model.

Transient Git metadata locks and DNS/connect failures now receive a fresh, bounded checkout retry and queue-level infrastructure retries. Authentication, missing repositories and certificate errors are not relabeled as transient. Planning timeouts are classified as infrastructure failures and have a bounded configurable timeout. Relevant-file discovery avoids unnecessary metadata reads: the TalentMatch discovery pass measured 1.569 seconds after the change, versus approximately 24 seconds in the earlier profile; this single mounted-workspace measurement is not a general throughput benchmark.

Slow source initialization and context preparation previously outlived the lead's 60-second lease. Setup and stream heartbeats now renew that lease, and revoked execution ends the stream with a structured cancellation rather than an uncaught server error.

Recovery uses thinking mode, including resumed-run workers. Automated recovery has full task access and no optional question wait. The selected environment, branch and credential-key references remain authoritative. Secrets remain private to the executor; ownership, cancellation and verified-source release gates remain enforced.

Manual repair manifest excerpts also sanitize every dotenv filename, including examples/templates, before model context creation. Variable names remain available; all values are hidden. The 47-test stream suite passed after this change.

## Failed acceptance prerequisites

Observed failures included entering a native build directory absent from a clean worker, encoding an entire setup script as one executable name, and repeating a frozen check with an unsuitable SDK/setup. A redundant quoted shell-script layer is now normalized narrowly, and invalid whole-script setup argv is rejected before plan freezing.

`verify_agent_source` can repair an admitted execution environment only after a failed independent check on the exact source revision and completion contract. It preserves frozen test argv, roots, feature IDs and expected output assertions. New source edits invalidate permission and verification. Actual independent process results still decide acceptance.

The manual repair response schema also rejected its own `unverified` outcome. It now serializes that state, preserves stream errors as JSON errors and forces recovery reasoning/task access consistently.

An additional real-provider test exposed generated `.stackpilot-plan.json` in the agent's source inventory. New snapshots exclude generated plan/SDK/signing metadata, and source tools reject those paths with instructions to edit `stackpilot.json`. Generated runtime helpers remain private to the executor. Original application files and Dockerfiles remain intact. The 76-test team/execution/completion subset passed after this change.

## Qualification

- C++ suite: 223 tests passed, including fresh-checkout retry and nonretryable authentication/certificate cases.
- Repository planning: 25 tests passed, including production Render selection and ambiguity/development controls.
- AI core run: 120 tests passed. Later changed execution/response regressions passed in a 79-test subset; resumed-worker reasoning and completion checks passed in a 15-test subset. These subsets overlap and are not additive.
- Production frontend repair-chat checks passed at three widths. Project setup checks passed at four widths, including a bounding-box assertion that Commit SHA and ingress share the desktop row.
- Frontend TypeScript checking and production build passed. Broad frontend lint still has existing errors and warnings outside this change.

## Actual release outcomes

**multi-agent-rag**: deployment `fd4e6c53-2d97-46de-a2dc-121bd17bb87d`, job `44f7187a-23e7-4add-9c36-c55582a7e480`, is running. Runtime render smoke and routed HTTP verification passed. Direct probes of `/`, `/api/health` and `/api/ready` returned 200. The latest API-selected exposure is `http://localhost:51019`; the environment route also passed verification at `http://d8d74d9c-100b-45e2-b7d2-30960faf64b7.preview.localhost:8091`. Supabase anonymous access is disabled; guest business functionality is not qualified. No hosted authentication policy was changed.

**RURAL-HEALTHCARE-PLATFORM / TalentMatch**: deployment `ac9c8772-6694-4aaa-9786-2ae6c271953c`, retry job `4db77b41-32c0-4cf3-95ca-4bcb4684f0ac`, completed and is running. Runtime render smoke and routed HTTP verification passed, with no failed assets or console errors. Runtime URL: `http://2943a513-e542-43a5-a703-6ec3248029ee.preview.localhost:8091`. The native engine health endpoint returned version `2.0.0`. A synthetic text-resume scoring request returned HTTP 200 and six score categories using the original linear fallback; a missing resume was correctly rejected with HTTP 400. A real Chromium PDF-upload → Analyze Match → displayed-score workflow also passed (HTTP 200, score 43.1, no page errors); evidence screenshot: `tests/artifacts/talentmatch-recovery-score.png`. The reusable opt-in journey is `tests/integration/talentmatch_scoring_ui.mjs`; set `STACKPILOT_RUNTIME_URL` to the selected release. This qualifies the tested scoring journey, not every business feature or external AI coaching integration.

The successful TalentMatch release came from the platform recipe/infrastructure fixes and a normal build retry. The previous AI incident remains historically failed; it was not relabeled as AI-healed. Earlier SRE attempts did not produce a verified release, and two were interrupted by service restarts during this investigation.

**Real automatic repair qualification**: a pinned copy of `cyb3rr31a/python-calculator` at `0055e5a9990f511c823f2ba2d4b5943f7e79576f` received an intentionally invalid `stackpilot.json` entrypoint. The first disposable run was stopped to apply the generated-metadata fix and cleaned up. A fresh run `f07d1b1de5`, using the provider-listed `nvidia/nemotron-3-super-120b-a12b` with thinking enabled, healed on its first incident attempt in 119.7 seconds. Independent acceptance preceded the rebuild; its stored completion contract was imported with intent source `original_tests_for_deployed_components` and passed its independent command. The completed release and routed checks passed. The built candidate retained `desktop/python-gui`, changed the entrypoint to `python -u main.py` and had an actual X11 window titled `Calculator`. Its private environment marker was absent from persisted model conversation. Evidence: `tests/artifacts/github-real-healing.json`. This qualifies configuration repair and native window startup, not exhaustive calculator GUI testing or a real-provider exercise of every SDK-repair branch. Disposable qualification accounts/projects/runtimes were cleaned up after preserving evidence.

**Anonymous guests**: the user selected guest support for multi-agent-rag. The application already calls Supabase `signInAnonymously()`. Available saved keys are application/runtime credentials, with no Supabase Management API credential. The Supabase plugin was offered but is not yet installed/connected. Enabling the hosted anonymous-sign-in setting and checking guest data isolation require that authorized connection. No authentication policy was changed without access. Supabase distinguishes the anonymous-user feature from its public anon/publishable key: https://supabase.com/docs/guides/auth/auth-anonymous.
