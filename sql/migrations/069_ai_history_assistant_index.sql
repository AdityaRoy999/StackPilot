-- Latest provider metadata is read on every chat-list refresh. Tool-heavy
-- sessions must not scan past all their tool messages to find an assistant.
CREATE INDEX IF NOT EXISTS idx_ai_messages_assistant_session_created
    ON ai_messages (session_id, created_at DESC) WHERE role = 'assistant';
