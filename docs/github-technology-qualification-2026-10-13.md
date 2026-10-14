# Real GitHub repository qualification — 13 October 2026

This preserves the initial run. The [14 October follow-up](technology-delivery-followup-2026-10-14.md)
records subsequent fixes, passing EXE/JAR/CLI/package and signed Android paths,
real AI healing, and remaining native worker gaps.

StackPilot's broad technology coverage goal has **not passed**. This run uses
real public source, authenticated StackPilot project/deployment APIs, real
build workers and routed runtimes. It preserves failures instead of replacing
repositories with generated demonstration apps.

Four samples passed their requested build/delivery and independent functional
checks: Android APK/device workflow, standalone web app, explicitly configured
Python/Tk Linux GUI and explicitly configured Python package. Three samples
remain blocked by platform capabilities/performance, and one web sample lacks
its required external API configuration.

## Method and boundaries

Eight unique repositories were selected. Android, one web app and Python GUI
were drawn using seed `20261013` from recorded public search candidates. The
other repositories were selected deliberately to cover additional categories.
This is a small characterization sample, not a statistically representative
random sample or proof of every stack/version/OS.

Each source revision is immutable and recorded below. The initial seven cases
imported GitHub source without application edits. Follow-up configuration cases
added only `stackpilot.json` to disposable copies. The additional standalone web
app was imported directly from GitHub. Builds ran through the real APIs:
register → project → deployment → trigger → status/logs → routed delivery.
Third-party build commands ran in StackPilot's Docker workers, not the host.

AI was disabled for these runs to isolate deterministic platform delivery.
These results do **not** qualify model behavior, automatic healing, provider
reliability, production signing, store submission or hostile tenant isolation.
Missing user service configuration is distinguished from a platform defect.

## Repository results

