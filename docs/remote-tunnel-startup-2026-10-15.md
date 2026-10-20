# Phone tunnel startup — 15 October 2026

The Remote page previously coupled tunnel discovery to device/history requests
and polled at 3 seconds with the connection dialog open, or 30 seconds when idle.
Starting the container did not start a dedicated readiness check. Each status
request also launched several Docker CLI processes and extracted the hostname
from the last 60 log lines. Normal log activity could remove that address from
the response, while a historical registration message could misreport a broken
connection as healthy. Logs on this host also showed an expired registration
retrying `Unauthorized: Tunnel not found` after a network interruption.

## Changes

- `RemoteTunnelService` uses bounded Docker Engine requests over the existing
  private Unix socket. One lock serializes lifecycle changes; status observations
  are cached for 250 ms during startup and 1 second when ready.
- The current connector supplies its hostname through `/quicktunnel` and its
  connection count through `/ready`. Hostnames are restricted to Cloudflare's
  quick-tunnel domain before any public HTTP request. No log output or secrets
  are returned to the browser.
- Initial readiness also requires a successful public `/remote` response with
  the StackPilot phone-page marker. Subsequent healthy polls avoid this external
  round trip. Container replacement or restart invalidates the hostname and
  readiness cache.
- Initial public requests have a bounded 5-second deadline and retry failed DNS
  resolution through Cloudflare's HTTPS resolver within that same deadline.
  This avoids depending solely on a cached negative response for a new hostname.
- An expired registration triggers reconnection. An unready connector gets 25
  seconds to recover; an already registered connector gets 45 seconds for its
  public address to propagate before reconnecting with increasing backoff.
  Explicitly stopped containers remain off. Concurrent start requests reuse one
  connector, and reconnect is one serialized server action.
- The frontend checks tunnel status independently of device/history loading,
  immediately after lifecycle actions and every 500 ms while starting. Ready
  connections use the existing slower polling intervals. Pairing is disabled
  until the managed endpoint is ready; custom HTTPS addresses remain supported.
- Both Compose files retain enabled tunnels with `unless-stopped`, pin the
  metrics listener to private container port 20241, and bound log retention.
  The listener has no published host port or route through the phone gateway.
  Optional connectivity diagnostics are skipped; those diagnostics run in
  parallel upstream and were not the primary delay.

## Verification

The updated backend and frontend images were built and deployed locally.

| Check | Result |
| --- | --- |
| Lifecycle unit tests | 10 passed, including concurrent start, expiry, failed public readiness, stop, replacement and cache behavior |
| Frontend type check and targeted lint | Passed |
| Browser regression | Passed independent status loading, fast startup polling, readiness gating, QR invalidation, custom address preservation and reconnect |
| Final live start response | 210 ms |
| Final fresh tunnel to usable public phone page | 24,053 ms |
| Final explicit reconnect to usable public phone page | 9,410 ms |
| Five warm authenticated status responses | 3, 3, 3, 4, 14 ms |
| Public phone pairing and desktop approval | Passed with disposable identity; records removed afterward |
| Public mobile browser | Interactive HTTPS page, no failed requests or JavaScript errors |
| Unauthenticated tunnel management | Rejected with HTTP 401 |

These timings are one local qualification run, not a latency guarantee. A prior
run reached the public gateway in 8.2 seconds, while a slow DNS/edge case exposed
an unnecessarily early restart and took 40 seconds before the final adjustments.
The final slow-start test completed without rotating a registered connection.
A fresh
quick tunnel still needs Cloudflare to allocate a hostname and register an edge
connection. Keeping an enabled connector running removes that work when the
Remote page is reopened. Temporary hostnames change when the connector is
restarted; existing pairing links must be replaced after a rotation.

Upstream references: [quick tunnel behavior](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/),
[connector initialization and private metrics](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/cmd.go)
and [libcurl's HTTPS DNS resolution](https://curl.se/libcurl/c/CURLOPT_DOH_URL.html).
