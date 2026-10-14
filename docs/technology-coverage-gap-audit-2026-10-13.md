# Production technology coverage: concrete gap audit

Reviewed 13 October 2026 against the current working tree and the primary
toolchain documentation linked below. This assessment defines development
work; it does not implement the adapters or claim their qualification.

## Accepted product scope

The goal is broad production support for technology families and application
categories. The user owns unfinished product functionality. StackPilot owns
correct source selection, toolchains, builds, environment linking, verification
of the requested delivery, packaging, distribution and operational reliability.
Deployment repair may fix source/configuration failures within that task; the
platform does not need to invent or finish every missing product feature.

Categories must keep their delivery type:

- Web applications and APIs: deployed runtime and reachable URL.
- Android: APK for installation/download and AAB for the selected distribution
  workflow, with appropriate signing and separately recorded device evidence.
- Windows desktop: executable/installer plus required dependency files.
- macOS desktop: application bundle and selected DMG/PKG/ZIP distribution.
- Linux desktop: executable bundle and selected AppImage/DEB/RPM/archive.
- CLI: binaries/packages for selected operating systems and architectures.
- Workers/jobs/services: supervised processes or scheduled execution.
- Libraries/SDKs/extensions: the ecosystem's actual package.
- Additional families: serverless/edge, games, data/ML, WASM and embedded targets
  use their own build/output/run adapters.

Coverage is a versioned catalog of `(category, technology family, SDK version
range, target OS, target architecture, artifact kind, delivery mode)` entries.
100% of a declared catalog is measurable. Every technology/version ever created
is an open-ended set; extending the catalog must not require pretending that
unknown stacks passed. Distinguish source failure, missing user input, unavailable
configured worker, unsupported target, platform defect and verification failure.

## Evidence: limitations actually present in this repository

| Evidence in current source | Concrete missing capability |
| --- | --- |
| `deployment-runtime/planner.py`: workload vocabulary and `requires_worker` for Windows/macOS/iOS | No general broker selecting matching OS builders, packagers and verifiers. Categories, target OS and delivery mode are coupled. |
| `src/services/BuildService.cpp`: native `requires_worker` results fail; remote target does the same | Windows/macOS/iOS contract recognition is not executable native delivery. |
| `deployment-runtime/native_build.py`: Android defaults to `assembleDebug`, finds only APKs; desktop finds one executable uber/fat JAR | No general AAB/release-signing lane or Windows/macOS/Linux installer packaging matrix. |
| `deployment-runtime/sdk_prepare.py`: SDK extraction uses literal compileSdk/buildTools regexes | Android SDK/JDK/AGP/NDK selection needs resolved metadata, catalogs, flavors and per-project compatibility handling. |
| `src/services/BuildService.cpp`: Expo/React Native generates `expo export --platform web`; Flutter generates `flutter build web --release` | Built-in web preview generators exist, but native requested targets are not preserved through dedicated mobile adapters. Bare React Native is also routed toward Expo. |
| `src/services/BuildService.cpp`: broad .NET detection describes an ASP.NET web application; Windows detection starts with existing EXE/MSI files | Missing desktop classification for WPF/WinForms/WinUI/MAUI/Avalonia and source-build packaging selection. Electron/Tauri/Qt also lack dedicated delivery adapters. |
| `deployment-runtime/artifact_server.py`: immutable inventory/download server with a fixed extension set | Serving EXE/AAB files is already possible, but generating, verifying and retaining those outputs is not. IPA/PKG/RPM/MSIX/VSIX/NuGet/AAR/WASM/firmware and unwrapped CLI binaries need typed output support. |
| `deployment-runtime/portable_build.py`: explicit Linux recipes export `application.zip` | Useful generic fallback; missing native package metadata, direct ecosystem artifacts and target build matrices. |
| `src/services/BuildService.cpp`: automatic JS/Python library labels are non-deployable | Explicit package recipes exist, but automatic library delivery should select packaging rather than demand a web server. |
| `deployment-runtime/linux_recipes.py`, `compiled_build.py`, `repository_toolchains.py` | Built-in deterministic families are Node, Python, Go, Rust, Java, .NET, Ruby, PHP. Missing dedicated selectors/builders for additional families and specialized server packaging. |
| `repository_toolchains.py`: Bun acceptance requires an explicit tested image; Python install mainly uses pip | Bun runtime/acceptance and uv/Poetry/PDM/Pipenv/Conda dependency workflows need consistent adapters, beyond manifest/version detection. |
| `deployment-runtime/repository_plan.py`: rejects declared component state and mixed native components; per-service secrets rejected | Missing data migration/backup executor, cross-platform component orchestration and component build-secret transport. |
| `src/services/BuildService.cpp`: remote Compose and remote/Compose build secrets are refused | These paths need qualified isolation, routing, private-input and recovery adapters; removing guards alone is not implementation. |
| `deployment-runtime/sandbox_capabilities.py`: local Linux Docker executor and observed host architecture; GPU/native OS claims excluded | Missing Windows/macOS/architecture/GPU/device fleet admission and scheduling. Configuration strings cannot provide absent hardware. |
| `native-worker/android_worker.py`, README: one owned development emulator, ASCII input, latest PNG frames, no production tenant isolation | Device fleet, production routing, stronger input/assertions, resource scheduling and retention are missing. The configured worker was unreachable in the earlier read-only check. |
| `src/controllers/DeploymentController.h`: deployment/log/runtime endpoints; artifact outputs embedded in runtime snapshots | No dedicated durable release-output API/data model covering multiple target artifacts, signed downloads and publication attempts. Source artifact upload exists and is a different feature. |
| Organization/auth/AI paths documented in the preceding organization review | Permission consistency, verified invitation onboarding and organization ownership/policies remain production prerequisites. |

