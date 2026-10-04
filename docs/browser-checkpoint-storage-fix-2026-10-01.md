# Website testing checkpoint storage fix

Website testing stopped before opening the requested site. The non-root AI
service (UID 10001) attempted to write SQLite checkpoints under the development
source bind mount, `/app/app/.runtime/browser-runs.sqlite3`. The directory and
database belonged to UID 1000, so SQLite raised `attempt to write a readonly
database`. The catch-all error incorrectly described an uncertain dispatched
browser action. The original 19 runs contained no pending actions.

Development and production now use the persistent `agent_run_state` volume at
`/app/browser-state`. A one-shot initializer assigns private directory/file
permissions to UID 10001 before the service starts. Development migrates an
existing legacy journal through SQLite backup, including committed WAL data.
Existing volume data wins over legacy data. Production retains its existing
named volume at the new mount location. The AI service still runs as non-root.

Checkpoint initialization and session configuration errors now identify their
actual startup failure and say that no browser action was dispatched. Execution
interruptions still preserve uncertain actions. Readiness now requires a
writable checkpoint transaction, alongside PostgreSQL, browser, and service
authentication checks.

The update is active locally. All 19 original runs were retained; the running
service can begin and roll back a write transaction as UID 10001. Its checkpoint
file is owned by that UID with mode 0600, and `/readyz` reports all dependencies
ready.

Validation:

- All 252 executed tests in the 311-test AI suite passed; 59 opt-in tests were
  skipped. An initial harness run omitted migration fixtures; copying those
  fixtures resolved its missing-file errors without application changes.
- All 47 browser and audit checks passed with the live Chromium opt-in enabled
  (44 live fixture tests and three audit contract tests).
- The exact `test the website` prompt visited all three discovered fixture
  pages in 3.12 seconds through the real browser and persistent journal. The
  general audit used no model call, made only GET requests, and recorded its
  remaining scenarios honestly. It remains incomplete for form submissions,
  account changes, external destinations, and business assertions. Evidence:
  `browser-checkpoint-audit-qualification-2026-10-01.json`.
- A separate real Nemotron run checked a checkbox, entered an email value, and
  verified both outcomes in 14.28 seconds. Neither provider nor browser tools
  were mocked. Evidence: `browser-checkpoint-nemotron-qualification-2026-10-01.json`.
- The default `openai/gpt-oss-20b` fixture run produced invalid tool arguments
  and then hit a provider response timeout. The journal was writable, no
  uncertain action was replayed, and it remained unverified. This separate
  provider/model failure is recorded in
  `browser-checkpoint-model-qualification-2026-10-01.json`.

These checks establish recovery from the storage failure and successful bounded
browser scenarios, not universal website compatibility or model availability.
No user project or chat was removed; qualification used disposable browser tabs.
