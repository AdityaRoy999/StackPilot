-- Add first-class local source projects and remote host execution metadata.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS remote_connection_id UUID REFERENCES ssh_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS remote_runtime_type VARCHAR(20) NOT NULL DEFAULT 'docker';

ALTER TABLE deployments
    ADD COLUMN IF NOT EXISTS runtime_provider VARCHAR(30) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS remote_connection_id UUID REFERENCES ssh_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS remote_container_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS remote_runtime_details JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_source_type_check,
    ADD CONSTRAINT projects_source_type_check
        CHECK (source_type IN ('github', 'ssh', 'local', 'artifact'));

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_execution_mode_check,
    ADD CONSTRAINT projects_execution_mode_check
        CHECK (execution_mode IN ('local', 'remote_host'));

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_remote_runtime_type_check,
    ADD CONSTRAINT projects_remote_runtime_type_check
        CHECK (remote_runtime_type IN ('docker', 'kubernetes'));

CREATE INDEX IF NOT EXISTS idx_projects_remote_connection_id
    ON projects(remote_connection_id);

CREATE INDEX IF NOT EXISTS idx_deployments_runtime_provider
    ON deployments(runtime_provider);
