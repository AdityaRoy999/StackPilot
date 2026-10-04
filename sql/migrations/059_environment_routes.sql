CREATE TABLE IF NOT EXISTS environment_runtime_routes (
    environment_id UUID PRIMARY KEY REFERENCES project_environments(id) ON DELETE CASCADE,
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES deployment_jobs(id),
    upstream_url TEXT NOT NULL,
    verification JSONB NOT NULL,
    generation BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
