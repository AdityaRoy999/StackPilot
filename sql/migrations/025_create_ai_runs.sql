CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ai_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workflow_type TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'nvidia_nim',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    confidence NUMERIC(4, 3) NOT NULL DEFAULT 0,
    summary TEXT,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    request_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    trace_id TEXT,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_user_created ON ai_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_workflow_created ON ai_runs(workflow_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_trace ON ai_runs(trace_id);
