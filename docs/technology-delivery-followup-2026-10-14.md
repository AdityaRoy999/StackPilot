# Technology delivery follow-up — 14 October 2026

These are real pinned GitHub sources built through StackPilot's authenticated
project/deployment/job APIs. Application source was preserved for build cases;
delivery contracts select the intended target and acceptance scenario. These
results qualify specific paths, not every framework/version or full production
readiness.

## Passing sample paths

| Target | Sample and evidence |
| --- | --- |
| Android APK | `alexbond008/calculator-android` at `8158e226ae3e43e829fafe362d628690f307309d`: release APK, selected original unit/lint tasks, test-key signature, verified download, actual emulator launch and authenticated `12 + 30 = 42.0` workflow. |
| Android AAB | Same pinned source: real unsigned and separately signed release bundles, original unit/lint checks, verified signature and download. Store publication remains unverified. The cold signed job took 1,718 seconds; performance targets are not qualified. |
| Linux Python/Tk GUI | `cyb3rr31a/python-calculator` at `0055e5a9990f511c823f2ba2d4b5943f7e79576f`: automatic GUI detection, matching Python runtime ABI, real window and routed viewer input with visually reviewed `42`. Automated clipboard transport remains unverified. |
| Linux Compose GUI/JAR | `JetBrains/compose-multiplatform-desktop-template` at `87d018ff31d2d9aaa6c43216536807facd57ca9b`: original GUI tests under Xvfb, executable JAR/download, real window and routed button input changing `Hello, World!` to `Hello, Desktop!`. |
| Windows WPF EXE download | `microsoft/WPF-Samples` at `811d01e95c8c929e68539d698d0a0609e94fd185`, selected `Sample Applications/CalculatorDemo`: Linux .NET Windows targeting produces self-contained `win-x64` EXE and ZIP; real PE architecture, SHA-256 and download checked. Native execution, installer and release signing remain unverified. |
| Go CLI/binary | `charmbracelet/glow` at `8b0600fa445535b9c53194c0d4f7fe3cf700ef3e`: source producer supplies its packaging-only Dockerfile's executable, real console version scenario exits 0, archive download and fresh offline Ubuntu consumer execution. |
| Python package | `pypa/sampleproject` at `621e4974ca25ce531773def586ba3ed8e736b3fc`: automatic package delivery, original unit test, wheel/sdist/ZIP downloads and fresh offline consumer install/import/function check. |
| npm package | `jonschlinkert/is-number`, exact commit in its report: automatic adapter, original Mocha suite with **111 passing**, real TGZ/ZIP, verified downloads and fresh offline consumer install with four independent value checks. |
| Web application | Earlier `skoulasp/todo-app` at `3935a0a247a43bb5e583f522b2ae27448acdad29` qualification passed production routing and create/complete/reload-persist/delete workflow. It was not rerun in this follow-up. |

The WPF EXE is 139,718,780 bytes with SHA-256
`c2e4c72d2a5b19e5b6bd3884794c88fed2de7c790bafc6059c3d4868c39b6573`.
Android signing used disposable test identities, not production publisher keys.

## Real AI healing and privacy

The real configured provider repaired the pinned Tk calculator's deliberately
incorrect `missing.py` entrypoint. Independent acceptance checked the corrected
entrypoint and preservation of original application/build inputs. Its exact
rebuild passed actual runtime/routing checks; the incident reached `healed` on
attempt 1. Routed interaction on the healed release displayed `42`.

The fixture's private environment value was absent from stored model conversation
content and metadata. Project, environment, branch and environment key names are
available to the model; execution resolves values privately.

Earlier failed recovery evidence remains. A known incompatible hosted vision
model had failed native function calling before tools; admission now resolves
the configured compatible planner or reports a prerequisite. Configuration
repair had also been incorrectly gated as new product development. It now uses
a narrow check preserving original source/tests and requires a real deployment.

## Implementation changes

- Selected project roots avoid repeated scanning of unrelated monorepo projects.
- GUI/CLI/Python/npm package discovery retains each category's real delivery.
- A narrowly recognized Go packaging Dockerfile gains its source producer; the
  original runtime recipe is retained. Complex custom recipes stay authoritative.
