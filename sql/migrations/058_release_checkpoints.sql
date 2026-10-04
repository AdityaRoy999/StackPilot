CREATE TABLE IF NOT EXISTS deployment_release_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID REFERENCES project_environments(id) ON DELETE SET NULL,
    job_id UUID NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    provider TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    runtime_snapshot JSONB NOT NULL,
    runtime_config_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(job_id,attempt)
);
CREATE INDEX IF NOT EXISTS deployment_release_checkpoints_history ON deployment_release_checkpoints(project_id,environment_id,created_at DESC);
