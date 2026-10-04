CREATE TABLE IF NOT EXISTS deployment_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_job_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('build','runtime')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retrying','healed','failed','blocked','canceled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_by TEXT,
    locked_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_id UUID REFERENCES ai_sessions(id) ON DELETE SET NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(deployment_id,source_job_id,kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS deployment_incidents_one_active
ON deployment_incidents(deployment_id) WHERE status IN ('queued','running','retrying');
CREATE INDEX IF NOT EXISTS deployment_incidents_due
ON deployment_incidents(next_run_at) WHERE status IN ('queued','retrying');
CREATE TABLE IF NOT EXISTS deployment_health_observations (
    deployment_id UUID PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
    healthy BOOLEAN NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    evidence JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