- Gradle/JDK compatibility is checked before native builds. CRLF/mode-lost
  wrappers use temporary normalized copies while preserving original bytes.
- Exact Gradle releases download with progress and checksum verification using
  the repository pin or official HTTPS release checksum for older wrappers.
  Integrity errors are not replayed as network failures.
- Mutable Gradle and new Go adapter caches are project-scoped and exclusively
  mounted. This fixes concurrent Gradle journal lock timeouts.
- Android signing runs in a fresh SDK stage containing outputs and trusted
  helpers, with networking disabled and no repository scripts. Signing inputs
  stay out of artifact runtime environments and logs; both were checked.
- Export validation inspects archive/PE bytes and rejects private files, path
  escapes, links and excessive output sizes. Real ecosystem files download
  directly alongside bundles, with digest metadata.
- Finite CLI scenarios may pass an explicitly asserted successful exit.
- Compose's JVM native-library cache is writable for its unprivileged runtime.
- A repaired generated Python GUI entrypoint refreshes its runtime command.
- Startup crash loops fail promptly with original logs instead of timing out.
- Windows SSH testing and fixed encoded PowerShell SDK discovery are added,
  with Settings guidance and persisted capability display. This does not enroll
  a native Windows build worker; see [Windows setup](windows-connection-setup.md).

## Source failure retained

`npm/init-package-json` failed its original `npm test` posttest/lint chain on
template-oss repository maintenance checks. A separate isolated Node 22.22.2
container with the unchanged checkout **and Git metadata** fails the same checks.
StackPilot did not disable those checks. Both failures remain in evidence.

## Verification and local evidence

Executed suites: **237 deployment tests, 39 agent team tests, 16 execution-profile
tests, 3 model-admission tests and 220 C++ tests**. Frontend type checking and
production builds are separate from sample delivery qualification. A fixed
PowerShell capability probe executed successfully on Windows; this read-only
check did not execute a third-party application on the host.

Ignored `tests/artifacts/` contains the original failures, retries, downloads and
actual viewer screenshots:

- `github-adapter-qualification.json` and `github-adapter-retry-*.json`.
- `github-additional-android-signed-apk.json`,
  `github-additional-android-signed-aab.json`,
  `github-additional-package-npm-consumer.json`.
- `github-android-signed-workflow.json` and the authenticated native PNG.
- `github-real-healing.json`, earlier failed `github-real-healing-*.json`, and
  `github-healed-desktop-calculator.png`.
- Desktop workflow reports distinguish automation, frame capture, visual review
  and clipboard coverage. The AAB report separates executor timing from the
  interrupted observer's elapsed time.

Fixture accounts/projects are cleaned only after their jobs/repairs finish;
downloads/source clones/logs are retained locally. The user's original deployed
application is preserved.

## Remaining work

The [technology gap audit](technology-coverage-gap-audit-2026-10-13.md) remains
the full backlog. Significant unfinished items are:

1. Native Windows worker enrollment/scheduling, source execution, artifact return,
   installers/signing and interactive GUI acceptance. The user has an isolated
   VM; its SSH connection still needs configuring.
2. macOS/iOS worker and native packaging/signing/export. No Mac is available and
   a generic Apple worker has not been implemented.
3. Dedicated Flutter, managed Expo, Electron/Tauri/Qt and other native packaging
   adapters with actual representative builds. Android JS native-root planning
   exists but is not yet qualified on React Native/Capacitor source.
4. Durable artifact DB/API/storage independent of a running container,
   multi-target build graphs, enrollment and fleet scheduling.
5. Production tenant/cache/network isolation across every adapter, recovery,
   load/security tests, signing/publication and the supported SDK/OS/arch matrix.
6. Dedicated serverless/edge, game, GPU/data, extension, WASM/embedded and other
   specialized adapters. Generic recipes are a foundation, not qualification.

Primary references: [.NET Windows targeting](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#enablewindowstargeting),
[Android signing](https://developer.android.com/build/building-cmdline#sign_cmdline),
[Android JDKs](https://developer.android.com/build/jdks),
[Gradle wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html),
[Gradle compatibility](https://docs.gradle.org/current/userguide/compatibility.html).
