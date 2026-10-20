-- Store manifest-derived technology metadata separately from project settings.
-- No source contents, credentials, environment values or application fields.
CREATE TABLE IF NOT EXISTS project_stack_snapshots (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    source_key JSONB NOT NULL,
    stack JSONB CHECK (stack IS NULL OR jsonb_typeof(stack) = 'object'),
    inspected_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_error TEXT NOT NULL DEFAULT ''
);

-- This descriptor is deliberately limited to fields that influence detection.
-- It also guards writes from an inspection that finishes after a source edit.
CREATE OR REPLACE FUNCTION project_stack_source_key(project UUID)
RETURNS JSONB LANGUAGE SQL STABLE AS $$
    SELECT jsonb_build_object(
        'source_type', p.source_type,
        'repo_url', p.repo_url,
        'source_path', p.source_path,
        'ssh_connection_id', p.ssh_connection_id,
        'application_template_id', p.application_template_id,
        'image', CASE WHEN jsonb_typeof(p.application_config->'image')='string'
            THEN p.application_config->>'image' ELSE NULL END,
        'branch', COALESCE((SELECT e.branch FROM project_environments e
            WHERE e.project_id=p.id
            ORDER BY (e.name='production') DESC, e.created_at, e.id LIMIT 1), 'HEAD')
    ) FROM projects p WHERE p.id=project
$$;

CREATE OR REPLACE FUNCTION invalidate_project_stack_on_deployment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        UPDATE project_stack_snapshots SET invalidated_at=clock_timestamp() WHERE project_id=NEW.project_id;
    ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('queued', 'built', 'running', 'ready') THEN
        UPDATE project_stack_snapshots SET invalidated_at=clock_timestamp() WHERE project_id=NEW.project_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invalidate_project_stack_on_deployment ON deployments;
CREATE TRIGGER invalidate_project_stack_on_deployment
AFTER INSERT OR UPDATE OF status ON deployments
FOR EACH ROW EXECUTE FUNCTION invalidate_project_stack_on_deployment();
