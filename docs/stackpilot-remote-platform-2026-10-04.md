# Full StackPilot platform on a paired phone

This replaces the chat-only Remote surface introduced on October 3. Pairing now opens `/dashboard`, with the same pages, account data, resource ownership checks, organization roles and controls as desktop. The phone renders StackPilot itself; projects and deployments continue running on the configured host.

## Connect

1. Open **Remote** above **Settings** on the computer.
2. Enable the managed secure link, or configure an HTTPS origin pointing to the Remote gateway.
3. Create a pairing QR code, scan it on the phone, and choose **Connect this phone**.
4. Approve the matching six-digit code on an already signed-in device.
5. The phone automatically opens the full dashboard. Its navigation button opens every sidebar section.

The host must remain running and reachable. Home-screen installation starts at `/remote` and includes the whole platform in its scope. Existing paired phones also enter the dashboard when they reopen their link. Dashboard deep links survive pairing.

## Available platform sections

Projects and project details; deployments and runtime controls; logs and monitoring; visualization; infrastructure and SSH connections; cluster builder; the full AI Agent and chat history; secrets; organizations and workspaces; Remote device management; settings, models, providers and appearance. The existing mobile drawer and responsive page layouts are reused.

APIs, logs and SSH WebSockets use the HTTPS gateway origin. Browser video retains the existing signed session ticket and server browser ownership checks. Local HTTP runtime links open in the host browser on the full AI page, rather than pointing at the phone's localhost. The preview studio and deployment preview dialogs render their runtime through that same authenticated browser on paired phones. Public HTTPS application links retain normal behavior.

## Background work and recovery

The shared AI dashboard submits phone requests as background jobs with unique request IDs. Existing model, project, deployment, sandbox and permission settings are forwarded. Sequence-numbered batches feed the same event handlers used by desktop SSE. Navigating away detaches the phone without cancelling the host job; **Stop** explicitly cancels it.

Returning to a chat restores host progress, the exact pending step approval, and follow-up questions. Completed replies remain in the normal chat history. Interrupted runs are not automatically replayed. The existing admission and request-ID deduplication checks remain enforced.

Cloudflare Quick Tunnels do not support SSE, so this transport polls persisted event batches while the AI producer continues on the host. Browser video and live logs use WebSockets. The implementation follows Caddy's [forward authentication](https://caddyserver.com/docs/caddyfile/directives/forward_auth) flow; authentication prechecks remove WebSocket upgrade headers before the actual upgrade is forwarded.

## Pairing and revocation

One-use pairing links expire after five minutes. A pending phone cannot access platform pages or account APIs. Approval creates a revocable device capability; only its hash is stored. The approved capability is also set in a Secure, HttpOnly cookie with its own name, so page navigation and socket upgrades work without issuing an unrestricted account JWT or overwriting desktop sign-in cookies.

Unauthorized responses are bound to the credential that sent the request. A delayed response from a revoked device cannot erase a newly paired credential. Pairing also pauses device polling until the connection request finishes, and discards responses for an older credential.

Disconnected browser sessions are reaped before worker capacity is checked. Viewed sessions and sessions running operations are protected. Capacity and attachment errors are sent to the viewer with a manual retry control, rather than silently disconnecting and leaving an endless spinner. Qualification explicitly closes its owned browser sessions as well as their Chrome contexts.

The gateway authenticates each private page/API request. Backend controllers then enforce the usual ownership and roles. Phones may manage their own account's Remote devices and link, as part of full platform access. Dashboard terminal and AI artifact tools use the same authenticated endpoint as desktop; internal tool names still require service authentication. Logging out on the phone disconnects that device. Revocation and account token invalidation block subsequent requests and close existing browser/log/SSH sockets. The raw CDP and AI service administration endpoints remain private.

The managed public link is disabled after qualification if it was disabled before qualification. No user projects or existing browser tabs are changed by the tests.

## Validation

- Backend integration: real pairing/approval, account settings and platform API access, tenant boundary, one-use/expired links, revocation and password invalidation, detached work, request deduplication, progress recovery, approvals and questions, no automatic action replay.
- Phone UI integration: pairing opens the full dashboard; every sidebar section is present; the shared AI page submits background requests, forwards one exact approval and restores a desktop question; no horizontal overflow or runtime exceptions.
- Real managed HTTPS link: 13 routes at a 390px phone viewport, secure HttpOnly pairing cookie, actual project create/edit, secret write/reveal/delete and preferences updates, mobile sidebar navigation, cookie-only API access, live log revocation and rendered browser video.
- Frontend production compilation and TypeScript; 28 targeted tests for transport, deep links, approvals, stale unauthorized responses, private runtime previews and browser viewer behavior. A separate worker capacity smoke test verifies disconnected slot recovery and protection of viewed/busy sessions.

Artifacts: `remote-platform-session-qualification-2026-10-04.json`, `remote-platform-live-qualification-2026-10-04.json`, and `remote-platform-ui-qualification-2026-10-04.json` in this directory. Testing uses isolated browser contexts and disposable account data. Physical iPhone/Android hardware was not used in qualification.
