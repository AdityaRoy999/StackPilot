CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ai_run_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE,
    job_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_run_links_run ON ai_run_links(run_id);
CREATE INDEX IF NOT EXISTS idx_ai_run_links_project ON ai_run_links(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_run_links_deployment ON ai_run_links(deployment_id);

CREATE TABLE IF NOT EXISTS ai_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    provider TEXT NOT NULL DEFAULT 'nvidia_nim',
    model TEXT,
    openai_compatible_base_url TEXT,
    confidence_threshold NUMERIC(4, 3) NOT NULL DEFAULT 0.720,
    history_retention_days INTEGER NOT NULL DEFAULT 90,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ai_preferences_provider_check CHECK (provider IN ('nvidia_nim', 'openai_compatible')),
    CONSTRAINT ai_preferences_confidence_check CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1),
    CONSTRAINT ai_preferences_retention_check CHECK (history_retention_days BETWEEN 1 AND 3650)
);
