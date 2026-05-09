-- Allow multiple project environments to map to the same Git branch.
-- This supports one-branch repositories while still requiring unique
-- environment names such as development, preview, and production.

ALTER TABLE project_environments
    DROP CONSTRAINT IF EXISTS project_environments_branch_unique;

DROP INDEX IF EXISTS project_environments_branch_unique;

CREATE INDEX IF NOT EXISTS idx_project_environments_project_branch
    ON project_environments(project_id, branch);
