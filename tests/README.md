# Tests

## Docker Linux instance provisioning

`python tests/integration/docker_instance_smoke.py` qualifies real Ubuntu,
Debian and Alpine instances through the production task-lease broker. It
installs Python in Ubuntu, retains scoped source and installed tools across an
actual backend restart, rejects foreign/revoked access and checks cleanup.
It creates a disposable account/project and makes no model calls. The local
stack must enable task workers, Docker provisioning and worker network access.

For the full deployment helper suite with Linux, Node and AI dependencies,
build the AI service image first, then run:

```sh
docker build -f tests/deployment/Dockerfile.qualification -t stackpilot-instance-deployment-tests .
docker run --rm stackpilot-instance-deployment-tests
```

See `docs/docker-instance-provisioning-2026-10-01.md` for resource defaults,
recovery behavior and qualification boundaries.

## Incomplete repository completion

`python tests/integration/completion_repository_smoke.py` qualifies a mostly empty
CLI through frozen feature acceptance, actual Docker worker failures and passes,
an independent C++ release rejection and a verified interactive deployment. It
uses a known fixture repair and makes no model calls. All project/account/source
fixtures are disposable. See
`docs/repository-completion-2026-10-01.md` for the contract and qualification scope.

`python tests/integration/completion_repository_smoke.py --model MODEL` opts in to
provider calls and requires the production agent to implement the unfinished CLI
without a supplied repair. It checks the frozen features and real routed release,
and saves failures separately from the deterministic result. Provider/model
availability is required; this is not part of the no-key CI fixture.

## Local browser task contracts

