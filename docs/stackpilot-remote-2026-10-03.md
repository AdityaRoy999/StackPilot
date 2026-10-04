> The phone-only chat surface described here was superseded on October 4. See [Full platform on your phone](stackpilot-remote-platform-2026-10-04.md) for the current implementation.

# StackPilot Remote

Implemented October 3, 2026. The desktop entry is **Remote**, immediately above
**Settings** in the sidebar. It opens `/dashboard/remote`; the phone surface is
`/remote`.

## Connect a phone

1. Open Remote on the signed-in desktop and choose **Enable remote link**.
2. Wait for the secure host address, then choose **Pair a phone**.
3. Scan the QR code with the phone camera and request a connection.
4. Compare the six-digit code on both devices and approve the phone on the desktop.
5. Open an existing chat or start one. Add the page to the phone's Home Screen
   using the browser's install/share menu if desired.

Keep the host awake with StackPilot running. Turning off the managed link removes
external connectivity; a device can also be disconnected individually. A managed
temporary hostname changes when the tunnel restarts. Open its new `/remote` address
and pair again because browser storage belongs to the old origin.

## Working behavior

- The phone uses the same account, projects, deployments, chat history and AI
  service as the desktop. New desktop runs appear in an already-open phone chat.
- Fast/Thinking mode, project/deployment selection, website targets and current
  browser sandbox are available. Sandbox changes use the existing authenticated
  browser settings channel and require worker confirmation.
- The live browser uses the existing video, cursor and takeover component through
  the scoped remote gateway. WebSocket video remains available when a direct
  WebRTC connection cannot be established. FPS depends on the worker, decoder,
  network and website; Remote does not promise 60 FPS.
- A phone request gets an immediate run ID. The existing backend producer
  continues when the phone locks, disconnects or closes the page. Explicit Stop
  requests cancellation through the existing AI service.
- Sequence-numbered progress is stored in PostgreSQL. Reconnecting resumes from
  the last observed event. Overlapping batches do not duplicate content or
  approvals; saved final messages and live progress are deduplicated by run ID.
- Critical steps use an explicit approval token for the presented step. Phone
  requests force permission mode **ask**. Follow-up questions can be answered
  from the phone. Deny/Stop cancels pending approval or input.
- Ambiguous delivery offers **Retry same request**, using the same request UUID
  and payload. The backend returns the existing run, or rejects a conflicting
  payload. It does not automatically replay browser or infrastructure actions.
- A backend restart marks abandoned active runs **interrupted**. It does not
  restart their actions automatically. At most two active background requests
  are admitted globally; the existing service has its own execution controls too.

This is an installable web surface. Native app-store packages, push notifications,
offline execution and host wake-on-demand are not included. Physical iPhone and
Android hardware have not been qualified yet.

## Access boundaries

Pairing links contain a random 256-bit secret in the URL fragment, expire after
five minutes and can be claimed once. The fragment is removed from browser
history after the phone reads it. Every claim still needs desktop confirmation.

Phone tokens are independent random capabilities stored on that phone's origin;
only their SHA-256 hashes are stored in PostgreSQL. Approved devices expire after
30 days and are checked against account token invalidation. Revocation closes
an existing browser viewer and rejects its next API request or old browser ticket.

The gateway exposes the phone UI/static assets, a narrowly allowlisted phone API
and signed browser WebSockets. It rejects dashboard/login/administration routes,
raw CDP, general platform APIs and provider configuration. Browser tickets are
short-lived and bound to the user, chat and phone device. Browser screenshots are
excluded recursively from saved progress; video has its own transport. The
service worker does not cache tokens, chats, API replies, video or approvals.

## Docker and HTTPS

The Remote profile adds a restricted Caddy gateway bound to **127.0.0.1:8094** and
an outbound Cloudflare tunnel. Existing backend, frontend and AI services must
already be running with the latest images/migrations.

```powershell
docker compose --profile remote build remote-gateway
docker compose --profile remote up -d --no-deps remote-gateway
docker compose --profile remote create remote-tunnel
```

The last command creates the managed tunnel without starting it. The desktop
Enable/Turn off buttons start/stop that fixed container. They cannot supply
arbitrary shell commands. No router port forwarding or public backend/CDP port is
needed. Both regular and production Compose files contain this profile.

For a stable address, route your own HTTPS endpoint or a named tunnel to the
Remote gateway and enter that origin in **Secure host address**. Do not route the
general frontend/backend directly to that address. The managed accountless link
is intended for testing; [Cloudflare's Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
describes its availability limits and lack of SSE support. Phone progress uses
JSON polling rather than SSE. The initial edge connection can take a few seconds
after a hostname is issued.

## Qualification evidence

- `remote_session_smoke.py`: disposable database, backend and model fixture;
  one-use/expired links, confirmation and ownership, API scopes, detached
  completion, duplicate delivery, progress cursors, final history, approvals,
  follow-up questions, nested frame removal, interrupted state and revocation.
- `remote_browser_revocation_smoke.py`: real gateway/AI WebSocket; revocation
  closes an open viewer and rejects reconnecting with its old capability.
- `remote_phone_ui_smoke.py`: production mobile rendering in an owned Chromium
  context; sidebar placement, QR, approval, chat submission, desktop handoff,
  question answers, runtime errors and horizontal overflow at 390 × 844.
- `remote_gateway_live_smoke.py`: actual managed HTTPS relay, pairing/API,
  mobile UI and authenticated live video. Private routes returned 404. The test
  restores the tunnel's original state and removes only its disposable account
  and owned browser contexts. It makes no provider calls.
- Frontend reconnect/sandbox/stream unit tests, TypeScript and production builds.

Results are in the corresponding `remote-*-qualification-2026-10-03.json` files,
`remote-browser-revocation-2026-10-03.json`, and `stackpilot-remote-phone.png`.
The live HTTPS qualification used a mobile-sized Chromium viewer, not a physical
phone or an external carrier network.
