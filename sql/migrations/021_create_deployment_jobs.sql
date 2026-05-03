CREATE TABLE IF NOT EXISTS deployment_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(48) NOT NULL DEFAULT 'deployment_build',
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    priority INTEGER NOT NULL DEFAULT 100,
    last_error TEXT DEFAULT '',
    locked_by VARCHAR(160) DEFAULT '',
    locked_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_claim
    ON deployment_jobs (status, next_run_at, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_deployment
    ON deployment_jobs (deployment_id, created_at DESC);

ALTER TABLE deployments
    ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES deployment_jobs(id) ON DELETE SET NULL;