## Category and technology catalog to develop

Status below describes platform adapters, not whether an arbitrary repository
can be made to compile. An explicit Dockerfile/custom Linux recipe remains a
useful fallback for many unlisted frameworks.

| Category / technology families | Required delivery | Present foundation | Actual remaining adapter work |
| --- | --- | --- | --- |
| Static HTML/CSS/JS; Astro, Hugo, Jekyll, Eleventy, MkDocs, Docusaurus | Compiled site + URL | Static/Node recipes | Non-Node generators, exact output discovery, routing/base-path qualification. |
| React/Vite, Vue, Angular, Svelte, Solid, Preact | SPA + URL | Node/static builds | Versioned compatibility fixtures, asset/base-path/SPA/browser checks. |
| Next.js, Nuxt, SvelteKit, Remix/React Router, Astro SSR | Server/static target chosen from source + URL | Generic Node server recipes and selected framework handling | Runtime-specific output/adapter detection, prerender/SSR/serverless distinction, streaming/image/auth/runtime qualification. |
| Node APIs: Express, Fastify, NestJS, Koa, Hono; Bun/Deno apps | Service + URL | Node scripts/process path; partial Bun package-manager handling | Bun/Deno SDK/runtime/acceptance; multi-process start and private package compatibility. |
| Python: Django, Flask, FastAPI, aiohttp, Streamlit, Gradio, Dash | Service + URL | Python detection/build/entrypoint | Dependency-manager adapters, server conventions, assets, migration hooks and declared app checks. |
| PHP: Laravel, Symfony, WordPress, Drupal, plain PHP | Web runtime + worker/cron where declared | Composer/explicit entrypoint | PHP extensions, FPM/web-server recipes, assets, document root, setup/migration/queue/cron separation. |
| Ruby/Rails, Sinatra | Web runtime + worker where declared | Bundler/explicit entrypoint | Versioned bundler, native gems, asset precompile, server and data-migration phases. |
| Java/Kotlin JVM: Spring Boot, Quarkus, Micronaut, Ktor, Jakarta/Tomcat | JAR/native binary/WAR service | Gradle/Maven executable-target path | WAR/application-server packaging, multiple modules/targets, native-image SDK and specialized runtime adapters. |
| .NET/ASP.NET/Blazor | Linux-compatible server/static output, or declared Windows runtime | .NET Linux publish path | Server/static/hybrid distinction, target framework/RID handling, legacy Windows-only execution. |
| Go; Rust APIs/CLI | Container or selected platform binary | Linux compiler paths | OS/arch artifact matrix, CGO/native dependencies, runtime ABI checks and distribution packages. |
| C/C++: CMake, Make, Meson, Bazel; Zig | Native service/binary/library | Custom Docker/recipe; CMake test discovery | Dedicated compiler/build-system discovery, target/toolchain files, library/dependency packaging and matching runtime verification. |
| Elixir/Erlang, Scala/Clojure, Swift server/CLI | Release bundle/service/binary | Custom recipe fallback | Mix/Rebar, sbt/Lein/deps.edn, SwiftPM SDK/build/output adapters and runtime dependency qualification. |
| R/Shiny/Plumber, Julia, scientific stacks | Service/job/package | Custom Linux recipe fallback | SDK/package lock/environment setup, system libraries and service/job conventions. |
| Full-stack/microservice repositories | App/API/workers with owned or externally linked dependencies | Local Compose and stateless graph | Data safety, per-service env/secrets, remote graphs, independent component qualification and atomic release/recovery. |
| Native Android Java/Kotlin/Compose | APK/AAB/AAR as selected | Gradle APK pipeline; optional local emulator | Release/profile/flavor/module/ABI selection, AAB/AAR, signing identities, resolved SDK/NDK and device matrix. |
| React Native bare; Expo | Native Android/iOS artifacts; web only when selected | Expo web preview | Native directory handling, Expo prebuild on isolated copy when necessary, JS/assets/native module builds, Android Gradle and iOS Xcode signing/packaging. |
| Flutter | Android/iOS/Windows/macOS/Linux/web target outputs | Flutter web preview | Pinned Flutter/Dart SDK, selected target/flavor, native plugin dependencies, APK/AAB/desktop/iOS package and verifier adapters. |
| Capacitor/Ionic; Cordova/NativeScript | Native Android/iOS artifacts + optional web output | Generic web fallback | Native project sync/build, plugin/toolchain compatibility, mobile signing and device validation. |
| .NET MAUI, Kotlin Multiplatform | Supported selected mobile/desktop targets | No dedicated target matrix | Workload/SDK compatibility, per-target projects/Gradle tasks, platform packaging and native verification. Do not invent targets unsupported by the framework. |
| Windows desktop: WPF, WinForms, WinUI; Electron, Tauri, Qt, Avalonia, Python GUI | EXE/MSI/MSIX or executable bundle | EXE recognition/download extension; no general native builder | Windows worker, framework-specific packaging, dependency inclusion, signing and installer/launch smoke checks. |
| macOS desktop: AppKit/SwiftUI; cross-platform desktop stacks | APP/DMG/PKG/ZIP | Contract only | macOS worker, SDKs, framework packagers, signing/notarization and bundle verification. |
| Linux desktop: Qt/GTK, Electron, Tauri, Flutter, Avalonia, Python GUI, Java/Kotlin GUI | Executable bundle/AppImage/DEB/RPM/archive | X11/noVNC/custom recipe and Compose Desktop JAR | Framework packaging, library/ABI/runtime inclusion, package/install checks; Wayland/headless/display requirements explicit. |
| Native iOS/iPadOS Swift/Obj-C/SwiftUI/UIKit | Simulator build or signed IPA/distribution archive | Detection/required-worker contract | macOS/Xcode scheme/configuration/archive/export, provisioning/entitlements, dependency tools and simulator/device acceptance. |
| CLI/TUI: Go, Rust, Python, Node, .NET, JVM, C/C++, Swift | OS/arch binaries/installable packages | Interactive console scenarios and Linux builds | Portable binaries, executable permissions, terminal/PTY fidelity, install/run checks and CLI artifact presentation. |
| Workers, daemons, batch/ETL, scheduled jobs | Supervised process or bounded/scheduled execution | Worker/job contracts | Scheduler, retry/idempotency, queue semantics, shutdown/restart policy, resource and output retention. |
| Libraries/SDKs: npm, Python, JVM, .NET, Rust, native/Swift | TGZ/wheel/sdist/JAR/AAR/NuGet/crate/library bundles | Explicit ZIP/package delivery | Ecosystem pack commands, metadata and consumer-install checks, version/release index and optional publication. |
| OCI images; deployment bundles/charts | Image by digest/manifest or deployable package | Local image builds/deployments | Authenticated registry export, multi-arch manifests, signing/provenance, tested Helm/deployment-package adapters. |
| Serverless/edge: Lambda, Azure Functions, Cloudflare Workers and compatible runtimes | Provider package/worker and optionally deployed endpoint | Generic ZIP/container fallback | Provider runtime/build contracts, emulation, binding/secrets, scoped credentials, deployment/status/rollback adapters. |
| Browser and IDE extensions/plugins | Extension ZIP/CRX/VSIX or ecosystem package | Generic ZIP delivery | Manifest validation, extension-host tests, typed artifacts/signing and optional marketplace publishing. |
| WebAssembly/WASI | WASM + assets or runnable module | Generic recipe fallback | Target SDK/module validation, browser versus WASI execution, imports/capabilities and distribution. |
| Games: Godot, Unity, Unreal; web games | Selected native/web/mobile exports | Generic web/archive delivery only | Engine/version/export presets, licensed tool prerequisites where applicable, assets, target packaging and graphics-capable verification. |
| ML/inference/data/notebooks | CPU/GPU service/job/notebook with declared model/data inputs | CPU Linux recipes/external providers | GPU capability runners, model/data artifact management, driver/runtime compatibility, notebook access/verification and data-volume policies. |
| Embedded/IoT/firmware | BIN/HEX/ELF/UF2 or vendor image | Generic explicit recipe only | Board/toolchain SDK, cross-compile/output checks, signing where applicable, optional owned device flash/simulator tests. |
| Special OS/device families: BSD/RTOS, watch/TV, drivers, FPGA/vendor SDKs | Target-specific outputs | No dedicated adapter | Explicit catalog entry and matching SDK/worker/simulator/hardware. Mark prerequisites instead of presenting Linux execution as proof. |

