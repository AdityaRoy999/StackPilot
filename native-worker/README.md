# Local Android worker

This Windows development worker uses a dedicated StackPilot AVD and the installed Android SDK. Linux Docker builds the actual Gradle APK; the host worker downloads only an allocated local runtime artifact, checks its size/SHA-256, installs on its emulator, resolves and launches the real activity, checks foreground/UI state, and executes declared native workflows. No repository build scripts run directly on the Windows host.

Install an Android SDK, platform tools, emulator and x86_64 system image. The currently qualified PC uses WHPX. Then:

```powershell
python -m pip install -r native-worker/requirements.txt
./native-worker/start.ps1
```

The launcher reads `STACKPILOT_AI_SERVICE_TOKEN` from the repository `.env` without printing it, creates only the `stackpilot-local` AVD under `%LOCALAPPDATA%\StackPilot\android-avds`, and uses `emulator-5580`. It does not modify other user AVDs. Configure `STACKPILOT_ANDROID_WORKER_URL=http://host.docker.internal:8077` for the AI service and restart that service after changing configuration. The worker binds to host loopback. `restart.ps1` stops only Python processes whose command line names this exact worker script, then restarts it. Run a single copy.

The APK deployment contract is:

```json
{
  "workload": "android",
  "app_id": "dev.example.application",
  "tests_required": true,
  "native_preview_required": true,
  "native_scenarios": [{
    "name": "Submit a native form",
    "steps": [
      {"action": "input", "selector": {"description": "Recipient"}, "value": "Alice"},
      {"action": "key", "key": "BACK"},
      {"action": "tap", "selector": {"description": "Submit"}},
      {"action": "assert", "expectations": [{"text": "Hello Alice"}]}
    ]
  }]
}
```

Native selectors match UI Automator resource ID, text or content description uniquely. Actions include tap, bounded ASCII input, swipe, key and final outcome assertion. ADB ASCII input is not a general Unicode/IME adapter. A missing worker blocks a required native preview; an artifact portal alone does not prove native execution. A declaration without scenarios proves launch/UI presence only.

Authenticated internal endpoints are `/capabilities`, `/verify`, `/observe/{deployment}` and `POST /release/{deployment}`. Public preview/frame connections require a short-lived backend-signed deployment capability, with separate view/control permission. The internal service key never goes to the preview client. Reopening preview obtains a fresh capability after expiry. An observation checks foreground ownership without reinstalling or rerunning release workflows. Project/deployment deletion releases only the matching owned native app and prevents existing tickets from continuing to stream its screen; worker cleanup failure retains the deployment record for retry.

State under `%LOCALAPPDATA%\StackPilot\native-worker` records installed owned packages, APK bytes, launch screenshots/results and the active release. Restart recovery requires an owned package, matching APK digest and foreground app. A worker failure does not make an arbitrary installed app a verified release. Only packages installed by this worker may be uninstalled/replaced; an unknown existing app ID blocks the operation. Verification clears app data and replaces the previous active app on this single development emulator.

Qualification commands:

```powershell
python -m unittest discover -s native-worker -p 'test_*.py' -v
python tests/integration/android_pipeline_smoke.py --restart-worker
```

The integration test creates disposable project/source/user fixtures, builds through public platform APIs, executes a real native form and checks an authenticated PNG frame plus restart recovery. By default it retains the fixture for inspection; add `--cleanup-project` to qualify native cleanup and revocation of already-issued preview capabilities. Its IDs/evidence are written to `tests/artifacts/android-pipeline-qualification.json`. It makes no model calls. Cached dependency builds can still take minutes.

Limits: one active local device/release, no hostile-tenant isolation, no release signing/Play publication, no generic native Windows/macOS/iOS executor, and no general native React Native/Flutter guarantee. PNG captures show the actual device but are not a qualified 60 FPS video implementation. Production needs isolated emulator workers, scheduling, authenticated reachable routing, a video encoder/transport and measured device/stream SLOs. Old APK/state retention also needs a bounded GC policy.
