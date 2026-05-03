CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ai_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_artifacts_run ON ai_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_type_created ON ai_artifacts(artifact_type, created_at DESC);