This is a proposed broad catalog, not a claim that all those adapters exist.
Supported version/OS/architecture combinations must be published for each family.

## Engineering backlog with completion evidence

### Shared delivery architecture

| ID | Concrete development item | Complete when |
| --- | --- | --- |
| T01 | Versioned technology adapter registry: detect, resolve SDK, build, test, package, sign, verify, deliver; extension API for custom adapters | A new family can register an adapter without editing the central C++ generator chain; status comes from executed stage evidence. |
| T02 | Separate category, source component, target OS/arch, delivery mode, build profile and optional native preview | One repo can request Windows download and Linux runtime independently; Android is never silently replaced by web. Existing contracts migrate compatibly. |
| T03 | Explicit source/build authority and product-scope error classification | Supplied Dockerfiles/recipes remain authoritative; source defects, missing credentials and platform gaps have distinct actionable results. Missing product functionality is not invented as a deployment prerequisite. |
| T04 | Capability-based builder/verifier broker for Linux, Windows, macOS, ARM and device/GPU targets | Workers advertise observed SDK/hardware, receive leased jobs and selected capabilities, and fail/resume correctly when a matching worker is absent. |
| T05 | Multi-target build DAG, shared dependencies and per-target status | Partial target failures do not erase valid outputs or produce a false all-target success; source/commit/SDK provenance retained for every output. |
| T06 | SDK/package-manager compatibility and reproducibility | Pinned project toolchains, lockfiles, offline/private dependency prerequisites and clean/cached builds produce valid target outputs across the published matrix. |
| T07 | Job-scoped private build inputs and signing credentials for every worker/component/remote path | Secrets never enter model prompts/source archives/public builds; revocation, failed jobs and crash recovery remove temporary credential material. |
| T08 | First-class release outputs in DB/API/object storage | Multiple immutable artifacts have digest/size/type/OS/arch/version/commit/SDK/signature/evidence metadata and authorized resumable downloads independent of a live artifact container. |
| T09 | Typed artifact validation and publication states | APK/AAB/PE/installer/bundle/package/WASM/etc. checks inspect the actual format and dependencies; built, signed, tested, downloadable and published remain separate evidence states. |
| T10 | Category-aware dashboard/CLI/MCP | Users choose available targets and see Build/Deploy/Download/Install-preview/Publish as appropriate, with missing worker/credential reasons and real output links. |

