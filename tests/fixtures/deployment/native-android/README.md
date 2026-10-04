# Native Android qualification fixture

A real Java Activity and JUnit test using AGP 8.13.0, Gradle 8.13 and compileSdk 35. The official Gradle wrapper distribution has a SHA-256 pin. This fixture qualifies compilation, unit-test execution, lint, signed debug APK verification and artifact delivery. It does not qualify installation, device workflows or signed production release.

Generate the current build plan before building; generated helpers are deliberately ignored:

```sh
python deployment-runtime/planner.py tests/fixtures/deployment/native-android --archetype native_android
docker build -t stackpilot-native-qualification tests/fixtures/deployment/native-android
docker run --rm -p 127.0.0.1:8099:3000 stackpilot-native-qualification
```

The download preview is at `/`; artifact inventory is at `/healthz`. SDK and Gradle dependency caches make subsequent builds faster; a first build requires network access and cannot be a two-second operation.
