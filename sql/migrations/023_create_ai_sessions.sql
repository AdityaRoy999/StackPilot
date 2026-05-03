CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ai_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'AI session',
    session_type TEXT NOT NULL DEFAULT 'project_chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_created ON ai_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_project_created ON ai_sessions(project_id, created_at DESC);
