-- Production deployment sources and environment-aware automation.

CREATE TABLE IF NOT EXISTS source_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL,
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    source_root TEXT NOT NULL DEFAULT '',
    source_kind VARCHAR(32) NOT NULL DEFAULT 'local_upload',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_artifacts_user_created
    ON source_artifacts(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_artifacts_user_sha
    ON source_artifacts(user_id, sha256);

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_source_type_check,
    ADD CONSTRAINT projects_source_type_check
        CHECK (source_type IN ('github', 'ssh', 'local', 'artifact', 'application'));

CREATE TABLE IF NOT EXISTS project_environments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    branch VARCHAR(255) NOT NULL DEFAULT '',
    auto_deploy BOOLEAN NOT NULL DEFAULT FALSE,
    require_ci BOOLEAN NOT NULL DEFAULT FALSE,
    execution_mode VARCHAR(20) NOT NULL DEFAULT 'local',
    remote_connection_id UUID REFERENCES ssh_connections(id) ON DELETE SET NULL,
    remote_runtime_type VARCHAR(20) NOT NULL DEFAULT 'kubernetes',
    remote_k8s_exposure VARCHAR(20) NOT NULL DEFAULT 'ingress',
    runtime_scheme VARCHAR(10) NOT NULL DEFAULT 'https',
    current_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT project_environments_name_unique UNIQUE(project_id, name),
    CONSTRAINT project_environments_execution_mode_check CHECK (execution_mode IN ('local', 'remote_host')),
    CONSTRAINT project_environments_remote_runtime_type_check CHECK (remote_runtime_type IN ('docker', 'kubernetes')),
    CONSTRAINT project_environments_runtime_scheme_check CHECK (runtime_scheme IN ('http', 'https'))
);

CREATE INDEX IF NOT EXISTS idx_project_environments_project
    ON project_environments(project_id);

CREATE INDEX IF NOT EXISTS idx_project_environments_project_branch
    ON project_environments(project_id, branch);

ALTER TABLE deployments
    ADD COLUMN IF NOT EXISTS environment_id UUID REFERENCES project_environments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_artifact_id UUID REFERENCES source_artifacts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS branch VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS commit_sha VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(48) NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS github_delivery_id VARCHAR(128) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS ci_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS ci_status VARCHAR(32) NOT NULL DEFAULT 'not_required',
    ADD COLUMN IF NOT EXISTS ci_details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_deployments_environment_created
    ON deployments(environment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deployments_source_artifact
    ON deployments(source_artifact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_github_delivery
    ON deployments(github_delivery_id, environment_id, commit_sha)
    WHERE github_delivery_id <> '';
