ALTER TABLE ai_sessions
    ADD COLUMN IF NOT EXISTS memory_summary TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS memory_graph JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS last_model TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_updated
    ON ai_sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_type_updated
    ON ai_sessions(session_type, updated_at DESC);