| Category / repository | Immutable revision | Observed result |
| --- | --- | --- |
| Android Kotlin/Compose — [alexbond008/calculator-android](https://github.com/alexbond008/calculator-android) | `8158e226ae3e43e829fafe362d628690f307309d` (`main`) | Passed after platform fixes: original unit test/lint tasks, debug APK build/signature verification, routed download/checksum, emulator install/launch, real calculator interaction (`12 + 30 = 42.0`) and authenticated PNG preview. Application source remained unchanged. Unsuccessful attempts are retained below. |
| React/Vite web — [jean-ely-gendrau/vite-todo-app](https://github.com/jean-ely-gendrau/vite-todo-app) | `39f914f919ac3dc37b63e143255cf8f9f8ade7ae` (`main`) | Production assets built and routed. Actual application workflow failed: missing `VITE_API_URL` caused a fetch to `/undefined` and JSON parsing of the SPA HTML response. A render smoke pass did not establish business correctness. |
| Standalone React/Vite web — [skoulasp/todo-app](https://github.com/skoulasp/todo-app) | `3935a0a247a43bb5e583f522b2ae27448acdad29` (`master`) | Passed production build, route, browser rendering and actual create → complete → reload/persist → delete workflow, with no page errors. |
| Python/Tk Linux GUI — [cyb3rr31a/python-calculator](https://github.com/cyb3rr31a/python-calculator) | `0055e5a9990f511c823f2ba2d4b5943f7e79576f` (`main`) | Raw detection incorrectly selected a Python server. Explicit desktop recipe passed. The real Tk window was displayed through the routed noVNC viewer; keyboard/mouse interaction calculated `12 + 30 = 42`, verified via the viewer clipboard. This proves Linux GUI preview, not Windows EXE packaging. |
| Compose Desktop JVM — [JetBrains/compose-multiplatform-desktop-template](https://github.com/JetBrains/compose-multiplatform-desktop-template) | `87d018ff31d2d9aaa6c43216536807facd57ca9b` (`main`) | Failed the 1,200-second Gradle task discovery deadline on a cold worker. Distribution download alone took about 910 seconds; project dependency configuration then exhausted the remaining deadline. No successful JAR or GUI qualification was obtained. |
| WPF Windows — [microsoft/WPF-Samples](https://github.com/microsoft/WPF-Samples) | `811d01e95c8c929e68539d698d0a0609e94fd185` (`main`) | Whole sample collection exceeded the 60-second planning deadline. Separately selected the actual `Sample Applications/CalculatorDemo` app (`net10.0-windows`), exposing a Linux-toolchain selection bug. After the fix, the same app correctly reported the missing native Windows worker. No EXE was built. |
| Go CLI — [charmbracelet/glow](https://github.com/charmbracelet/glow) | `8b0600fa445535b9c53194c0d4f7fe3cf700ef3e` (`main`) | Raw and explicitly categorized CLI builds failed: its authoritative Dockerfile copies a prebuilt `glow` executable that is not in the source checkout. StackPilot lacks the release/prebuild plan needed to supply it. Application source was not altered or its Dockerfile silently replaced. |
| Python package — [pypa/sampleproject](https://github.com/pypa/sampleproject) | `621e4974ca25ce531773def586ba3ed8e736b3fc` (`main`) | Raw detection selected a Python server. Explicit package recipe passed the original unit test and produced wheel/sdist inside the downloadable ZIP. Download size, SHA-256 and attachment headers matched. A fresh isolated consumer installed the downloaded wheel and verified `sample.simple.add_one(5) == 6`, version `4.0.0`. |

The standalone web repository's build reported existing dependency audit
findings. Successful build and workflow results do not certify dependency
security or upgrade compatibility.

## Platform fixes made during this run

1. **Gradle bootstrap recovery:** a worker-only wrapper network timeout of
   60 seconds, up to two retries for identified transient wrapper download
   failures, and one shared overall task-discovery deadline. Original wrapper
   properties are restored byte-for-byte; distribution version, checksum,
   application code and build/test tasks remain authoritative. Compiler,
   test and checksum failures are not retried as network failures.
2. **Native worker prerequisite reporting:** declared Windows/macOS/iOS
   workloads bypass Linux toolchain/recipe selection and retain their required
   OS worker in the plan. The selected WPF app now fails with the correct
   Windows worker prerequisite, rather than a misleading incompatible Linux
   .NET recipe. This does not implement the missing worker.
3. **Android artifact handoff:** container HTTP checks retain their Docker
   address, while the host emulator receives the original allocated host
   address for its authenticated, checksum-bound APK download. An actual
   build exposed this failure after passing compilation, unit tests, lint and
   signature verification. HTTP rejection diagnostics now retain the status
   code without exposing credentials.
4. **Android startup and install ownership:** read the APK's manifest ID with
   the installed SDK tool before installation; refuse replacing packages that
   this worker does not own; retain ownership for cleanup when startup fails.
   Wait for real foreground app UI. On the dedicated emulator, known launcher
   and System UI ANR dialogs can each be dismissed once; repeated system
   failures and application ANRs still fail. Stale UI/window snapshots are
   polled again within the startup deadline instead of producing a false
   failure. The real calculator UI was then observed on the owned emulator.
5. **Large artifact downloads:** the gateway no longer invents chunked bodies
   for empty GET/HEAD requests. It preserves declared request and response
   content lengths. The old framing reset the APK connection at 8,204,400 bytes.
   A real TCP upstream test now verifies a large streamed download, HEAD and
   POST body framing; the actual 10.6 MB APK downloaded completely three times
   through its routed preview URL after the gateway fix.
6. **Repeatable evidence:** added API qualification, configured comparison,
   targeted retry, browser/native interaction and exact-resource cleanup
   harnesses. Observer state writes recover from brief Windows/OneDrive locks.

Six native bootstrap tests cover actual child execution, streaming, deadline
termination, transient retry, refusal to retry compiler/checksum failures and
exact property restoration. Twenty-two repository-plan tests include the
Windows/macOS/iOS prerequisite regression. The related toolchain (28) and
sandbox capability (12) tests also passed. Nine runtime contract tests include
the host/container Android artifact handoff. Fourteen Android worker tests
cover manifest identity, native boundaries, cleanup, startup recovery and
failure deadlines. Three gateway tests include the real TCP framing regression:
**94 focused tests in total**. The production backend, AI service and gateway
image rebuilds passed and were activated. The owned native worker was restarted
with the revised startup/installation logic.

## Concrete remaining work exposed by these samples

- Android: qualify release variants,
  AAB/signing and additional Gradle/SDK combinations separately.
- Native desktop: implement Windows/macOS workers and framework packagers,
  and verify installers/executables on the matching OS. Linux GUI preview
  alone does not satisfy downloadable EXE delivery.
- Gradle performance: desktop dependency/wrapper caches and separate bounded
  bootstrap/configuration progress are needed. Cold downloads consumed most
  of the Compose sample's discovery deadline.
- Repository planning: large sample collections need explicit component
  selection before broad scanning, faster bounded scanning and clear timeout
  diagnostics; timeout exit 124 currently becomes “contract is invalid.”
- GUI/package discovery: select delivery from source evidence rather than
  demanding a server entrypoint for Tk apps and installable libraries.
- CLI release plans: support repositories whose checked-in Dockerfiles package
  outputs created by another build stage/release system. Preserve the user's
  authoritative recipe and explicitly resolve the prerequisite.
- Environment readiness: surface missing required configuration names and
  hosted service links; do not invent values or local database replacements.
- Acceptance: require declared application workflows for business correctness.
  HTTP 200 and visible error text can pass a render smoke check.
- Catalog qualification: add multiple independent repositories per supported
  technology/version/target combination, including expected failures, cold
  and warm workers, and actual AI recovery runs. Remaining families are listed
  in `technology-coverage-gap-audit-2026-10-13.md`.

## Evidence and reproducibility

Source harnesses are under `tests/integration/`:

- `github_category_qualification.py`: seeded raw GitHub characterization.
- `github_configured_qualification.py`: source-preserving delivery settings.
- `github_targeted_qualification.py`: Android retry and selected WPF app.
- `github_runtime_ui.mjs`: initial web app's actual missing-configuration failure.
- `github_delivered_ui.mjs`: standalone web business workflow.
- `github_desktop_ui.mjs`: real noVNC calculator workflow.
- `github_android_ui.py`: authenticated APK/device workflow and PNG stream.
- `github_android_retry.py`: same pinned revision, previous attempts retained.
- `github_qualification_cleanup.py`: exact completed fixture resources only.

Detailed reports, pinned source IDs, complete build logs, downloaded artifacts
and screenshots are retained locally under ignored `tests/artifacts/`:

- `github-category-qualification.json`
- `github-configured-qualification.json`
- `github-targeted-qualification.json`
- `github-android-final.json`
- `github-windows-worker-prerequisite.json`
- `github-web-runtime.json` / `.png`
- `github-delivered-ui.json`, `github-standalone-web.png`
- `github-desktop-workflow.json`, `github-desktop-calculator.png`
- `github-package-consumer.json` / `.log`
- `github-backend-rebuild.log`, `github-native-regression.log`
- `github-ai-service-rebuild.log`, `github-runtime-regression.log`
- `github-native-worker-regression.log`, `github-native-startup-recovery.json`
- `github-gateway-regression.log`, `github-gateway-rebuild.log`
- `github-service-activation.json`
- `github-android-workflow.json`, `github-android-calculator.png`
- `github-final-health.json`

Fixture accounts/projects are disposable. Successful previews are removed
after independent verification; downloaded evidence remains. The user's
existing hosted-service deployment is preserved.

## Final Android and runtime checks

The final Android deployment was `0068dbbd-f596-4ed9-8eb1-b9c1e71b8df7`.
Its deployment reached `running`, its job reached `completed`, and its APK
passed the native launch and routed delivery gates. The independent device
test then cleared the calculator, tapped `1`, `2`, `+`, `3`, `0`, `=`, asserted
the actual display `42.0`, and received a PNG through an authenticated,
deployment-scoped preview ticket. Tickets/service credentials are not retained
in the evidence files.

The downloaded APK is
`android-final-0068dbbd-build-outputs-apk-debug-app-debug.apk`, **10,635,338 bytes**,
SHA-256
`03ad5312380e301c368eeabb2d303eb007dc46e0a1187b0f1465f6c7d5f5dba0`.
This is a debug APK qualification, not release signing or store publication.

The report retains the initial wrapper timeout, the failed host/container
artifact handoff, the native startup failure, and the interrupted download.
No source changes or artificial backend/database were used to force success.

All test projects/accounts were removed after verification. The native test
runtime was released, and its deleted preview route stopped serving. Downloaded
artifacts and screenshots remain locally. Backend, frontend, AI service,
Postgres and Redis health checks passed after activation/cleanup. The user's
existing application container remained running and still returned HTTP 200.

These positive examples qualify the exercised local paths. Windows delivery,
the timed-out Compose Desktop case, the Go release/prebuild path and the wider
technology catalog remain unqualified. AI recovery was deliberately not
exercised in this deterministic delivery run.
