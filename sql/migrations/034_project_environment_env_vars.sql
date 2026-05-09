-- Environment-specific variables.
-- Project variables are shared defaults; environment variables override them
-- for builds targeting that environment.

CREATE TABLE IF NOT EXISTS project_environment_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id UUID NOT NULL REFERENCES project_environments(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_environment_env_vars_environment_key
    ON project_environment_env_vars(environment_id, key);

CREATE INDEX IF NOT EXISTS idx_project_environment_env_vars_environment
    ON project_environment_env_vars(environment_id);
