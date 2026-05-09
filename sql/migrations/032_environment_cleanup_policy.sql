-- Environment cleanup policy for branch-driven production deployments.
-- When enabled, DOKSCP keeps the previous environment deployment live until
-- the newest commit builds and deploys successfully, then retires the older
-- runtime resources and image while preserving the audit record.

ALTER TABLE project_environments
    ADD COLUMN IF NOT EXISTS cleanup_previous_on_success BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_deployments_environment_commit_created
    ON deployments(environment_id, commit_sha, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deployments_environment_status_created
    ON deployments(environment_id, status, created_at DESC);