### Technology-specific adapters

| ID | Concrete development item | Complete when |
| --- | --- | --- |
| T11 | Android production Gradle adapter | Selected module/flavor/profile produces APK/AAB or AAR, handles resolved SDK/JDK/NDK/ABI requirements, and verifies selected release-signing identity and installable outputs. |
| T12 | React Native/Expo native adapter | Bare RN uses its native projects; managed Expo has explicit native generation; Android JS/native assets ship correctly and iOS uses its matching worker. Web remains a selected target. |
| T13 | Flutter target adapter | Declared SDK/flavor/plugin requirements generate Android/iOS/desktop/web outputs on matching builders with target checks. |
| T14 | Windows source-build and installer adapters | Electron/Tauri/.NET/Qt/Python/Java and declared generic native builds produce usable EXE/MSI/MSIX/bundles, with dependency/signature/install-launch evidence. |
| T15 | macOS build/package/sign adapter | Selected native/cross-platform source builds APP and requested DMG/PKG/ZIP; signing/notarization prerequisites and final verification are explicit. |
| T16 | iOS archive/export adapter | Xcode scheme/SDK/configuration/provisioning handles simulator versus device outputs; final export and install/test evidence match the requested distribution. |
| T17 | Linux desktop packaging adapter | Existing X11 preview remains optional; selected framework emits executable bundle/AppImage/DEB/RPM and verifies dependency/ABI/install behavior. |
| T18 | CLI binary/package matrix | Published target OS/arch/RID outputs install and execute declared console scenarios; rich TUI/PTY requirements use a matching verifier. |
| T19 | Ecosystem library/package adapters | npm/Python/JVM/.NET/Rust/native packages have correct metadata and install/import tests in an independent consumer before download/publication. |
| T20 | Additional Linux build families and dependency managers | Deno/Bun, uv/Poetry/PDM/Pipenv/Conda, CMake/Make/Meson/Bazel/Zig, BEAM, sbt/Clojure, SwiftPM, R/Julia have pinned build/output/acceptance paths. Generic recipes continue as fallback. |
| T21 | Hybrid/mobile/desktop families | Capacitor/Cordova/NativeScript/MAUI/KMP/Avalonia and similar catalog entries select supported native targets and package through platform-specific builders. |
| T22 | Specialized web/server adapters | SSG/SSR/serverless output, PHP-FPM/extensions, Rails assets, JVM WAR/native-image, authentication callbacks and streaming/uploads pass target fixtures. |
| T23 | Service topology and state adapter | Local/remote components have scoped env/secrets, readiness, hosted-service links, persistent volumes and data migration/backup/restore gates. |
| T24 | Scheduler/protocol execution adapters | Cron/event workers and jobs have durable scheduling/idempotency; TCP/gRPC and non-HTTP protocols get meaningful declared checks beyond connection success. |
| T25 | OCI/serverless/edge delivery adapters | Multi-arch registry outputs/provider packages use digest identity, bindings/secret refs, private credentials and target-specific deploy/rollback qualification. |
| T26 | Extension/WASM/game/embedded adapters | Each registered family emits its real ecosystem artifact and uses an applicable verifier; hardware/license/account absence returns precise prerequisites. |
| T27 | Data/ML/GPU adapters | Workers prove device/driver/SDK capability and enforce quotas; model/data storage and CPU/GPU outputs have matching run/verification evidence. |

