-- Narrow GitHub webhook de-duping to the environment and commit.
-- A single GitHub delivery can legitimately fan out to more than one StackPilot project
-- or environment when users map the same repository in multiple places.

DROP INDEX IF EXISTS idx_deployments_github_delivery;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_github_delivery
    ON deployments(github_delivery_id, environment_id, commit_sha)
    WHERE github_delivery_id <> '';
