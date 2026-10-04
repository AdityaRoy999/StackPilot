CREATE TABLE IF NOT EXISTS deployment_runtime_candidates (
    job_id UUID NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','promoted','cleaned','cleanup_failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(job_id,attempt,provider,resource_key)
);
CREATE INDEX IF NOT EXISTS runtime_candidates_reconcile ON deployment_runtime_candidates(status,updated_at);
