# Project public tunnel repair — 15 October 2026

The deployment in the reported screenshot was healthy on internal port 8000,
published on loopback port 64345. Public exposure failed independently of the app.

## Causes

- The project endpoint used `cloudflared:latest`, although the phone tunnel had
  already cached the pinned image. An image pull and a log polling loop ran inside
  the HTTP request, exceeding the frontend's 25 second deadline.
- A transaction remained open during Docker and network operations.
- The selected draft exposure was displayed as the active exposure before any
  public address was confirmed. Local Docker also displayed Kubernetes replica text.
- The draft port could override the running container's actual published mapping.
- Named tunnel tokens were handled as if a temporary hostname would appear in
  their logs. Named tunnels instead need their configured HTTPS hostname.

## Implementation

`ProjectExposure` records a durable, encrypted connection request and returns
HTTP 202 immediately. Bounded background steps prepare the image, create or reuse
the owned connector, and verify connectivity. Pending work resumes after a backend
restart. The temporary hostname is saved for the connector's current generation;
Docker readiness plus an HTTPS probe are required before marking a quick tunnel ready.

The connector shares only the selected runtime's network namespace. It uses the
actual running port, private health metrics, dropped capabilities, a read-only
root filesystem, bounded memory and logs, and the same pinned image as phone access.
Its identity includes the full deployment UUID. Configuration and token material
never appear in the public status response; tokens are absent from command arguments.

Direct mode cancels queued work and removes the connector. Deployment deletion also
invalidates the request and removes its owned connector before removing the app.
The original local URL and actual exposure remain visible while connecting or after
a failed connection. The frontend polls pending status every 500 ms and preserves
HTTP 202 through its exposure proxy. Confirmed URL, port, and exposure are saved
together so subsequent requests and refreshes use the running app's mapping.
Runtime observation updates only container state. It returns the latest saved
exposure and URL instead of writing the values read before a concurrent tunnel
connection completed.

Named tunnels accept a token and the HTTPS origin configured in Cloudflare. Their
Cloudflare public hostname must forward to `http://127.0.0.1:<container port>` in the
runtime namespace. A connected named connector confirms the Cloudflare connection;
the application does not fetch arbitrary user-supplied domains as a readiness probe.

## Alternatives

- [ngrok](https://ngrok.com/docs/pricing-limits/free-plan-limits): one account-linked
  development domain avoids allocating a new hostname on each start. The free
  plan has traffic quotas and an HTML visitor interstitial.
- [Named Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/):
  a persistent connector with a configured hostname avoids repeated random URL
  allocation. Requires the account and hostname configuration.
- [frp](https://github.com/fatedier/frp) or
  [rathole](https://github.com/rathole-org/rathole): a persistent relay owned by
  StackPilot can route projects using existing DNS and TLS. This requires a public
  relay server and its operations. It is an architectural option, not implemented here.

None of the alternatives has been benchmarked on this connection. An instantaneous
button response is distinct from a new public route becoming reachable.
[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
are temporary development links with no uptime guarantee, a 200 in-flight request
limit, and no SSE support. They are not the production ingress architecture for
100,000 simultaneous users.

## Verification

- Seven C++ model regressions passed: actual port selection, missing mappings,
  owned connector specification, private token handling, status redaction, and UUID identity.
- Production frontend build and TypeScript passed.
- Browser fixtures passed for successful and failed connections, including confirmed
  exposure, pending polling, retry, no duplicate mutation, and Docker-specific copy.
- Real Docker, public HTTPS, restart, reuse, cancellation, and deletion qualification
  is provided by `tests/integration/project_exposure_smoke.py`.
- The full live qualification passed: the start response through the frontend
  proxy took **32 ms**, and the public fixture was ready in **13,858 ms**, including
  a backend restart. Ownership, named-hostname validation, actual-port selection,
  persisted metadata, reuse, cancellation, and deployment deletion all passed.
- The final run also passed a controlled concurrency test: an ingress update
  commits while runtime observation waits on that row. Observation preserved and
  returned the new address. Its start response was **31 ms** and public readiness
  was **41,527 ms**, including restart. Successful fresh-link measurements therefore
  ranged from roughly **14 to 42 seconds**; this is not a fixed startup guarantee.
- A separate run encountered negative DNS caching on Windows for a fresh hostname.
  The test can verify the public TLS/GET path using public DNS over HTTPS and reports
  this fallback explicitly. The final passing run used the normal Windows resolver.
- Integration verification caught a PostgreSQL parameter inference conflict when
  saving both varchar columns and JSON metadata. Explicit text casts resolved it;
  the corrected query was checked against PostgreSQL and the live test rerun.
- The healthcare project's start request returned in **98 ms**. Its saved exposure
  and runtime URL now use the confirmed public HTTPS address on internal port 8000.
  Its API rejects HEAD with 405; this is an HTTP method contract, so the final
  application check uses GET, which returned **HTTP 200** from the public Internet.
- Reconnecting the healthcare project's existing healthy connector preserved its
  public address: **40 ms** request response and **1,361 ms** to confirmed readiness.

Temporary accounts and fixture runtimes were removed after qualification. The
production backend was rebuilt after the SQL correction using its cached compiler
stage, and the updated backend and frontend are running locally.

Named account routing and ngrok require account configuration and have not been
qualified end to end in this workspace.