### Production infrastructure and governance

| ID | Concrete development item | Complete when |
| --- | --- | --- |
| T28 | Disposable tenant isolation and worker enrollment | Untrusted builds cannot access another org, control-plane secrets/socket or unauthorized network/storage; worker compromise/revocation and teardown are qualified. |
| T29 | Fleet scheduling, resource limits and caches | Fair CPU/RAM/disk/device/concurrency admission, compatible isolated caches, capacity errors and queue backpressure pass load tests. |
| T30 | Durable retries/cancellation/reconciliation | Worker/control-plane restarts, provider/network outages, lost results and cancellation retain progress; consequential signing/publication/deploy actions are reconciled before replay. |
| T31 | Production network and web release operations | Reachable custom-domain/TLS/authenticated previews, verified route swaps, streaming/WebSocket/upload limits, graceful termination and remote rollback pass end-to-end tests. |
| T32 | Organization access and resource ownership | Viewer/admin/member policies apply consistently to AI/source/build/download/sign/publish; invitations are verified; resources and service identities have org ownership and scoped revocation. |
| T33 | Audit, secret lifecycle and supply-chain evidence | Org-visible audit/export/retention, signer identity, SBOM/provenance/scanning policies and secret rotation are recorded against immutable outputs. |
| T34 | Retention/backup/HA/upgrade operations | Output/cache/job/native-state GC, data backup/restore and control-plane restart/upgrade behavior satisfy declared recovery objectives. |
| T35 | Publication adapters and release channels | Optional stores/registries/release hosts use scoped credentials, distinguish uploaded from accepted/live, reconcile duplicate/version errors and retain rollback/channel metadata. Download-only builds do not require a store account. |
| T36 | Operator and user failure UX | Every failure identifies phase, category, target, reason, retryability and exact prerequisite; uploaded secrets are referenced by key only, and logs remain useful without secret leakage. |

