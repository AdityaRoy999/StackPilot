# Phone remote-link recovery — 14 October 2026

The phone access link was unavailable for several independent reasons:

- Docker Desktop was down. Startup failed while renaming a stale AF_UNIX socket in its local secrets-engine runtime directory. The directory contained only a zero-byte socket. It was preserved under a recovery name and Docker Desktop restarted successfully. No factory reset was performed. This is the failure described in [Docker's Windows issue tracker](https://github.com/docker/for-win/issues/15064).
- The phone gateway and managed tunnel containers were absent. The Remote Compose profile was created and started, using the existing authenticated gateway configuration.
- A subsequent tunnel had lost its Cloudflare registration. Logs reported `Unauthorized: Tunnel not found`, and public DNS returned NXDOMAIN. Replacing that connection yielded a new reachable HTTPS endpoint.
- The desktop Remote page initialized its address only when empty, so a tunnel rotation could retain an obsolete hostname. It also had no direct reconnect action.

The Remote page now follows managed address changes, clears an obsolete pairing QR, preserves a user-entered custom HTTPS gateway, and binds each pairing to the origin it was created for. A response from an older access poll cannot overwrite a newer access action. A pairing response that arrives after an address change is discarded. Pairing is disabled while the host cannot be reached.

**Reconnect link** explicitly stops and starts the managed tunnel through the existing authenticated API, then waits for the normal refresh to discover its new address. A custom address remains under the user's control. Temporary Cloudflare links may change after reconnection; create a fresh QR on the desktop rather than reuse an old link.

Verification:

- Frontend type check, targeted lint, and production Docker build passed.
- `tests/integration/remote_link_rotation_ui.mjs` passed rotation, QR invalidation, custom-address preservation, reconnect, and stopped-tunnel behavior with intercepted fixture APIs.
- `tests/integration/remote_link_public_probe.mjs` reached the real HTTPS phone page in a 390×844 browser, with interactive JavaScript, no failed requests, and no page errors.
- Full authenticated phone qualification passed pairing/approval and secure-cookie navigation, 13 dashboard routes at 390×844 without horizontal overflow or runtime errors, fixture project/settings operations, private-route protection, live browser frames, and revocation closing an active logs socket. Results are retained under `tests/artifacts/remote-link-live-2026-10-14.json`. The qualification used disposable identities and no AI model calls; its fixture records were cleaned afterward. An initial live run timed out at page bootstrap; the repeat after frontend rollout passed.

User workflow: refresh the desktop dashboard, open **Remote → Connect remote device**, use **Reconnect link** if necessary, then choose **Pair a phone**. Scan the new QR and approve the matching code on the desktop. The desktop host and Docker must remain running.