The AI regression suite also exercises timezone/date anchoring, structured follow-up context, explicit outcome assertions, expected negative validation, delayed results and fresh vision observations. `browser_assert` accepts 1–20 expectations (`text`, `value`, `visible`, `absent`, `checked`, `url`, `title`) and a 0–30 second deadline. Use `purpose=checkpoint` for intermediate readback and `purpose=outcome` for the requested terminal state. Assertions read the top-level live document; absence means no matching visible target. Native date controls use a type-specific semantic fill with readback and one input/change pair, analogous to the [Playwright fill implementation](https://github.com/microsoft/playwright/blob/main/packages/injected/src/injectedScript.ts); ordinary text fields keep native CDP insertion.

`browser_observe` returns fresh semantic controls and a screenshot. The planner receives that screenshot as an image for models whose configured name contains `vision`, or when `runtime.browser_vision_enabled=true` explicitly selects a supported image lane. Setting the flag does not add image capability to a text-only model. Only the latest two planner observation images are retained; user-uploaded images are preserved. The dashboard sends its IANA timezone in `runtime.timezone`.

The default planner now handles both targeted workflows and broad audits; no travel/form burst or fallback crawler runs after it. Tool hints do not select submission or modal buttons by English labels. `browser_fill_form` is retired because it guessed targets and submitted implicitly; use `browser_interact_batch` with explicit current element IDs. Observations expose `total_controls`, `has_more` and `next_offset`; pass the returned offset to inspect further controls. Explicit local URLs are honored. Mock-provider stream tests verify dispatch on unfamiliar workflows and multilingual controls; these are orchestration checks, not real-provider accuracy benchmarks.

## Test suites

Three suites, in increasing order of cost. All three run in CI
(`.github/workflows/ci.yml`) on every push and pull request.

| Suite | Command | Needs |
|---|---|---|
| C++ unit | `docker build --target unit-tests -t stackpilot-unit-tests . && docker run --rm stackpilot-unit-tests` | Docker |
| Frontend unit | `cd frontend && npm test` | Node 20 |
| Integration | `python tests/integration/test_platform.py` | A running stack |

## C++ unit tests — `tests/unit/cpp/`

Pure functions only: no database, no event loop, no network. The suite links
just the translation units under test rather than the whole source glob, so it
builds in seconds after the first run.

`testing.h` is a ~130-line assertion framework rather than GoogleTest. The
builder image ships no gtest and pulling it in would add an apt fetch to every
backend image build. The `TEST()` / `EXPECT_*` names are deliberately
gtest-shaped so the swap is mechanical if the suite ever outgrows it.

| File | What it pins |
|---|---|
| `string_utils_test.cpp` | `shellQuote` — every shell-out in the platform passes through it; a structural check walks the output of hostile inputs and asserts quoting is never broken. Also `trim`, `splitCsv`, `isTruthy`, `parseJsonObject`. |
| `jwt_helper_test.cpp` | The MCP scope gate. `read` cannot mutate, `deploy` cannot delete, unknown scopes grant nothing, and a token with no `permissions` degrades to read-only rather than full access. |
| `compose_planner_test.cpp` | `sanitizeDnsLabel` output is always a valid RFC 1123 label, including after truncation. Plus the plan-time refusals: HTTPS without Ingress, multi-service stacks with no published port. |

Two of these caught nothing in the product and everything in my assumptions:
the planner deliberately falls back to a default port for a *lone* service, and
deliberately downgrades an unsatisfiable `ingress` request to `nodeport`. Both
behaviours are now pinned, because they read like bugs and are not.

## Frontend unit tests — `frontend/`

Logic that runs without a server or a browser. Vitest + jsdom.

| File | What it pins |
|---|---|
| `src/lib/ui-theme.test.ts` | Every theme has picker metadata; the pre-paint init script (assembled by string concatenation, so never type-checked) is valid JS, rejects an unknown `localStorage` value, and never throws when storage is disabled. |
| `src/lib/utils.test.ts` | `cn()` — the last conflicting Tailwind utility wins. Every component's variant override depends on it. |
| `tests/query-keys.test.ts` | Static scan: no React Query key maps to two different endpoints, and no `invalidateQueries` targets a key no query uses. |

That last one exists because of a real crash. The infrastructure page died with
`(ej.data || []).map is not a function` because `["ssh-connections"]` was shared
by one query returning `SshConnection[]` and another returning
`{ connections: SshConnection[] }`. Last writer wins in the cache. TypeScript
cannot see it — each call site is individually well-typed. Only a cross-file
check finds it. The mirror-image bug, an `invalidateQueries` with a key no query
uses, never errors either; the UI just silently keeps showing stale data.

## Integration regression suite — `tests/integration/test_platform.py`

Runs against a live stack (`docker compose up -d`). Stdlib only — no
`pip install`. Exit code 0 = all passed, 1 = at least one failure.

### What it covers, and why

Every test corresponds to a defect that actually shipped:

| Area | The bug it guards against |
|---|---|
| Authentication | Data endpoints reachable without a token |
| Static file exposure | `document_root` was `/app`, serving source and cloned user repos to anonymous callers |
| Platform containers | Any user could claim and stop `stackpilot-postgres`, taking down the platform |
| ai-service auth | The service had no authentication on any route |
| SSRF guard | `provider_overrides.base_url` reached httpx unvalidated — cloud metadata, internal hosts, `file://` |
| MCP token scopes | `permissions` was written to the DB and never read; every token was full access |
| Agent policy | Agent permissions lived in browser `localStorage`; the server never saw them |
| Secrets | A secrets store that returns plaintext on list is just an env var |
| Migration ledger | All migrations re-ran on every boot, replaying destructive backfills |

The common thread: in each case **the code looked correct and did nothing**.
Reading the source did not catch any of them. Only firing a real request did.
Two of these were introduced *while fixing something else* — the SSRF guard
initially covered the chat route but left the embeddings route as a complete
bypass, and dropping the backend to a non-root user silently broke every
application build until the workspace ownership was fixed.

That is the argument for this suite existing: not coverage for its own sake, but
a fast check that the controls still fire.

### Adding a test

Follow the existing shape — one function per area, `check(name, passed, detail)`
per assertion. Tests that need authentication use `mint_mcp_token(scopes, label)`
and must clean up in a `finally` block; the suite is designed to leave no
artifacts behind and is safe to run against a stack with real data.

## Not covered yet

AI service regressions now live in `ai-service/tests/`. Run them with
`PYTHONPATH=ai-service python -m unittest discover -s ai-service/tests -p 'test_*.py' -v`.
The AI CI job runs deterministic tests, and the integration job also runs
the opt-in disposable Chromium fixture suite. See
[`docs/ai-agent-testing-audit.md`](../docs/ai-agent-testing-audit.md) for findings,
live-test commands, measured action latency, and remaining coverage limits.

- React component rendering (no `@testing-library/react` wired up); the unit
  tests cover logic modules, not JSX
- A real deployment lifecycle (build → run → teardown); this needs either a
  disposable project fixture or a dedicated test database
- The C++ controllers themselves. They are covered end-to-end by the
  integration suite, but not in isolation — splitting
  `DeploymentController.cpp` into testable services is the prerequisite.


## Live browser streaming regression

The bounded buffer/display-owner and failed-screencast-restart regressions are in
`ai-service/tests/test_browser_streaming.py`. The decoder/native compositor unit
regressions run inside `frontend` with:

```powershell
npx vitest run src/lib/browser-video.test.ts src/lib/browser-video-sink.test.ts
```

For an end-to-end local check, temporarily copy
`tests/fixtures/browser-stream-viewer.tsx` to
`frontend/src/app/stream-regression-fixture/page.tsx`. The directory must not
already contain a user route. With the local Docker stack running:

```powershell
docker cp tests/integration/browser_stream_capability.py stackpilot-ai-service:/tmp/browser_stream_capability.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/browser_stream_capability.py
$streamCapability = Join-Path $env:TEMP 'stackpilot-stream-qa-capability.json'
docker cp stackpilot-ai-service:/tmp/browser-stream-capability.json $streamCapability
docker cp $streamCapability stackpilot-browser-sandbox:/tmp/browser-stream-capability.json
Remove-Item -LiteralPath $streamCapability
docker cp tests/integration/browser_stream_smoke.py stackpilot-browser-sandbox:/tmp/browser_stream_smoke.py
docker exec -e STACKPILOT_STREAM_QA_CAPABILITY_FILE=/tmp/browser-stream-capability.json -e STACKPILOT_STREAM_QA_RESULT_FILE=/tmp/browser-stream-result.json stackpilot-browser-sandbox python3 /tmp/browser_stream_smoke.py
```

The capability lasts five minutes, is restricted to the owned fixture session,
and never appears in test output. Remove `/tmp/browser-stream-capability.json`
from both containers after the run. Remove only the temporary route file and
its empty directory afterward. Do not
run other browser fixtures concurrently: they share the local Chromium display.
The smoke test creates its own source tab, separate headless viewer/profile and
loopback proxy listeners; it closes those resources and preserves preexisting
tabs. It requires the sandbox's Python `websockets` and Chromium, and a free
headless debug port 9224. No AI-provider calls or purchases are involved.
Measurements and limitations are recorded in
[`browser-streaming-validation.md`](../docs/browser-streaming-validation.md).

The same fixture can qualify a configured remote worker without moving existing
chats. Prepare the route and capability as above, then add these environment
variables to the smoke-test `docker exec` command:

```text
STACKPILOT_STREAM_QA_MODE=remote
STACKPILOT_STREAM_QA_SOURCE_CDP_URL=http://remote-browser-tunnel:9222
STACKPILOT_STREAM_QA_RESULT_FILE=/tmp/remote-browser-stream-result.json
```

The viewer remains in the local Docker sandbox; its owned source tab and encoder
run on the remote server. These numbers measure a software headless viewer and
do not certify the user's hardware-accelerated Windows browser. The temporary
route, signed capability and owned source context require the same cleanup.

To measure only the remote producer and SSH delivery, use
`tests/integration/remote_browser_capture_probe.py` inside the AI service with
`PYTHONPATH=/app`. Confirm no active browser runs or viewers first. The probe
owns and disposes its animated page, counts real H.264 frames, decodes a sample
and needs no NumPy or model-provider access:

```powershell
docker cp tests/integration/remote_browser_capture_probe.py stackpilot-ai-service:/tmp/remote_browser_capture_probe.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/remote_browser_capture_probe.py --seconds 25 --label 720p60 --output /tmp/remote-capture-60.json
```

Its `producer_60fps_met` result is a throughput check. It does not measure the
frontend's presented frame rate; use the full viewer fixture for that.

The live smoke requires actual decoded H.264 presentation before measuring video.
It disposes the exact source context it owns, preserving other tabs/contexts.
Avoid running frontend compilation/type checking concurrently when comparing
frame pacing; record load alongside performance results.
Native video transport is identified by the live receiver's track ID, not just
the presence of a `MediaStream` (a local WebCodecs generator also uses one).
The harness measures eight clicks on the viewer's monotonic clock, starting at
the WebSocket send and ending when a video-frame callback or canvas draw observes
the matching streamed pixel. These `viewer_clock_*` results avoid controller CDP
round trips and polling delay. The separate `controller_upper_bound_*` results
include both, with 40 ms polling, and are upper bounds rather than direct video
latency. The source's `paint_at` field is recorded after issuing canvas draw
commands in an animation callback; it does not confirm physical source
composition. Cross-page draw-to-viewer differences use same-host wall clocks;
viewer send-to-pixel durations use its own monotonic clock. Video callbacks and
pixel reads likewise do not measure physical monitor presentation.

Queue/capture health samples help identify a sender backlog without proving that
every stage has low latency. The functional recovery pass is separate from the
720p/30 FPS pacing target; Docker's software headless viewer and private-address
ICE rewrite do not qualify a Windows browser or a remote TURN deployment.
## Real provider browser smoke check

`tests/integration/browser_agent_model_smoke.py` serves a disposable HTTP fixture, runs the configured AI provider through the real browser tool loop, and independently checks checkbox/email state. It makes provider API calls and requires configured credentials. It does not interact with a third-party website. Use `PYTHONPATH=ai-service:ai-service/tests` on Linux with `AI_BROWSER_LIVE_TESTS=1`; when run inside the AI container, provide the fixture test module on `PYTHONPATH`. The browser container must be able to reach the fixture host (`MODEL_SMOKE_FIXTURE_HOST`, default `ai-service`). Its result is one scenario, not a general reliability benchmark.

`MODEL_SMOKE_MODEL` optionally selects the model. Inspect the JSON `success` field;
the script prints failed scenarios too. Model catalogue access does not prove
inference availability.

`tests/integration/browser_checkpoint_smoke.py` adds a bounded owned three-page
fixture with the real journal, selected provider, native positive/negative email
checks, and an exact Send permission pause. Use `MODEL_SMOKE_TIMEOUT_SECONDS=300`
for the bounded qualification and `MODEL_SMOKE_OUTPUT` to retain sanitized JSON.
The script does not approve or dispatch that consequential step. Permission
evidence distinguishes `workflow_controller` preparation from a model proposal;
a fixture-contract pass remains `verified=false` while waiting for permission.
Count model-planned assertions once: nested tool-step events can repeat their
results. This is not a submission, business/server, or general model-reliability
qualification.

## Deployment and render evidence

Run `tests/integration/runtime_render_smoke.py` inside the AI container with
`PYTHONPATH=/app`. It creates disposable pages for HTTP-200 uncompiled source,
blank HTML, good content and a missing JS asset, verifies expected outcomes, and
closes its owned browser sessions.

`tests/integration/deployment_repair_smoke.py DEPLOYMENT_ID` is an opt-in **real
rebuild**. Select a local deployment with a valid Dockerfile that you authorize
rebuilding. It verifies duplicate-job rejection, refusal of edits during a build,
the exact completed job's browser render evidence and rejection of a different job.
Cold builds can take several minutes; the check allows 600 seconds. It does not
prove application business flows or qualify remote deployment/rollback.

Current findings and qualification limits are in
[`ai-service-reliability-audit.md`](../docs/ai-service-reliability-audit.md).

## Deployment contracts and native artifacts

`python -m unittest discover -s tests/deployment -q` runs the standard-library
deployment contract suite. Run on Linux to include the real native discovery
process timeout/failure tests; those three checks skip on Windows.

`python tests/integration/native_artifact_smoke.py http://localhost:PORT` checks a
running artifact preview, downloads every listed artifact to verify its hash and
size, and checks that source/private/traversal paths return 404. It streams
downloads in memory without writing APKs to the workspace. Use an owned fixture;
this proves artifact delivery, not installation, GUI or device workflows.

Current qualification and remaining work are documented in
[`deployment-remediation-status-2026-09-29.md`](../docs/deployment-remediation-status-2026-09-29.md).

## Local release, stream ownership and Android execution

Against the running local stack, without model/provider calls:

```powershell
python tests/integration/release_pipeline_smoke.py
python tests/integration/browser_authorization_smoke.py
python -m unittest discover -s native-worker -p 'test_*.py' -v
python tests/integration/android_pipeline_smoke.py --restart-worker
```

The release fixture creates owned source/project/user resources, qualifies stable
routing, rejected releases, rollback recreation, manual redeploy and selected
BuildKit credentials, then deletes its project and asserts every journaled runtime
is gone. It retains failed fixture state for diagnosis. Source fixture directories
are under ignored `local-projects`; they do not overwrite user repositories.

The browser fixture uses disposable users/session to prove stream ticket/control
ownership and stop authorization. Both live scripts use the local Docker engine
and a disposable fixture account; never point them at another user's production
stack. Browser authorization requires Python `websockets` 15 or later.

The Android fixture requires the dedicated Windows worker/emulator, SDK and
installed Python dependencies. It performs Gradle build/tests/lint, actual APK
installation, native form interaction/assertion and authenticated frame capture.
`--restart-worker` restarts only this repository's worker and checks frame and
foreground recovery. This opt-in hardware test retains its qualified project.
Run native tests one at a time because the local worker has capacity one.
Add `--cleanup-project` to qualify project deletion and revocation of an
already-issued native preview capability instead of retaining the project.

Live evidence is saved under `docs/*-qualification.json`; inspect its `verified`
field and scope. A debug APK, launch check or browser smoke is not an exhaustive
product test or store-release qualification.

## Browser media optimization

`tests/integration/browser_renderer_ab.py` compares the current forced SwiftShader
GPU page path with CPU page rendering and SwiftShader WebGL. Run inside an idle
browser sandbox, with no other performance probe active:

```powershell
docker cp tests/integration/browser_renderer_ab.py stackpilot-browser-sandbox:/tmp/browser_renderer_ab.py
docker exec stackpilot-browser-sandbox python3 /tmp/browser_renderer_ab.py --output /tmp/browser-renderer-ab.json
```

It refuses an occupied display, uses its own Xvfb display, Chromium profile and
ports, and cleans up its owned processes. It measures actual X11 pixels separately
from JavaScript draw timestamps and encoded packet arrival. CPU percentages use
100% per core. This source-only test does not qualify the full viewer, Windows
display performance, or visual correctness of every WebGL application.

`tests/integration/browser_capture_policy_smoke.py` opens one owned local video
connection and supplies nominal, congested, healthy and hidden-viewer feedback.
It counts producer packets and keyframes without navigating or controlling a
browser tab. Run it against an idle development sandbox; it takes 32 seconds.
It does not measure visible frame pacing.

`tests/fixtures/browser_media_server.py` and
`tests/integration/browser_media_smoke.py` qualify an actual WebRTC connection
with synthetic changing H.264 frames. Run the server in an owned disposable AI
image with the fixture mounted and loopback UDP 8011–8026 published. The receiver
requires aiortc and httpx; it decodes media without browser automation. Never use
the fixture as a production media endpoint.

See [browser optimization details](../docs/browser-optimization-2026-09-30.md)
for transport limits and [host worker setup](../native-browser/README.md) for
the optional dedicated Chrome profile.

For the fresh-chat viewer path, run `python tests/integration/browser_new_chat_smoke.py`.
It creates a disposable account, creates a chat through the public authenticated
API, requests the owner ticket, and decodes three frames from the real Docker
browser. It makes no model calls and deletes its fixture chat/account. Browser
presentation in the user's desktop is not part of this protocol check.

## Dynamic agent teams and accepted-source deployment

The deterministic AI suite includes `test_agent_teams.py`, `test_agent_provider.py`
and `test_agent_transport.py`. They cover scoped parallel editing, leases,
shared budgets, interrupted invocation reconciliation, protected regression tests,
independent acceptance, legacy build aliases and stream cleanup. Run it from
`ai-service` with `python -m unittest discover -s tests -q`.

Against the local stack, use:

```powershell
python tests/integration/agent_team_access_smoke.py
python tests/integration/agent_team_smoke.py z-ai/glm-5.3-flash
python tests/integration/agent_team_smoke.py --lead z-ai/glm-5.3-flash
```

The first makes no model calls and checks real JWT ownership, event replay,
internal broker exclusion and cancellation. The second calls the selected model:
two workers repair disjoint seeded defects, then independent Docker execution
runs the original combined tests before an accepted-source first deployment and
its routed assertion. Both create disposable fixture accounts/projects and remove
their projects. Source fixtures stay under ignored `local-projects` for diagnosis.
Model failures are saved as failed qualification; do not treat fixture success as
universal repository, native-platform or speed qualification. The optional
`--lead` mode uses the production lead stream and only the prompt “Deploy this
repository.” It qualifies that small fixture's lead policy separately from the
programmatically scheduled worker test; its result is saved as
`docs/agent-lead-model-*-qualification.json`.

## Production frontend and current-chat sandbox switching

With the production frontend and all three configured browser workers running:

```powershell
docker cp tests/integration/browser_sandbox_switch_smoke.py stackpilot-ai-service:/tmp/browser_sandbox_switch_smoke.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/browser_sandbox_switch_smoke.py --output /tmp/browser-sandbox-switch-result.json
docker cp tests/integration/mobile_layout_smoke.py stackpilot-ai-service:/tmp/mobile_layout_smoke.py
docker cp tests/integration/frontend_startup_smoke.py stackpilot-ai-service:/tmp/frontend_startup_smoke.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/frontend_startup_smoke.py
```

The worker probe uses the production settings handler in a separate API process,
real configured workers and an owned data-URL fixture. It checks worker
confirmation, URL preservation and context cleanup without model calls or DB
writes. Run against idle workers because creating tabs can briefly change their
display surface.

The UI probe renders the live frontend in an owned Host Chrome context with
synthetic API responses and a mocked browser socket. It checks current-chat
selector/viewer binding, navigation, error display and rollback. It does not
measure actual stream frames. Both probes dispose their owned contexts and leave
user chats, cookies and projects untouched.

## Browser performance during real AI tool actions

With the production frontend, AI service and configured workers idle:

```powershell
docker cp tests/integration/mobile_layout_smoke.py stackpilot-ai-service:/tmp/mobile_layout_smoke.py
docker cp tests/integration/browser_stream_smoke.py stackpilot-ai-service:/tmp/browser_stream_smoke.py
docker cp tests/integration/browser_interaction_performance.py stackpilot-ai-service:/tmp/browser_interaction_performance.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/browser_interaction_performance.py --mode remote --seconds 20 --output /tmp/browser-interaction-qa.json
docker cp stackpilot-ai-service:/tmp/browser-interaction-qa.json docs/browser-interaction-qa.json
```

Run modes `local`, `remote` and `host` separately. The viewer uses the dedicated
Host Chrome worker. Owned contexts, synthetic UI API data and signed ephemeral
tickets avoid user/project/model mutations. Real `browser_interact` tools execute
and verify fixture clicks, typing and scrolling. Samples count actual video
presentation callbacks and frame gaps; they distinguish screenshots from DOM
actions and expose sender queues. This is an idle-worker fixture qualification,
not proof of physical-monitor FPS or every website's performance. Do not run
concurrently with builds, other benchmarks or real browser runs.

`test_browser_host_codec.py`, `test_browser_observation_pacing.py` and the live
observation/clone tests cover the interaction fixes. On Linux,
`test_remote_tunnel_lifecycle.py` also runs when the production tunnel entrypoint
is mounted at `/tmp/remote-browser-tunnel-entrypoint.sh`. Its SSH executable is
faked; it tests process separation, exit and termination without a network.

## StackPilot Remote

Build the current backend image, then run the protocol qualification against a
disposable database/backend/model fixture. It never calls an AI provider:

```powershell
python tests/integration/remote_session_smoke.py
python tests/integration/remote_browser_revocation_smoke.py
```

The second probe uses a disposable account through the real local Remote gateway
and AI WebSocket; it sends no browser attach/navigation command. Start the Remote
gateway before running it.

For phone rendering, desktop handoff and exact-step approval fixtures:

```powershell
docker cp tests/integration/mobile_layout_smoke.py stackpilot-ai-service:/tmp/mobile_layout_smoke.py
docker cp tests/integration/remote_phone_ui_smoke.py stackpilot-ai-service:/tmp/remote_phone_ui_smoke.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/remote_phone_ui_smoke.py
```

For the actual managed HTTPS relay and real mobile live browser, use idle browser
workers. This probe temporarily enables the managed public link if it was off
and restores that state in `finally`. It creates and removes its own account and
browser contexts; it makes no model calls:

```powershell
docker cp tests/integration/remote_session_smoke.py stackpilot-ai-service:/tmp/remote_session_smoke.py
docker cp tests/integration/remote_gateway_live_smoke.py stackpilot-ai-service:/tmp/remote_gateway_live_smoke.py
docker exec -e PYTHONPATH=/app stackpilot-ai-service python /tmp/remote_gateway_live_smoke.py
```

Frontend recovery tests: `npx vitest run src/lib/remote.test.ts
src/lib/browser-sandbox.test.ts src/lib/stream-agent.test.ts` from `frontend`.
See the [Remote implementation notes](../docs/stackpilot-remote-2026-10-03.md) for
the transport, credential lifetime and restart behavior.


### Full phone platform

`tests/integration/remote_platform_live_smoke.py` runs inside ai-service with `remote_session_smoke.py` and `mobile_layout_smoke.py` alongside it. It temporarily enables the managed HTTPS tunnel, pairs an isolated phone browser, checks all sidebar sections and actual account CRUD, renders live browser video and proves live log revocation, then restores the tunnel state and deletes only its disposable data. `remote_phone_ui_smoke.py` checks shared AI approvals and question recovery with fixture responses. `remote_session_smoke.py` qualifies backend authorization and background runs against an isolated database. The old gateway smoke entry point delegates to the full platform test.
