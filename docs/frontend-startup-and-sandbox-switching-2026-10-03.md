# Frontend startup and current-chat browser switching

The normal local stack now serves a compiled production frontend at
`http://localhost:3000`. Navigation does not trigger Next.js compilation.

## Why startup and navigation were slow

The previous container ran `next dev --webpack` over a Windows/OneDrive source
bind mount. Cold routes took roughly one to four minutes to compile, and health
requests queued behind that work. Google Fonts downloads also timed out during
compilation. The previous health command returned success even when the request
failed.

The base Compose service now builds the standalone production runner, removes
the source bind mount, bundles the existing Plus Jakarta Sans and JetBrains Mono
fonts locally with their licenses, and reports health failures correctly. Builds
still consume CPU and take minutes on this shared four-core Docker machine;
that work happens before the new frontend replaces the running container.

The backend container was also found in the `Created` state and was started.
It now responds on port 8090; otherwise project queries and browser-ticket
authorization would fail regardless of frontend performance.

Rebuild after source changes:

```powershell
docker compose build frontend
docker compose up -d --no-deps frontend
```

For active frontend development with hot reload:

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build --watch frontend
```

This explicit development override uses Turbopack and syncs edits into Docker's
Linux filesystem. It retains development compilation; use the base production
runner for normal platform use and navigation benchmarks. Public frontend
environment variables are supplied at image build time.

## Browser settings apply to the current chat

Local, Remote and Host Chrome now request an authenticated worker change for the
current chat. The selector highlights the requested choice immediately and shows
connection progress. The confirmed setting and live viewer change after the
replacement worker connects and opens the current URL. The chat ID is unchanged.

The old implementation changed the selector locally but refused changing a chat
that already owned a browser session. This caused website testing setup failures.
The new settings protocol stops any active run before swapping the owned browser
context. Other chats keep their contexts. An unavailable or unconfigured worker
reports an error and preserves the previous browser. Ordinary connection errors
now display their actual message instead of a generic fallback.

Host Chrome was configured and started using a dedicated local Chrome profile
and authenticated worker. It does not attach to a personal browser profile. Its
hidden worker process needs restarting after Windows restarts; see
[host worker setup](../native-browser/README.md).

Worker switching opens an isolated context on the selected machine and preserves
the URL, not cookies, logins or unsaved form state. A remote worker must have
network access to that URL; a Windows loopback service is not automatically
reachable from EC2.

## Verification

- Production builds passed TypeScript checks and generated the frontend routes.
- Five frontend protocol tests passed; backend switching, configuration,
  authorization and run-state tests passed.
- Real Local → Remote → Host → Local switching kept one chat and preserved the
  fixture URL. Measured connection times were 3.633 s, 2.425 s, 3.157 s and
  7.911 s. All owned contexts were cleaned up. See
  [worker qualification](browser-sandbox-switch-qualification-2026-10-03.json).
- The deployed production UI passed selector/viewer binding for all three modes,
  kept the same chat ID, displayed the failed-worker error and retained the old
  selection. No JavaScript exceptions were observed. With warmed browser assets,
  the fixture rendered Projects in 1.147 s, first entered AI in 0.614 s, returned
  to Projects in 0.296 s and re-entered AI in 0.042 s. API responses and viewer
  sockets were synthetic in this UI check; actual worker connections were
  verified separately. See
  [UI qualification](frontend-startup-qualification-2026-10-03.json).
- HTTP checks covered 21 routes after deployment. Every route returned 200 or
  its expected alias redirect (307). Warm core dashboard responses measured
  10–26 ms; the appearance page reached 302 ms, and auth pages reached 212 ms.
  These are HTTP response times, not full browser rendering. See
  [route qualification](frontend-routes-qualification-2026-10-03.json).

These checks do not qualify arbitrary websites or visible 60 FPS streaming.
