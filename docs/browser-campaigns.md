# Background browser campaigns

Large website tests use a durable queue rather than one multi-hour model response or open SSE connection. Start with `/test-long https://your-site.example`, or select a browser target and ask to test 100+ pages or run for four hours. Short tests keep their existing bounded execution path.

## Execution and verification

The campaign discovers same-origin routes and queues individual workflow reviews. Discovery records navigation, controls and native validation; scenario workers preserve the original goal, reacquire current element IDs and require independent outcome assertions. Page exploration, passed workflows, blocked cases and unverified cases remain separate in the report. Finishing the queue does not prove exhaustive coverage of the site.

The progress card survives chat reload through its saved tool result. It supports pause, resume, stop, pending questions, exact signed approvals, paginated results and recording playback. Closing the chat does not cancel a background job. The host, AI service, persistent state volume and selected browser worker must stay available. Manual browser input pauses the campaign before taking control; changing the sandbox requires pausing it first.

Full access and Autonomous apply to ordinary campaign tasks within the user's requested scope. Missing credentials, CAPTCHA, unavailable business facts and an unknown expected outcome remain explicit blockers. A generic audit does not authorize sending requests, making purchases or deleting data. A planner's success statement cannot replace an outcome assertion.

## Recovery

Each campaign has a renewable worker lease; each task has its own lease and fenced result commit. Completed task results and discovered routes survive service restarts. An interrupted page task can return to the queue, with bounded retries for transport exceptions. An interrupted workflow is held for reconciliation instead of automatic replay. Choose **Inspect interrupted workflow** to examine its live outcome. Any further input in that recovered workflow requires a fresh exact step review, including when Full access is enabled. Expired or changed approvals cannot execute a replacement control.

Checkpoints encrypt cookies, origin-local storage, session storage, tab URLs and dispatch evidence from the campaign's isolated browser context. They do not restore arbitrary JavaScript memory, unfinished network requests, code editor buffers or hidden site-side effects. Login sessions can still expire or be invalidated by the site. External login redirects require separate review. Relative dates stay anchored to the campaign's original reference time.

## Default limits

| Limit | Default | Upper bound |
| --- | --- | --- |
| Discovered pages | 250 | 10,000 |
| Campaign wall time, including pauses | 4 hours | 24 hours |
| Browser tool operations | 20,000 | 100,000 |
| Model-token allocation | 1,000,000 | 10,000,000 |
| Workflow tasks | 10,000 | 10,000 |
| Concurrent campaigns per service | 1 | 4 |
| Sampled recording | Every 2 seconds; 512 MB per campaign | Configured quota |
| Ended campaign retention | 7 days | Configured retention |

Each page/scenario remains bounded inside the overall campaign. Text requests can select duration and increase page discovery; the `browser_start_campaign` tool also accepts validated action/token limits. Provider requests reserve a conservative allocation before dispatch. Provider-reported usage replaces that reservation; missing usage retains the reservation. This prevents unlimited unmetered requests, but is not a precise monetary budget. Reserve accounting for images can be deliberately conservative.

Storage quotas stop recording when full while structured evidence continues. Capture also stops immediately when the campaign ends or pauses. Playback uses encrypted JPEG samples, not a continuous 60 FPS video, and does not include website audio. Old runs with no recording cannot be recovered. Retention deletes ended records; SQLite reuses freed pages in subsequent runs rather than immediately shrinking the database file.

## Storage and authentication

SQLite lives beside `STACKPILOT_AGENT_RUN_DB` on the existing `agent_run_state` volume. Payloads, provider configuration, checkpoints, events and frames use AES-GCM with a key derived from the configured internal service token. Preserve the volume and service token across restarts; changing the token without migrating encrypted state makes old campaigns unreadable. Public status, control and replay endpoints require a short-lived backend-issued browser ticket bound to the authenticated owner and chat. A revoked phone device cannot refresh that ticket. Read-only tickets cannot control campaigns.

Optional operator settings, without additional required `.env` fields:

- `STACKPILOT_BROWSER_CAMPAIGN_DB`: override the database location.
- `STACKPILOT_BROWSER_CAMPAIGN_PARALLELISM`: default `1`; capped at `4`.
- `STACKPILOT_BROWSER_CAMPAIGN_RECORDING_INTERVAL_SECONDS`: default `2`, minimum `1`.
- `STACKPILOT_BROWSER_CAMPAIGN_RECORDING_BYTES`: default `536870912` per campaign.
- `STACKPILOT_BROWSER_CAMPAIGN_RETENTION_DAYS`: default `7`, minimum `1`.

## Validation

`test_browser_campaigns.py` covers ownership, encryption, leases, worker fencing, restart-safe queues, paused questions, reconciliation, budget allocation and terminal recording behavior. The frontend suites cover remote routing, ticket refresh, pagination, progress and permission continuation.

With a test Chromium endpoint configured, enable `AI_BROWSER_LIVE_TESTS=1` and run `test_browser_campaign_live.py`. Its synthetic 120-page fixture runs without a chat connection and checks durable recording shutdown, multiline editor input and login-storage restoration. Set `AI_BROWSER_EXTERNAL_TESTS=1` only for the optional Programiz C++ smoke, which types a linked-list program and asserts its actual output. These tests do not submit forms to third-party accounts.

The fixture suite is not a four-hour real-provider soak or a guarantee for arbitrary applications. Before qualifying a particular host for multi-hour runs, run a representative campaign with its actual provider and browser worker, exercise a service interruption and verify the resumed report, memory/storage usage and held submissions. Custom widget families still need independent fixtures and observed outcome contracts.