### Qualification and support policy

| ID | Concrete development item | Complete when |
| --- | --- | --- |
| T37 | Versioned coverage catalog and regression suite | Each declared technology/SDK/OS/arch/output has representative clean/cached build, artifact/runtime, environment and recovery fixtures with published results. |
| T38 | Independent artifact/runtime acceptance | Test installers/binaries on clean matching targets; verify hosted apps through real routing. An extension/hash or running preview portal alone cannot establish application execution. |
| T39 | Capacity/security/recovery qualification | Queue/load limits, tenant boundaries, worker disconnect, disk exhaustion, failed migration, artifact corruption and expired credentials have reproducible expected outcomes. |
| T40 | SDK evolution and support lifecycle | Pin/version adapters, record upstream changes and support/EOL ranges, rerun target qualification before promoting SDK changes, and expose custom adapters for out-of-catalog stacks. |

These 40 backlog items combine new implementation and expansion/qualification of
existing partial paths. Their completion needs evidence, not a count of recognized
framework names. Source defects in a user's unfinished repository are recorded
separately from missing platform capability.

## Build/verification/publication contract

A requested Windows desktop release can follow:

1. Pin source/branch/commit and choose desktop + Windows + architecture + output.
2. Resolve the actual framework packager and matching builder.
3. Restore locked dependencies and execute the declared source checks.
4. Build release binaries and package required DLLs/resources/runtime.
5. Inject the signing identity privately when required and verify the result.
6. Store immutable installer/executable output and digest/provenance.
7. Run applicable installation/launch checks on a clean Windows verifier.
8. Expose authorized Download links; native streaming is optional.

The Android analogue selects the real Gradle module/flavor/task and APK/AAB,
builds with compatible SDKs, handles signing privately, validates the artifact,
and optionally uses the declared emulator/device verification stage. Signing
credentials are user/operator inputs. Platform support means the adapter can
consume them safely; it cannot invent a publisher identity.

