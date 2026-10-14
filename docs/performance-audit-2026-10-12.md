# Frontend and backend performance audit — 12 October 2026

This pass removes unnecessary loading and repeated work from the dashboard,
agent, chat history, Settings, and Remote screens. Existing workflows and
stored data remain available. Measurements use local production builds and
fixture APIs; they are not an end-to-end production latency claim.

## Changes implemented

- **Route loading:** sidebar pages load on navigation or pointer/keyboard intent,
  instead of automatically prefetching every visible navigation link. Project
  and chat-history rows also avoid eager detail-page prefetching.
- **Project cards:** the project editor loads on its first click. Closed cards
  no longer download/mount the full editing flow. Its project-detail query
  remains disabled until the editor is open.
- **Account requests:** the shell shares React Query's account response with
  Settings and project pickers. Session refresh uses the query cache and pauses
  periodic refetches while the browser is hidden.
- **Settings:** SSH connections load only for the Remote Connections category.
  Provider models cache for five minutes, while explicit refresh remains available.
- **Idle refresh:** Remote uses a non-overlapping 30-second idle refresh and a
  3-second refresh during pairing or active requests. It pauses when hidden,
  aborts abandoned requests, and refreshes on return. Agent deployment polling
  runs only while its project/command chooser needs it. Chat-list idle refresh
  changes from 12 to 30 seconds; active healing retains its faster refresh.
- **Chat history:** search moves beside the top actions. Deferred filtering,
  memoized rows, and a reused date formatter reduce repeated rendering work.
  Closed saved contexts do not mount or parse Markdown; the renderer loads
  on first expansion.
- **Chat-list database query:** the two latest-assistant lookups become one
  lateral lookup. Sessions are limited to 100 before per-session aggregation.
  A partial `(session_id, created_at DESC)` index for assistant messages avoids
  scanning intervening tool messages. Owner filtering, counts, preview cleanup,
  and returned fields stay intact.
- **Backend scheduling:** chat-list database waits/aggregation run in the
  existing blocking worker pool rather than on Drogon's event-loop threads.
- **Interface:** local env files can be selected together and merged without
  discarding manual entries. Section dialogs use a 240 ms height animation;
  outgoing inert panels no longer briefly inflate the popup. Reduced motion
  skips the height animation. Missing project-stack data no longer crashes cards.

## Measured results

| Page | JS before | JS after | Reduction | Scripts before → after |
| --- | ---: | ---: | ---: | ---: |
| Projects | 2,141,426 B | 1,270,863 B | 40.7% | 44 → 22 |
| Agent | 2,181,252 B | 1,524,934 B | 30.1% | 47 → 26 |
| Chat history | 2,173,367 B | 1,040,841 B | 52.1% | 46 → 19 |
| Settings | 2,141,426 B | 1,101,025 B | 48.6% | 44 → 19 |
| Remote | 2,141,426 B | 1,100,489 B | 48.6% | 44 → 19 |

The browser measurement opens each page in a fresh 1440 × 950 context against
production builds, waits for network idle, then observes nine seconds. API
responses are fixtures. JS bytes are **decoded response-body bytes**, including
chunks prefetched during that window, not compressed network transfer sizes.
These savings reduce unnecessary fetched/parsed code; the script's `loadMs`
values are local timing observations and are not used as a latency guarantee.

Request counts in that same window:

| Work | Before | After |
| --- | ---: | ---: |
| Idle Remote: devices + access + runs | 12 | 3 |
| Settings account response | 2 | 1 |
| Settings SSH list before visiting Remote Connections | 1 | 0 |
| Idle Agent deployment list | 2 | 1 |

The chat-list SQL fixture contains 140 sessions and 140,000 messages, with tool
messages between assistant replies. Warm `EXPLAIN ANALYZE` execution measured
**94.136 ms → 49.560 ms**, a **47.4% reduction** in this fixture. Bidirectional
`EXCEPT` checks verified equal values for the 100 returned sessions. This is one
local fixture comparison, not a p95 latency or production throughput result.

Evidence: `tests/artifacts/performance-before.json`,
`performance-remote-before.json`, `performance-after.json`, and
`chat-list-benchmark.log`. Reproduce frontend observations with
`tests/integration/frontend_performance_ui.mjs`; set
`STACKPILOT_FRONTEND_URL`, `STACKPILOT_PLAYWRIGHT_MODULE`, and
`STACKPILOT_BROWSER_EXECUTABLE` for the local runtime. The SQL fixture is in
`tests/artifacts/chat-list-benchmark.sql` and must run as a complete transaction
against a database with the current schema; its temporary tables roll back.


## Qualification

- Frontend TypeScript check and production build.
- Backend production build and startup; migration index verified in PostgreSQL.
- Six unit tests for env parsing/merge and dashboard behavior.
- Project and workspace browser suites at 375, 768, 1024, and 1440 px. They cover
  multiple-file precedence, preserving manual values and invalid-import recovery,
  lazy project editing, smooth modal frames without overshoot, reduced motion,
  responsive chat search, lazy saved context, pairing, and existing cluster flows.
- Lint baseline: 63 existing errors, 121 warnings, **zero new violations**.
- Frontend health responds successfully; unauthenticated chat-list access still
  returns 401.

Browser suites mock all APIs. SQL benchmarks use temporary fixture tables in a
rolled-back transaction. No user projects, clusters, secrets, or chat records
are changed by these checks.

## Remaining profiling priorities

1. **Long active chats:** the agent page still renders message/tool/permission
   UI and imports its settings/model UI. Capture long-conversation render
   profiles before splitting further or virtualizing messages, so scrolling,
   streamed updates, focus, and tool approvals remain correct.
2. **Concurrency:** `BlockingTaskRunner` currently uses one unbounded queue for
   blocking work, and the database pool can wait for a connection. Measure queue
   wait and p95/p99 latency under concurrent AI calls before choosing separate
   executors, queue limits, or pool sizes.
3. **Real data growth:** chat lists still compute exact message counts for up to
   100 sessions. Use real query plans and request sizes to decide whether cached
   counts or cursor pagination are needed. The added partial index has storage
   and write-maintenance costs.
4. **Live monitoring:** deployment and active healing refreshes are intentionally
   faster than idle screens. Profile them with active workloads before replacing
   their refresh mechanisms with shared subscriptions or incremental responses.

Repository size, unused installed packages, and old files are not evidence of
runtime cost by themselves. No working features or data were deleted merely
because they looked like clutter. Further optimization should follow measured
CPU, network, database, and rendering costs.
