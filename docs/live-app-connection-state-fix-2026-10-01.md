# Live App stayed on Connecting after the socket opened

The screenshot's loading overlay came from a frontend state bug. The FPS
telemetry effect depended on `connected` and also set it to `false` whenever
that effect ran. A successful WebSocket connection set `connected` to `true`,
which reran the telemetry effect and immediately restored the loading overlay.
The socket continued receiving the website's title and video behind that overlay.

Connection and error state now reset only when starting a viewer connection,
changing sessions/modes, reopening it, or explicitly retrying. The independent
FPS timer measures presentation without changing connection state.

The failure was reproduced through the actual `/dashboard/ai` UI with a
disposable account, saved chat, owner capability, and the selected website
`https://adityaroy-two.vercel.app/`. After the change, the loading overlay went
away, the website appeared, and the Live/WebRTC badge was visible. Closing and
reopening Live App reconnected to the same website successfully. The running
frontend compiled the fix through its development watcher; the AI service did
not need another restart.

Validation:

- The new component regression opens a socket, checks that telemetry does not
  reset the Live state, and confirms an actual socket close shows Connecting.
- Both component tests pass, including authorization failure and Retry.
- All 19 focused video, peer, page-state, and saved-session checks pass.
- TypeScript checking (`npx tsc --noEmit --pretty false`) passes.
- Screenshot: `screenshots/live-app-viewer-fixed-2026-10-01.jpg`.
- The two owned browser contexts and the fixture account were removed. The
  preexisting user browser tab was preserved. No user chat/project was deleted.

This check establishes visible loading and reconnection on that website. The
background diagnostic browser's observed FPS does not establish smooth frame
pacing or general website test coverage.