Maintain separate stage results: `source_validated`, `build_passed`,
`tests_passed/not_configured`, `artifact_validated`, `signed/unsigned`,
`runtime_verified/not_requested`, `download_available`, and
`published/not_requested`. The precise data schema is implementation work, not
an existing API contract introduced by this document.

## Recommended implementation sequence

1. Shared category/target/output contracts, adapter registry, output API/storage,
   permissions and capability-based workers (T01-T10, T28, T32), with qualification
   fixtures established immediately (T37-T39).
2. Broad Linux web/API/worker/package/CLI coverage and dependency linking
   (T18-T20, T22-T24), plus native Android production Gradle (T11).
3. Windows downloadable desktop deliverables (T14), native Flutter/RN/hybrid
   targets (T12-T13, T21), Linux packaging (T17), then macOS/iOS (T15-T16) as
   matching workers become available. Grow scheduling and recovery concurrently.
4. Remaining serverless/edge/extension/game/WASM/embedded/GPU catalog entries
   (T25-T27), publication integrations (T35), and full production qualification
   and support lifecycle (T29-T34, T36-T40).

Matching native workers/hardware and signing/publication credentials are real
prerequisites. No cloud resources or spending were provisioned by this audit.

## Primary toolchain references

The implementation design above is our proposed architecture; these sources
establish the underlying toolchain/output constraints rather than StackPilot
support claims.

- Android has variant-specific Gradle APK/bundle tasks and different APK/bundle
  signing paths. [Android command-line builds](https://developer.android.com/build/building-cmdline).
- React Native's release Android build uses Gradle bundleRelease and includes
  JS/assets in the AAB. [React Native Android release](https://reactnative.dev/docs/signed-apk-android.html).
- Expo can generate native directories and build locally using Android/Xcode
  tooling. [Expo CLI](https://docs.expo.dev/more/expo-cli/), [local builds](https://docs.expo.dev/guides/local-app-overview/).
- Flutter target setup varies by platform; Windows builds require Windows,
  macOS/iOS require macOS. [Flutter platform integration](https://docs.flutter.dev/platform-integration), [deployment](https://docs.flutter.dev/deployment).
- Capacitor has separate native Android and Xcode/iOS projects. [Android](https://capacitorjs.com/docs/android), [iOS](https://capacitorjs.com/docs/ios).
- .NET MAUI has a defined mobile/desktop platform matrix and SDK requirements.
  [MAUI platforms](https://learn.microsoft.com/en-nz/dotnet/maui/supported-platforms?view=net-maui-11.0).
- .NET single-file outputs are OS/architecture-specific and may be self-contained.
  [Single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview).
- Electron Forge produces selected platform distributables through makers.
  [Electron Forge makers](https://www.electronforge.io/config/makers).
- Tauri supports Windows MSI/NSIS installers; MSI needs Windows, while NSIS cross
  compilation has additional requirements. [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/).
- Java jpackage creates platform-specific installers on the applicable platform.
  [jpackage](https://docs.oracle.com/en/java/javase/25/docs/specs/man/jpackage.html).
- PyInstaller requires the applicable OS for ordinary packaging; it is not a
  general cross-compiler. [PyInstaller](https://pyinstaller.org/en/latest/).
- Qt supplies dependency deployment helpers for Windows/macOS.
  [windeployqt](https://doc.qt.io/qt-6.10/windows-deployment.html), [macdeployqt](https://doc.qt.io/qt-6/macos-deployment.html).
- Xcode archive/export and signed distribution are distinct stages.
  [Apple distribution signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/), [distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).
- SwiftPM has a Linux/server build path separate from Apple UI applications.
  [Swift build system](https://www.swift.org/documentation/server/guides/building.html).
- Godot CLI exports require matching presets/templates; export credentials are
  separate private inputs. [Godot exports](https://docs.godotengine.org/en/latest/tutorials/export/exporting_projects.html).
- Multi-platform OCI outputs require an applicable builder strategy and target
  manifests. [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/).
- VS Code extension packaging/publication is its own workflow.
  [VS Code extension publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
