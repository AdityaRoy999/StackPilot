CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_memory_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID REFERENCES ai_sessions(id) ON DELETE CASCADE,
    source_message_id UUID REFERENCES ai_messages(id) ON DELETE SET NULL,
    memory_type TEXT NOT NULL DEFAULT 'chat_turn',
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(384) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_memory_chunks_user_created
    ON ai_memory_chunks(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_memory_chunks_session_created
    ON ai_memory_chunks(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_memory_chunks_embedding_hnsw
    ON ai_memory_chunks USING hnsw (embedding vector_cosine_ops);
