# Saved project stacks

`project_stack_snapshots` stores each project's manifest-derived stack as JSONB, with the source descriptor, inspection time, invalidation time, and most recent refresh outcome. The row belongs to the project and is deleted automatically with it. The migration is `071_project_stack_snapshots.sql`.

Normal `GET /api/v1/projects/{id}/stack` requests use the saved result. The source descriptor includes the source type, repository/folder/server, application template/image, and primary environment branch. A source or branch change makes the previous descriptor ineligible. New deployments and relevant deployment transitions invalidate the saved result for the next inspection. Snapshot writes do not change the project's `updated_at`, avoiding repeated dashboard cache invalidation.

Use **Project information → Stack → Refresh stack** to inspect current source files explicitly, including local file changes or remote commits without a deployment. The corresponding authenticated request is `GET /api/v1/projects/{id}/stack?refresh=1`. It updates the database and the card icons' shared query cache. Draft project previews are not persisted as projects.

An unavailable source or an empty, truncated inspection does not overwrite a successful snapshot. If its source descriptor still matches, the API returns the saved stack with a stale flag and a refresh warning. Failed automatic retries have a 30-second cooldown; an explicit refresh bypasses it. A late inspection cannot overwrite a newer snapshot or a snapshot for a changed source.

Only detected technology names, roles, manifest paths, and inspection metadata are stored. Repository contents, credentials, environment values, and arbitrary application configuration fields are excluded. Access checks apply before returning or refreshing snapshots. Configuration and environment details remain live reads rather than cached copies.

Run the focused browser tests with `cd frontend && npx vitest run src/components/projects/ProjectStack.test.tsx src/lib/project-stack.test.ts`. Run `python tests/integration/project_stack_persistence_smoke.py` against a local stack for database/API qualification. `STACK_CACHE_RESTART_BACKEND=1` additionally restarts the local backend to verify persistence; the test creates and cleans up only disposable accounts and projects.
