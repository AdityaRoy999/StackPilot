CREATE TABLE IF NOT EXISTS project_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value_encrypted TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_env_vars_project_key
    ON project_env_vars(project_id, key);

CREATE INDEX IF NOT EXISTS idx_project_env_vars_project_id
    ON project_env_vars(project_id);
