# Runtime metrics and portable desktop qualification — 2026-09-28

The metrics panel used gigabytes for every memory reading, rounding a roughly
5 MiB web container to 0.00 GB. Its memory chart let the chart library choose a
tiny automatic domain with long decimals. It also substituted zero for missing
values and inserted synthetic history points.

The panel now formats binary units adaptively, samples completed responses,
shows receipt times, uses readable bounded axes, and preserves unavailable gaps.
Network and disk cards explicitly describe cumulative counters. GPU/temperature
fields distinguish measured zero from unavailable host telemetry. Requests have
cancellation, bounded retry and an error/stale-data notice.

The backend previously executed Docker polling on its event loop. Metrics now
run on the bounded blocking pool. Eight concurrent real API metric calls left
the health endpoint responsive at 19.97 ms on this PC. This is one local test,
not a production capacity benchmark.

Live qualification discovered Docker returns synthetic zero stats for stopped
containers. Named inspect records now determine sample availability and unit
readiness, including per-container health in Compose. Stopped runtime evidence
passed: unavailable CPU/memory and readiness 0/1. Unknown inspection no longer
invents running status. See `runtime-metrics-qualification.json` for API samples.

The dialog was opened with a disposable QA identity in the actual frontend.
Its live values and changing CPU curve were observed. Screenshots:
`screenshots/runtime-metrics-qualified.png` and
`screenshots/runtime-metrics-charts-qualified.png`.

Portable build recipes extend Linux toolchain support beyond framework names.
They execute declared argv, require declared tests when requested, verify real
outputs, refuse escaping/private exports and preserve executable file modes.
An actual Tk app was built into an immutable image, started non-root with quotas,
and clicked through noVNC. The native counter advanced. Qualification found two
startup compatibility errors: wmctrl missed an actually mapped Tk window, and
Debian websockify does not accept --listen. Mapped X client checks and supported
source-address syntax fix those errors. See `deployment-desktop-qualification.json`.

Validation: C++ build and 199 unit tests passed; all 36 deployment tests passed
on Linux; TypeScript passed; 3 metric formatting/scaling tests passed. Existing
deployment-page lint errors outside these changes still prevent a clean full-file
lint result. Native Android interactive streaming, Windows/macOS workers,
authenticated phone routing, every-framework qualification and full workflow
testing remain unfinished. A successful build is not proof of universal support.
