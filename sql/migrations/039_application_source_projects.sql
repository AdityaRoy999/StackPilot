-- Add generated Application catalog projects.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS application_template_id VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS application_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_source_type_check,
    ADD CONSTRAINT projects_source_type_check
        CHECK (source_type IN ('github', 'ssh', 'local', 'artifact', 'application'));
