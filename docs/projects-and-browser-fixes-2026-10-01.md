# Projects and Live App recovery

The signed-in account's API returns `calculator`, `club website`, and `portfolio`.
All three are stored in the personal workspace. PostgreSQL contains nine total
projects including unrelated qualification fixtures. No existing project was
removed or rebuilt during this fix. The running club website at port 56331
returns HTTP 200 from the Docker browser's network.

The fresh AI page passed `default` as its browser session ID. The capability
endpoint requires a persisted UUID belonging to the requester, so it returned
HTTP 400 before the WebSocket could connect. The component swallowed that error
and kept displaying its connecting spinner.

The frontend now creates a saved chat with `POST /api/v1/ai/sessions` before
opening Live App. Viewer initialization and simultaneous message submission share
one pending creation. New Chat invalidates an old pending response. The first
message supplies the title and authorized project/deployment context. Ticket,
transport, deleted-chat, and service errors have a visible retry state.

The project page previously treated query errors as an empty project list. An
unrecognized persisted workspace could also filter the request while the sidebar
displayed All Workspaces. The provider now validates the selection against
accessible organizations. The project page fetches the complete authorized list
and filters locally, identifies the selected workspace, and offers View all
projects when that workspace is empty. Request failures display Retry and keep
any previously loaded cards.

The follow-up screenshot revealed an activation problem: HTTP requests to the
running frontend still returned old Turbopack JavaScript. The served dashboard
bundle lacked the new query key, request-error state, and workspace recovery
controls, even though the bind-mounted source contained them. Windows Docker
file notifications had missed the edits; WATCHPACK_POLLING did not apply to
Turbopack. The Docker development command now uses Webpack with a 1000 ms
Watchpack poll interval. Only the frontend container was recreated.

The actual served dashboard bundle now contains all three changes. A disposable
API route was discovered and subsequently recompiled after a source edit without
restarting the frontend: discovery took 4.36 seconds and the edit took 2.85
seconds. The fixture was removed afterward. The result is recorded in
`frontend-watch-qualification-2026-10-01.json`. Cookie-authenticated project
requests still return all three projects. The user's external browser and its
saved workspace selection remain outside the enabled browser surfaces.

Validation:

- Backend image builds; TypeScript checks pass.
- Project-page DOM tests cover stale selection recovery, empty-workspace recovery,
  and an API failure followed by Retry.
- Chat lifecycle tests cover concurrent viewer/message creation, retry after
  failure, stale response cancellation, and New Chat during initialization.
- Canvas DOM test verifies a deleted-chat error replaces the spinner and retries.
- Media, page state, peer lifecycle, and query-key tests pass.
- The final focused frontend run passed 29 tests across nine files.
- Real API creation -> authorized WebSocket -> three decoded JPEG frames passes;
  the final run received the first frame in 0.85 seconds. No model was called.
- The first-message SQL binds authorized project/deployment context and preserves
  the title on subsequent messages; verification writes were rolled back.
- Wrong-session, missing, forged, and outsider capabilities remain rejected.
- HTTP-served JavaScript is checked for the project recovery and saved-chat
  initialization changes; a successful page status alone does not verify that
  the server compiled the current source.
- Cookie authentication with the frontend Origin returns the three user projects
  and the expected CORS header. Final project/deployment totals remain 9/11.

The protocol and DOM tests do not establish visual presentation or latency in
the user's personal browser. The real-media result is saved in
`browser-new-chat-qualification-2026-09-30.json` (UTC test date).
